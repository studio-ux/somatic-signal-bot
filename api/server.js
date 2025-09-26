import express from "express";
import cors from "cors";

const app = express();
app.use(cors());          // after testing, lock to your domains
app.use(express.json());

// ENV
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const SYSTEM_PROMPT  = process.env.SYSTEM_PROMPT || "You are a helpful concierge.";

// in-memory sessions
const sessions = new Map(); // sessionId -> [{role, content}]
function getSession(req) {
  let sid = req.headers["x-session-id"];
  if (!sid) sid = Math.random().toString(36).slice(2);
  if (!sessions.has(sid)) sessions.set(sid, [{ role: "system", content: SYSTEM_PROMPT }]);
  return { id: sid, messages: sessions.get(sid) };
}

// lead capture (log-only MVP)
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

// chat streaming via OpenAI Responses API
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
      const err = await r.text();
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
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.output_text || json.delta || "";
          if (delta) {
            assistantText += delta;
            res.write(`event: token\ndata: ${JSON.stringify({ token: delta })}\n\n`);
          }
        } catch {/* keepalive */}
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

app.get("/health", (_req, res) => res.json({ ok: true }));
export default app;
