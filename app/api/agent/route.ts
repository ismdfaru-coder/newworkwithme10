// app/api/agent/route.ts
// CORRECT implementation — matches exactly what Firecrawl playground does:
// iterative agent-browser bash commands, each snapshot feeds next decision

export const runtime = "nodejs";
export const maxDuration = 300;

const FC_BASE = "https://api.firecrawl.dev";
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || "fc-21c577cb2e1a48d1a850e2850aceb4b4";

async function createSession(fcKey: string) {
  const res = await fetch(`${FC_BASE}/v2/browser`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: 300, activityTtl: 120 }),
  });
  
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to create session: ${res.status} - ${errText}`);
  }
  
  return res.json();
}

async function execCommand(sessionId: string, command: string, fcKey: string) {
  const res = await fetch(`${FC_BASE}/v2/browser/${sessionId}/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      code: command,
      language: "bash",
    }),
  });
  
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Execute failed: ${res.status} - ${errText}`);
  }
  
  return res.json();
}

async function deleteSession(sessionId: string, fcKey: string) {
  await fetch(`${FC_BASE}/v2/browser/${sessionId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${fcKey}` },
  });
}

// Ask Keyplex what the NEXT single command should be, given the current snapshot
async function getNextCommand(
  task: string,
  history: { cmd: string; result: string }[],
  kpKey: string
): Promise<{ cmd: string; done: boolean; reason: string }> {
  
  // Build history, but only show LAST snapshot in full (most relevant)
  const historyText = history
    .map((h, i) => {
      const isLast = i === history.length - 1;
      const resultText = isLast ? h.result.slice(0, 4000) : h.result.slice(0, 500);
      return `Step ${i + 1}:\nCommand: ${h.cmd}\nResult:\n${resultText}`;
    })
    .join("\n\n");

  const requestBody = {
    model: "openai/gpt-4o-mini",
    max_tokens: 800,
    messages: [
      {
        role: "system",
        content: `You are a browser automation agent. You control a headless browser using agent-browser commands.

AVAILABLE COMMANDS:
- agent-browser open <URL>           → Opens a webpage
- agent-browser snapshot -i          → Returns list of page elements with [ref=eNN] identifiers
- agent-browser click @eNN           → Clicks element with that ref (e.g., @e5, @e16)
- agent-browser fill @eNN "text"     → Types text into input field with that ref

CRITICAL RULES:
1. After "open" or "click", ALWAYS run "snapshot -i" next to see updated page
2. The refs like @e5, @e16 come from the LATEST snapshot output - use ONLY those exact refs
3. Look at the snapshot result carefully - it shows elements like: button "Search" [ref=e21]
4. To click that button, use: agent-browser click @e21
5. NEVER use @REF literally - always use actual ref numbers from the snapshot

OUTPUT FORMAT (JSON only, no markdown):
{ "cmd": "agent-browser ...", "done": false, "reason": "brief explanation" }

When task is complete:
{ "cmd": "", "done": true, "reason": "Here is the answer: ..." }`
      },
      {
        role: "user",
        content: `TASK: ${task}

Build a browsing sequence for this task so that a headless browser can complete it using agent-browser commands.

${historyText ? `HISTORY:\n${historyText}\n\nBased on the LATEST snapshot result above, what is the NEXT command? Use the exact @eNN refs shown.` : "This is the first step. Start by opening the relevant URL."}`
      }
    ],
  };

  const res = await fetch("https://keyplex.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { 
      "Authorization": `Bearer ${kpKey}`, 
      "Content-Type": "application/json" 
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Keyplex API error: ${res.status} - ${errText}`);
  }

  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content ?? "{}").replace(/```json|```/g, "").trim();
  
  try {
    return JSON.parse(text);
  } catch {
    return { cmd: "", done: true, reason: "Failed to parse LLM response: " + text };
  }
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
        // ── 1. Create browser session ─────────────────────────────
        send("step", { type: "info", desc: "Creating browser session..." });

        const session = await createSession(FIRECRAWL_API_KEY);
        
        // Firecrawl returns { success: true, id: "...", liveViewUrl: "..." } on success
        // OR { success: false, error: "..." } on failure
        // OR just { id: "...", liveViewUrl: "..." } without success field
        if (session.success === false) {
          throw new Error(session.error ?? "Failed to create session");
        }
        
        if (!session.id || !session.liveViewUrl) {
          throw new Error("Invalid session response: missing id or liveViewUrl");
        }

        sessionId = session.id;

        // Send liveViewUrl immediately so iframe appears in UI
        send("session", {
          sessionId:              session.id,
          liveViewUrl:            session.liveViewUrl,
          interactiveLiveViewUrl: session.interactiveLiveViewUrl,
        });

        send("step", { type: "success", desc: `Session created. ID: ${session.id}` });

        // ── 2. Iterative command loop ──────────────────────────────
        // Each iteration: LLM decides next command -> execute -> feed result back
        // This is exactly how the Firecrawl playground works

        const history: { cmd: string; result: string }[] = [];
        const MAX_STEPS = 20;

        if (!kpKey) {
          // No LLM key — run a hardcoded demo for flight search
          send("step", { type: "info", desc: "No Keyplex key provided — running demo flight search commands" });

          const demoCmds = [
            `agent-browser open https://www.google.com/travel/flights`,
            `agent-browser snapshot -i`,
            `agent-browser fill @e16 "Chennai"`,
            `agent-browser snapshot -i`,
            `agent-browser click @e5`,
            `agent-browser fill @e18 "Manchester"`,
            `agent-browser snapshot -i`,
            `agent-browser click @e5`,
            `agent-browser click @e19`,
            `agent-browser snapshot -i`,
            `agent-browser fill @e1 "05-20-2026"`,
            `agent-browser fill @e2 "06-01-2026"`,
            `agent-browser click @e336`,
            `agent-browser snapshot -i`,
            `agent-browser click @e21`,
            `agent-browser snapshot -i`,
          ];

          for (let i = 0; i < demoCmds.length; i++) {
            const cmd = demoCmds[i];
            send("command", { index: i, total: demoCmds.length, cmd, reason: "demo step" });

            const result = await execCommand(sessionId, cmd, FIRECRAWL_API_KEY);
            const output = result.stdout || result.output || result.result || JSON.stringify(result);
            const hasError = result.stderr && result.stderr.includes("✗");

            send("result", { index: i, cmd, output: output.slice(0, 500), success: !hasError });
            history.push({ cmd, result: output });

            await new Promise(r => setTimeout(r, 800));
          }

        } else {
          // LLM-driven loop — Keyplex decides each next command
          send("step", { type: "info", desc: "Keyplex is driving the browser step by step..." });

          for (let step = 0; step < MAX_STEPS; step++) {
            // Ask Keyplex what to do next
            const { cmd, done, reason } = await getNextCommand(query, history, kpKey);

            if (done || !cmd) {
              send("step", { type: "success", desc: `Completed: ${reason}` });
              send("summary", { text: reason });
              break;
            }

            send("command", { index: step, total: MAX_STEPS, cmd, reason });

            // Execute the command in the live browser
            const result = await execCommand(sessionId, cmd, FIRECRAWL_API_KEY);
            // stdout contains the snapshot data with refs, result/output may be empty
            const output = result.stdout || result.output || result.result || JSON.stringify(result);
            const hasError = result.stderr && result.stderr.includes("✗");

            send("result", { index: step, cmd, output: output.slice(0, 800), success: !hasError });

            // Feed result back into history for next decision - include stderr too for error context
            const fullResult = hasError ? `ERROR: ${result.stderr}\n${output}` : output;
            history.push({ cmd, result: fullResult });

            await new Promise(r => setTimeout(r, 600));
          }
        }

        send("done", { message: "Agent finished. See live browser panel above." });

      } catch (err: unknown) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
        if (sessionId) {
          setTimeout(() => deleteSession(sessionId!, FIRECRAWL_API_KEY), 300_000);
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

  const url = new URL(req.url);
  url.searchParams.set("query", query);
  if (keyplex_key) url.searchParams.set("keyplex_key", keyplex_key);
  
  return GET(new Request(url.toString()));
}
