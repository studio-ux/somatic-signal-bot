// somatic-signal concierge - secure backend
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());              // MVP: allow all (you can restrict to your domain later)
app.use(express.json());

/* ===== ENV ===== */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const SYSTEM_PROMPT  = process.env.SYSTEM_PROMPT || buildSystemPrompt();

const FLODESK_API_KEY     = process.env.FLODESK_API_KEY || "";     // NEVER put this in the browser
const FLODESK_SEGMENT_ID  = process.env.FLODESK_SEGMENT_ID || "";  // e.g. "seg_xxx"

/* ===== Health ===== */
app.get("/health", (_req, res) => res.json({
  ok: true,
  haveOpenAI: !!OPENAI_API_KEY,
  haveFlodesk: !!FLODESK_API_KEY && !!FLODESK_SEGMENT_ID,
  model: OPENAI_MODEL
}));

/* ===== Friendly Index ===== */
app.get("/", (_req, res) => {
  res.type("text").send(
`Somatic Signal Concierge API
GET  /health
POST /chat           -> { userMessage, pageContext? } -> { ok, text }
POST /lead           -> { name, email, tags?, page_url? } -> { ok }
`
  );
});

/* ===== CHAT (Non-streaming, robust) ===== */
app.post("/chat", async (req, res) => {
  try {
    const { userMessage = "", pageContext = "" } = req.body || {};
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: composeUserContent(userMessage, pageContext) }
    ];

    // if no key, return high-quality local answer (keeps UX alive)
    if (!OPENAI_API_KEY) {
      const text = localAnswer(userMessage);
      return res.json({ ok: true, text });
    }

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: OPENAI_MODEL, input: messages })
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("OpenAI error:", r.status, data);
      const text = localAnswer(userMessage);
      return res.json({ ok: true, text });
    }

    const text = extractText(data) || localAnswer(userMessage);
    res.json({ ok: true, text });
  } catch (e) {
    console.error("Chat failed:", e);
    res.json({ ok: true, text: localAnswer(req.body?.userMessage || "") });
  }
});

/* ===== LEAD -> Flodesk (secure) ===== */
app.post("/lead", async (req, res) => {
  try {
    const { name = "", email = "", tags = [], page_url = "" } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: "email_required" });

    // Always log internally for backup
    console.log("LEAD", { name, email, tags, page_url, ts: new Date().toISOString() });

    // If Flodesk creds missing, still return ok so UX is smooth
    if (!FLODESK_API_KEY || !FLODESK_SEGMENT_ID) {
      return res.json({ ok: true, stored: "logs_only" });
    }

    // Flodesk API note:
    // Do not expose the API key client-side. Calls must come from this server.
    // Official Flodesk docs show creating/upserting subscriber then attaching to segment.
    // Endpoints (typical pattern) — adjust if your account uses updated routes:
    // 1) POST /v1/subscribers
    // 2) POST /v1/segments/{segmentId}/subscribers
    // Authorization header varies by account (Bearer or Basic). Many accounts now use:
    //   Authorization: Bearer {FLODESK_API_KEY}
    // If your workspace uses Basic, change the header below accordingly.

    // Create/Update subscriber
    const subRes = await fetch("https://api.flodesk.com/v1/subscribers", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${FLODESK_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email,
        first_name: name || undefined,
        status: "active"
      })
    });

    const subData = await subRes.json().catch(() => ({}));
    if (!subRes.ok) {
      console.error("Flodesk subscriber error:", subRes.status, subData);
      // Still reply ok so form UX doesn’t break; you’ll see the error in logs
      return res.json({ ok: true, stored: "logs_only", flodesk_error: true });
    }

    const subscriberId = subData?.id;
    // Attach to segment if we got an id
    if (subscriberId) {
      const segRes = await fetch(`https://api.flodesk.com/v1/segments/${FLODESK_SEGMENT_ID}/subscribers`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${FLODESK_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ subscriber_id: subscriberId })
      });
      if (!segRes.ok) {
        const segData = await segRes.json().catch(() => ({}));
        console.error("Flodesk segment attach error:", segRes.status, segData);
      }
    }

    res.json({ ok: true, subscriberId: subscriberId || null });
  } catch (e) {
    console.error("Lead failed:", e);
    res.json({ ok: true, stored: "logs_only" });
  }
});

/* ===== Helpers ===== */
function composeUserContent(userMessage, pageContext) {
  const trimmed = (userMessage || "").trim();
  const pc = pageContext ? `\n\n[Page]\n${pageContext}` : "";
  return trimmed + pc;
}

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

function localAnswer(q) {
  // Fast on-brand fallback (guardrailed)
  const s = (q || "").toLowerCase();
  if (/commission/.test(s)) {
    return "Commissions begin with a short consult to map story, space, and mood. Typical timelines run 6–10 weeks depending on scale. Share your name + best email and I’ll follow up with times.";
  }
  if (/scent|box/.test(s)) {
    return "Collector Boxes pair a pigment print with a numbered scent accord and a short sonic layer. They’re staged to shift with time and attention. Want pricing + availability?";
  }
  if (/price|cost/.test(s)) {
    return "I can share ranges and next steps. Exact quotes depend on scale, materials, and installation. If you share your email, I’ll send a short options sheet.";
  }
  if (/ar\b|augmented/.test(s)) {
    return "Select works include an AR layer—subtle motion + sound designed to sit quietly in space. It’s optional for commissions. Happy to share examples on a call.";
  }
  return "Happy to help. Ask about Commissions, Collector Boxes, timelines, or the AR layer. If you’d like me to follow up, share your name + best email.";
}

function buildSystemPrompt() {
  return `
You are the Somatic Signal™ concierge for jeremymorton.art.
Tone: warm, precise, art-forward, concise (<= 170 words unless asked).
Primary goals:
1) Explain Somatic Signal™ (painting + scent + sound + optional AR) in clear language.
2) Guide visitors to: (a) Studio Commissions, (b) Collector Boxes, (c) Patron paths.
3) If user shows buying intent, ask for name + best email, then call POST /lead with {name,email,page_url}.

Guardrails:
- Do NOT make medical/therapeutic claims.
- If pricing requested and not explicit on site, give ranges only and invite a short call.
- Be transparent when uncertain; prefer linking to About/Contact.
- Never ask for sensitive data. Email + first name only.
- Refuse political/explicit/unsafe topics; keep focus on the work.

House style:
- One short paragraph + an offer (tour, options, quick call).
- Use compact headings only if asked for deep dives.
- If user asks 'who are you / Jeremy?', give a crisp bio line and point to About.
`;
}

export default app;

