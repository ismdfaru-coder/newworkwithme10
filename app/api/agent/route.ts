// app/api/agent/route.ts
// CORRECT approach confirmed from Firecrawl docs:
// 
// IMPORTANT: The CLI commands like `agent-browser task "..."` or `firecrawl browser "open ..."` 
// are LOCAL CLI COMMANDS — they do NOT work via the REST API /execute endpoint!
//
// The /v2/browser/{id}/execute endpoint expects REAL PLAYWRIGHT CODE:
//   - language: "node" → await page.goto(), await page.click(), etc.
//   - language: "python" → await page.goto(), await page.click(), etc.
//
// Strategy: Use an LLM (Keyplex/Claude) to convert natural language → Playwright JS code,
// then execute that code in the browser session.

export const runtime = "nodejs";
export const maxDuration = 120;

const FC_BASE = "https://api.firecrawl.dev";
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || "fc-21c577cb2e1a48d1a850e2850aceb4b4";

async function fcPost(path: string, body: object, key: string) {
  const res = await fetch(`${FC_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function fcDelete(path: string, key: string) {
  await fetch(`${FC_BASE}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${key}` },
  });
}

// Ask LLM to convert a natural language task into Playwright JS steps
async function getPlaywrightSteps(query: string, kpKey: string): Promise<string> {
  const res = await fetch("https://api.keyplex.io/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${kpKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{
        role: "system",
        content: `You are a Playwright automation expert. Given a task, output ONLY a single JavaScript async function body (no function declaration, no imports) that uses the pre-existing "page" (Playwright Page object) to complete the task and prints the result using console.log().

Rules:
- page is already available — do NOT declare it
- Use await for all async calls
- Use page.goto(), page.fill(), page.click(), page.waitForSelector(), page.textContent() etc.
- End with console.log() of the key result found
- No markdown, no explanation, just the JS code`
      }, {
        role: "user",
        content: `Task: "${query}"\n\nOutput ONLY the Playwright JS code body.`
      }]
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function summarise(rawOutput: string, query: string, kpKey: string): Promise<string> {
  const res = await fetch("https://api.keyplex.io/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${kpKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `User asked: "${query}"\n\nBrowser output:\n${rawOutput}\n\nGive a clean, direct answer.`
      }]
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? rawOutput;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get("query") ?? "";
  const kpKey = searchParams.get("keyplex_key") ?? process.env.KEYPLEX_API_KEY ?? "";

  if (!query) {
    return new Response(JSON.stringify({ error: "Missing query" }), { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: object) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      let sessionId: string | null = null;

      try {

        // ── STEP 1: Create browser session → get liveViewUrl ─────────────
        send("step", { type: "info", desc: "Creating Firecrawl browser session..." });

        const session = await fcPost("/v2/browser", { ttl: 300, activityTtl: 120 }, FIRECRAWL_API_KEY);

        if (!session.success) throw new Error(session.error ?? "Failed to create browser session");

        sessionId = session.id;

        // Send liveViewUrl immediately — frontend renders iframe right away
        send("session", {
          sessionId:              session.id,
          liveViewUrl:            session.liveViewUrl,            // embed in <iframe>
          interactiveLiveViewUrl: session.interactiveLiveViewUrl, // open tab to control manually
        });

        send("step", { type: "success", desc: `Browser session created. Live view is ready! Session: ${session.id}` });

        // ── STEP 2: Generate Playwright code for this specific query ──────
        // The /execute endpoint needs REAL Playwright code, NOT CLI commands
        let playwrightCode = "";

        if (kpKey) {
          send("step", { type: "info", desc: "Generating Playwright automation steps for your query..." });
          playwrightCode = await getPlaywrightSteps(query, kpKey);
          
          // Clean up markdown code blocks if present
          playwrightCode = playwrightCode
            .replace(/```(?:javascript|js|typescript|ts)?\n?/gi, "")
            .replace(/```\n?/g, "")
            .trim();
          
          send("code", { code: playwrightCode });
          send("step", { type: "success", desc: "Playwright code generated. Executing in live browser..." });
        } else {
          // Fallback: hardcoded Google search if no LLM key
          playwrightCode = `
await page.goto("https://www.google.com");
await page.waitForSelector('textarea[name="q"]');
await page.fill('textarea[name="q"]', ${JSON.stringify(query)});
await page.keyboard.press("Enter");
await page.waitForSelector("#search", { timeout: 10000 });
const results = await page.$$eval("#search .g", els =>
  els.slice(0,3).map(e => ({
    title: e.querySelector("h3")?.innerText ?? "",
    url:   e.querySelector("a")?.href ?? "",
    desc:  e.querySelector(".VwiC3b")?.innerText ?? "",
  }))
);
console.log(JSON.stringify(results, null, 2));
          `.trim();
          send("step", { type: "info", desc: "No Keyplex key — using Google search fallback. Add keyplex_key for custom automation." });
          send("code", { code: playwrightCode });
        }

        // ── STEP 3: Execute Playwright code in the live browser ───────────
        // THIS IS THE KEY FIX: use language: "node" with real Playwright JS
        send("step", { type: "executing", desc: "Executing Playwright code in the live browser..." });

        const execResult = await fcPost(
          `/v2/browser/${sessionId}/execute`,
          {
            code: playwrightCode,
            language: "node",    // MUST be "node" or "python" — NOT "bash"!
          },
          FIRECRAWL_API_KEY
        );

        const rawOutput: string = execResult.result ?? execResult.output ?? JSON.stringify(execResult);

        send("rawResult", { output: rawOutput });
        send("step", { type: "success", desc: "Browser execution complete." });

        // ── STEP 4: Summarise with LLM (optional) ─────────────────────────
        if (kpKey) {
          send("step", { type: "info", desc: "Summarizing the result..." });
          const summary = await summarise(rawOutput, query, kpKey);
          send("summary", { text: summary });
        }

        send("done", { message: "All done! See the live browser panel above." });

      } catch (err: unknown) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
        if (sessionId) {
          setTimeout(() => fcDelete(`/v2/browser/${sessionId}`, FIRECRAWL_API_KEY), 300_000);
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      Connection:      "keep-alive",
    },
  });
}

// POST endpoint for more complex requests
export async function POST(req: Request) {
  const body = await req.json();
  const { query, keyplex_key } = body;

  if (!query) {
    return new Response(JSON.stringify({ error: "Missing query" }), { status: 400 });
  }

  // Redirect to GET with query params for SSE streaming
  const url = new URL(req.url);
  url.searchParams.set("query", query);
  if (keyplex_key) url.searchParams.set("keyplex_key", keyplex_key);
  
  return GET(new Request(url.toString()));
}
