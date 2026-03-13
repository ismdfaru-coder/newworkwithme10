// app/api/agent/route.ts
// CORRECT implementation — matches exactly what Firecrawl playground does:
// iterative agent-browser bash commands, each snapshot feeds next decision

export const runtime = "nodejs";
export const maxDuration = 300;

const FC_BASE = "https://api.firecrawl.dev";
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || "fc-21c577cb2e1a48d1a850e2850aceb4b4";

async function createSession(fcKey: string) {
  console.log("[v0] createSession called with key:", fcKey ? fcKey.slice(0, 10) + "..." : "NONE");
  
  const res = await fetch(`${FC_BASE}/v2/browser`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: 300, activityTtl: 120 }),
  });
  
  console.log("[v0] createSession response status:", res.status);
  
  if (!res.ok) {
    const errText = await res.text();
    console.log("[v0] createSession error:", errText);
    throw new Error(`Failed to create session: ${res.status} - ${errText}`);
  }
  
  const data = await res.json();
  console.log("[v0] createSession success:", data.id, data.liveViewUrl?.slice(0, 50));
  return data;
}

async function execCommand(sessionId: string, command: string, fcKey: string) {
  console.log("[v0] execCommand:", command.slice(0, 80));
  
  const res = await fetch(`${FC_BASE}/v2/browser/${sessionId}/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      code: command,      // e.g. "agent-browser open https://..."
      language: "bash",   // THIS is the key — bash, not node
    }),
  });
  
  console.log("[v0] execCommand response status:", res.status);
  
  if (!res.ok) {
    const errText = await res.text();
    console.log("[v0] execCommand error:", errText);
    throw new Error(`Execute failed: ${res.status} - ${errText}`);
  }
  
  const data = await res.json();
  console.log("[v0] execCommand result:", JSON.stringify(data).slice(0, 200));
  return data;
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
  const historyText = history
    .map((h, i) => `Step ${i + 1}:\nCommand: ${h.cmd}\nResult:\n${h.result}`)
    .join("\n\n");

  const res = await fetch("https://api.keyplex.io/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${kpKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content: `You control a browser using agent-browser bash commands. 
Your job: decide the NEXT single command to run to complete the user's task.

Available commands:
- agent-browser open <URL>
- agent-browser snapshot -i        (reads page elements as refs like [ref=e1], [ref=e2])
- agent-browser fill @REF "value"  (type into input — use ref from latest snapshot)
- agent-browser click @REF         (click element — use ref from latest snapshot)

Rules:
- After EVERY open or click, always run snapshot -i next to read updated page state
- ONLY use @refs that appeared in the LATEST snapshot result
- For Google Flights: open it -> snapshot -> fill origin -> snapshot -> click airport suggestion -> fill dest -> snapshot -> click suggestion -> click date field -> snapshot -> click departure date -> click return date -> click Done -> snapshot -> click Search -> snapshot
- Output ONLY valid JSON: { "cmd": "agent-browser ...", "done": false, "reason": "why this step" }
- When you have the final answer from the last snapshot, output: { "cmd": "", "done": true, "reason": "answer: ..." }
- Maximum 20 steps total`
        },
        {
          role: "user",
          content: `Task: "${task}"\n\nHistory so far:\n${historyText || "(none — this is the first step)"}\n\nWhat is the next command?`
        }
      ],
    }),
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
  console.log("[v0] GET /api/agent called");
  
  const { searchParams } = new URL(req.url);
  const query = searchParams.get("query") ?? "";
  const kpKey = searchParams.get("keyplex_key") ?? process.env.KEYPLEX_API_KEY ?? "";

  console.log("[v0] Query:", query.slice(0, 50));
  console.log("[v0] Keyplex key present:", !!kpKey);
  console.log("[v0] Firecrawl key present:", !!FIRECRAWL_API_KEY);

  if (!query) {
    return new Response(JSON.stringify({ error: "Missing query" }), { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: object) => {
        console.log("[v0] SSE send:", event, JSON.stringify(data).slice(0, 100));
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      let sessionId: string | null = null;

      try {
        // ── 1. Create browser session ─────────────────────────────
        send("step", { type: "info", desc: "Creating browser session..." });

        const session = await createSession(FIRECRAWL_API_KEY);
        console.log("[v0] Session response:", JSON.stringify(session).slice(0, 300));
        
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
        console.log("[v0] Session ID set:", sessionId);

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
            const output = result.output ?? result.result ?? JSON.stringify(result);

            send("result", { index: i, cmd, output: output.slice(0, 500), success: !result.error });
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
            const output = result.output ?? result.result ?? JSON.stringify(result);

            send("result", { index: step, cmd, output: output.slice(0, 800), success: !result.error });

            // Feed result back into history for next decision
            history.push({ cmd, result: output });

            await new Promise(r => setTimeout(r, 600));
          }
        }

        send("done", { message: "Agent finished. See live browser panel above." });

      } catch (err: unknown) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        console.log("[v0] Stream closing, sessionId:", sessionId);
        controller.close();
        if (sessionId) {
          console.log("[v0] Scheduling session cleanup in 5 minutes:", sessionId);
          setTimeout(() => {
            console.log("[v0] Closing session:", sessionId);
            deleteSession(sessionId!, FIRECRAWL_API_KEY);
          }, 300_000);
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
