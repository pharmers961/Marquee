// Marquee backend proxy — keeps API keys server-side so live events work
// for every visitor without exposing any secret in the page.
//
// Set these in Netlify → Site settings → Environment variables:
//   TICKETMASTER_KEY   (Consumer Key from developer.ticketmaster.com — free)
//   GEMINI_API_KEY     (from aistudio.google.com — free tier; powers venue-website search)
//   ANTHROPIC_API_KEY  (optional fallback for web search if you prefer Claude)
//   GEMINI_MODEL       (optional, defaults to gemini-2.0-flash)

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return resp(400, { error: "Invalid JSON" }); }

  try {
    // --- Ticketmaster Discovery API (real events + real ticket pages) ---
    if (body.action === "ticketmaster") {
      const key = process.env.TICKETMASTER_KEY;
      if (!key) return resp(500, { error: "TICKETMASTER_KEY not set" });
      const params = new URLSearchParams({ apikey: key, ...(body.params || {}) });
      const r = await fetch("https://app.ticketmaster.com/discovery/v2/events.json?" + params.toString());
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return resp(r.status, { error: (data.fault && data.fault.faultstring) || ("HTTP " + r.status) });
      return resp(200, data); // passthrough; the front end maps it
    }

    // --- Web search for venue websites (Gemini free tier preferred, Claude optional) ---
    if (!body.prompt) return resp(400, { error: "Missing prompt" });
    if (process.env.GEMINI_API_KEY) return resp(200, { text: await geminiSearch(body.prompt) });
    if (process.env.ANTHROPIC_API_KEY) return resp(200, { text: await claudeSearch(body.prompt) });
    return resp(500, { error: "No web-search key set (GEMINI_API_KEY or ANTHROPIC_API_KEY)" });
  } catch (e) {
    return resp(502, { error: String((e && e.message) || e).slice(0, 300) });
  }
};

// Google Gemini with Google Search grounding — free tier covers personal use.
async function geminiSearch(prompt) {
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(process.env.GEMINI_API_KEY);
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || ("Gemini HTTP " + r.status));
  const cand = (data.candidates && data.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  return parts.map((p) => p.text || "").join("");
}

// Optional Claude fallback (paid) if no Gemini key is configured.
async function claudeSearch(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || ("Claude HTTP " + r.status));
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

function resp(statusCode, obj) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) };
}
