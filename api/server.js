// redeploy-3 (diagnostic build)
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());             // MVP: allow all
app.use(express.json());

// ===== ENV =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const SYSTEM_PROMPT  = process.env.SYSTEM_PROMPT || "You are a helpful concierge.";

// ===== BASIC ROUTES =====
app.get("/health", (_req, res) => res.json({ ok: true, model: OPENAI_MODEL, haveApiKey: !!OPENAI_API_KEY }));
app.get("/", (_req, res) => {
  res.type("text").send(
`Somatic Signal Concierge API (diagnostic)
Health: GET  /health
Echo:   POST /echo
Chat:   POST /chat { userMessage, pageContext? }   (add ?mock=1 to force canned success)
Diag:   GET  /diag  (tests an actual OpenAI call)
Lead:   POST /leads/create { name, email, page_url? }`
  );
});

app.post("/echo", (req, res) => {
  res.json({ ok: true, headers: req.headers, body: req.body, haveApiKey: !!OPENAI_API_KEY });
});

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

// Helper to pull text from Responses API
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

// ===== NON-STREAM CHAT (with mock) =====
app.post("/chat", async (req, res) => {
  try {
    // Force success for frontend path test
    if (String(req.query.mock) === "1") {
      return res.json({ ok: true, text: "Mock reply working. Frontend ↔ backend path is good." });
    }

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
      const msg = data?.error?.message || JSON.stringify(data).slice(0, 400);
      return res.status(500).json({ error: "openai_failed", status: r.status, message: msg });
    }

    const text = extractText(data) || "I’m here—ask me anything about Somatic Signal™.";
    res.json({ ok: true, text });
  } catch (e) {
    console.error("Chat handler error:", e);
    res.status(500).json({ error: "failed", message: e.message });
  }
});

// ===== DIAGNOSTIC ENDPOINT (pings OpenAI) =====
app.get("/diag", async (_req, res) => {
  const result = { haveApiKey: !!OPENAI_API_KEY, model: OPENAI_MODEL };
  if (!OPENAI_API_KEY) return res.status(200).json({ ...result, ok: false, reason: "missing_api_key" });

  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          { role: "system", content: "You are a minimal test assistant. Reply with 'pong' only." },
          { role: "user", content: "ping" }
        ]
      })
    });
    const data = await r.json().catch(()=>({}));
    result.status = r.status;
    result.responseSnippet = JSON.stringify(data).slice(0, 400);
    if (!r.ok) return res.status(200).json({ ...result, ok: false, reason: "openai_error" });
    const txt = extractText(data);
    return res.status(200).json({ ...result, ok: true, text: txt || "(no text)" });
  } catch (e) {
    return res.status(200).json({ ...result, ok: false, reason: "exception", message: e.message });
  }
});

export default app;

