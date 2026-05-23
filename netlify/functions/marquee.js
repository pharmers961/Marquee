// Marquee backend proxy — keeps API keys server-side so live events work
// for every visitor without exposing any secret in the page.
//
// Set these in Netlify → Site settings → Environment variables:
//   TICKETMASTER_KEY   (Consumer Key from developer.ticketmaster.com)
//   ANTHROPIC_API_KEY  (from console.anthropic.com — optional; powers web search)

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

    // --- Claude web search (catch-all for venues with no API) ---
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return resp(500, { error: "ANTHROPIC_API_KEY not set" });
    if (!body.prompt) return resp(400, { error: "Missing prompt" });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        messages: [{ role: "user", content: body.prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return resp(r.status, { error: (data.error && data.error.message) || ("HTTP " + r.status) });
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return resp(200, { text });
  } catch (e) {
    return resp(500, { error: String((e && e.message) || e).slice(0, 300) });
  }
};

function resp(statusCode, obj) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) };
}
