// redeploy-2
import express from "express";
import cors from "cors";

const app = express();

/** ---------- CORS (MVP: allow all; tighten later) ---------- **/
app.use(cors());
app.use(express.json());

/** ---------- ENV ---------- **/
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const SYSTEM_PROMPT  = process.env.SYSTEM_PROMPT || "You are a helpful concierge.";

/** ---------- Session (MVP) ---------- **/
const sessions = new Map();
function getSession(req) {
  let sid = req.headers["x-session-id"];
  if (!sid) sid = Math.random().toString(36).slice(2);
  if (!sessions.has(sid)) sessions.set(sid, [{ role: "system", content: SYSTEM_PROMPT }]);
  return { id: sid, messages: sessions.get(sid) };
}

/** ---------- Helpers ---------- **/
function extractText(respJson){
  if (!respJson) return "";
  if (typeof respJson.output_text === "string" && respJson.output_text.trim()) return respJson.output_text;
  if (Array.isArray(respJson.output)) {
    for (const o of respJson.output) {
      if (Array.isArray(o?.content)) {
        for (const c of o.content) {
          const t = c?.text?.value || c?.text || c?.value;
          if (typeof t === "string" && t.trim()) return t;
        }
      }
      const t2 = o?.text || o?.output_text;
      if (typeof t2 === "string" && t2.trim()) return t2;
    }
  }
  return "";
}

/** ---------- Routes ---------- **/
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

// Log-only lead capture
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

// Non-streaming fallback (always returns a complete message or clear error)
app.post("/chat", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "missing_api_key" });
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

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("OpenAI /chat error:", r.status, data);
      return res.status(500).json({ error: "openai_failed", status: r.status, detail: data });
    }
    const text = extractText(data) || "I’m here—ask me anything about Somatic Signal™.";
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed" });
  }
});

// Streaming with explicit "error" events and graceful end
app.post("/chat/stream", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      res.writeHead(200, { "Content-Type":"text/event-stream", "Cache-Control":"no-cache", "Connection":"keep-alive", "Access-Control-Allow-Origin":"*" });
      res.write(`event: error\ndata: ${JSON.stringify({ error: "missing_api_key" })}\n\n`);
      return res.end();
    }

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
      body: JSON.stringify({ model: OPENAI_MODEL, input: messages, stream: true })
    });

    if (!r.ok || !r.body) {
      const errText = await r.text().catch(() => "unknown");
      console.error("OpenAI stream start failed:", r.status, errText);
      res.write(`event: error\ndata: ${JSON.stringify({ error: errText, status: r.status })}\n\n`);
      return res.end();
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let assistantText = "";
    let sawAnyToken = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });

      for (const block of chunk.split("\n\n")) {
        const line = block.trim();
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        try {
          const evt = JSON.parse(payload);
          const delta = evt?.delta || evt?.output_text || evt?.text || "";
          if (delta) {
            sawAnyToken = true;
            assistantText += delta;
            res.write(`event: token\ndata: ${JSON.stringify({ token: delta })}\n\n`);
          }
        } catch {
          // ignore keepalives
        }
      }
    }

    if (!sawAnyToken) {
      // Tell the client it's an error so it can fallback
      res.write(`event: error\ndata: ${JSON.stringify({ error: "no_tokens_streamed" })}\n\n`);
    } else {
      messages.push({ role: "assistant", content: assistantText.trim() });
      res.write(`event: done\ndata: ${JSON.stringify({ done: true, sessionId: id })}\n\n`);
    }
    res.end();
  } catch (e) {
    console.error("Stream handler error:", e);
    res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

export default app;
