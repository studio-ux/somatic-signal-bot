// redeploy-1

import express from "express";
import cors from "cors";

const app = express();

/** ---------------- CORS (allow your domains) ---------------- **/
app.use(cors({
  origin: [
    "https://jeremymorton.art",
    "https://www.jeremymorton.art",
    "https://jeremymorton.webflow.io"
  ],
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","x-session-id"]
}));

app.use(express.json());

/** ---------------- ENV ---------------- **/
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const SYSTEM_PROMPT  = process.env.SYSTEM_PROMPT || "You are a helpful concierge.";

/** ---------------- In-memory session (ok for MVP) ---------------- **/
const sessions = new Map(); // sessionId -> [{role, content}]
function getSession(req) {
  let sid = req.headers["x-session-id"];
  if (!sid) sid = Math.random().toString(36).slice(2);
  if (!sessions.has(sid)) sessions.set(sid, [{ role: "system", content: SYSTEM_PROMPT }]);
  return { id: sid, messages: sessions.get(sid) };
}

/** ---------------- Health & Friendly Root ---------------- **/
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => {
  res.type("text").send(
`Somatic Signal Concierge API is running.
Health: /health
Chat (POST SSE): /chat/stream
Chat (POST JSON): /chat
Lead capture (POST): /leads/create`
  );
});

/** ---------------- Lead capture (logs-only MVP) ---------------- **/
app.post("/leads/create", async (req, res) => {
  try {
    const { name = "", email = "", tags = [], page_url = "" } = req.body || {};
    if (!email) return res.status(400).json({ error: "email required" });
    console.log("NEW LEAD:", { name, email, tags, page_url, ts: new Date().toISOString() });
    res.json({ ok: true, stored: "vercel-logs" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed" });
  }
});

/** ---------------- Non-streaming JSON endpoint (reliable fallback) ---------------- **/
app.post("/chat", async (req, res) => {
  try {
    const { userMessage = "", pageContext = "" } = req.body || {};
    const input = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage + (pageContext ? `\n\n[PageContext]\n${pageContext}` : "") }
    ];

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: OPENAI_MODEL, input })
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("OpenAI /chat error:", data);
      return res.status(500).json({ error: "openai_failed", detail: data });
    }

    const text = data.output_text || ""; // Responses API returns joined text here
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed" });
  }
});

/** ---------------- Streaming SSE endpoint (nice UI typing) ---------------- **/
app.post("/chat/stream", async (req, res) => {
  try {
    const { id, messages } = getSession(req);
    const { userMessage, pageContext = "" } = req.body || {};

    if (userMessage?.trim()) {
      messages.push({
        role: "user",
        content: userMessage + (pageContext ? `\n\n[PageContext]\n${pageContext}` : "")
      });
    }

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: messages,
        stream: true
      })
    });

    if (!r.ok || !r.body) {
      const err = await r.text().catch(() => "unknown");
      res.write(`event: error\ndata: ${JSON.stringify({ error: err })}\n\n`);
      return res.end();
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let assistantText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });

      // The stream arrives as blocks "data: {...}\n\n"
      for (const block of chunk.split("\n\n")) {
        const line = block.trim();
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        try {
          const evt = JSON.parse(payload);

          // Try all plausible text fields emitted by the Responses stream
          const delta = evt.delta || evt.output_text || evt.text || "";
          if (delta) {
            assistantText += delta;
            res.write(`event: token\ndata: ${JSON.stringify({ token: delta })}\n\n`);
          }
        } catch {
          // keepalive / non-JSON — ignore
        }
      }
    }

    if (assistantText.trim()) {
      messages.push({ role: "assistant", content: assistantText.trim() });
    }

    res.write(`event: done\ndata: ${JSON.stringify({ done: true, sessionId: id })}\n\n`);
    res.end();
  } catch (e) {
    console.error(e);
    res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

export default app;
