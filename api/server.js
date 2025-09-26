// api/server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

// === ENVIRONMENT VARS (from Vercel dashboard) ===
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const OPENAI_MODEL     = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const SYSTEM_PROMPT    = process.env.SYSTEM_PROMPT || "You are the Somatic Signal Concierge.";
const FLODESK_API_KEY  = process.env.FLODESK_API_KEY;
const FLODESK_SEGMENT_ID = process.env.FLODESK_SEGMENT_ID;

// === HEALTH CHECK ===
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// === CHAT ROUTE ===
app.post("/chat", async (req, res) => {
  try {
    const { userMessage = "", pageContext = "" } = req.body || {};
    if (!userMessage) return res.status(400).json({ error: "missing_message" });

    const prompt = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Page: ${pageContext}\nMessage: ${userMessage}` }
    ];

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: prompt,
        temperature: 0.6,
        max_tokens: 500
      })
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("OpenAI error:", data);
      return res.status(500).json({ error: "openai_error", data });
    }

    const text = data.choices?.[0]?.message?.content?.trim() || "…";
    res.json({ ok: true, text });
  } catch (e) {
    console.error("CHAT exception:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// === LEAD CAPTURE ROUTE (Flodesk with Bearer→Basic fallback) ===
app.post("/lead", async (req, res) => {
  const { name = "", email = "", tags = [], page_url = "" } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: "email_required" });

  const haveCreds = !!FLODESK_API_KEY && !!FLODESK_SEGMENT_ID;
  const result = { ok: false, stored: "none", haveCreds, email, segment: FLODESK_SEGMENT_ID };

  console.log("LEAD", { name, email, tags, page_url, ts: new Date().toISOString() });

  if (!haveCreds) {
    result.ok = true;
    result.stored = "logs_only";
    return res.json(result);
  }

  // === Helpers ===
  const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
  const headersBearer = () => ({
    "Authorization": `Bearer ${FLODESK_API_KEY}`,
    "Content-Type": "application/json"
  });
  const headersBasic = () => ({
    "Authorization": `Basic ${b64(`${FLODESK_API_KEY}:`)}`,
    "Content-Type": "application/json"
  });

  async function flodeskFetch(url, options, useBasic = false) {
    const headers = useBasic ? headersBasic() : headersBearer();
    const r = await fetch(url, { ...options, headers });
    const text = await r.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    return { r, json };
  }

  async function createOrGetSubscriber(useBasic = false) {
    // 1. Try create
    const create = await flodeskFetch("https://api.flodesk.com/v1/subscribers", {
      method: "POST",
      body: JSON.stringify({
        email,
        first_name: name || undefined,
        status: "active"
      })
    }, useBasic);

    if (create.r.ok && (create.json?.id || create.json?.data?.id)) {
      return { id: create.json.id || create.json.data.id, created: true };
    }

    // 2. If already exists → try lookup
    if ([400, 404, 409, 422].includes(create.r.status)) {
      const find = await flodeskFetch(
        `https://api.flodesk.com/v1/subscribers?email=${encodeURIComponent(email)}`,
        { method: "GET" },
        useBasic
      );
      if (find.r.ok) {
        const item = (Array.isArray(find.json?.data) ? find.json.data[0] :
                      Array.isArray(find.json) ? find.json[0] : null);
        if (item?.id) return { id: item.id, created: false };
      }
      return { id: null, created: false, noLookup: true };
    }

    return { error: true, status: create.r.status, data: create.json };
  }

  async function attachToSegment(subscriberId, useBasic = false) {
    // Try subscriber_id first
    if (subscriberId) {
      const attach = await flodeskFetch(
        `https://api.flodesk.com/v1/segments/${FLODESK_SEGMENT_ID}/subscribers`,
        { method: "POST", body: JSON.stringify({ subscriber_id: subscriberId }) },
        useBasic
      );
      if (attach.r.ok) return { ok: true, via: "id" };
    }

    // Fallback: by email
    const attachByEmail = await flodeskFetch(
      `https://api.flodesk.com/v1/segments/${FLODESK_SEGMENT_ID}/subscribers`,
      { method: "POST", body: JSON.stringify({ email }) },
      useBasic
    );
    if (attachByEmail.r.ok) return { ok: true, via: "email" };

    return { ok: false, status: attachByEmail.r.status, data: attachByEmail.json };
  }

  // === Attempt with Bearer first ===
  let sub = await createOrGetSubscriber(false);
  let via = "bearer";

  const authFail = (x) => x?.error && (x.status === 401 || x.status === 403);
  if (sub?.error && authFail(sub)) {
    sub = await createOrGetSubscriber(true);
    via = "basic";
  }

  if (sub?.error) {
    console.error("Flodesk subscriber fail:", via, sub.status, sub.data);
    result.ok = true;
    result.stored = "logs_only";
    result.flodesk_error = { stage: "subscriber", auth: via, status: sub.status };
    return res.json(result);
  }

  const attach = await attachToSegment(sub.id, via === "basic");
  if (!attach.ok) {
    console.error("Flodesk attach fail:", via, attach.status, attach.data);
    result.ok = true;
    result.stored = "logs_only";
    result.flodesk_error = { stage: "segment", auth: via, status: attach.status };
    return res.json(result);
  }

  result.ok = true;
  result.stored = "flodesk";
  result.subscriberId = sub.id || null;
  result.auth = via;
  result.attach_via = attach.via;
  return res.json(result);
});

// === START (Vercel provides PORT) ===
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Somatic Signal Concierge API running on ${port}`));
