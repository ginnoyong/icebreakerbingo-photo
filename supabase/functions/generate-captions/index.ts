// generate-captions — suggests short photo captions (with emoji) for a host's theme.
// The host reviews/edits them on the dashboard before saving; nothing generated here is
// put on photos without that step.
//
// POST JSON { theme: string } → { captions: string[] } (up to 10)
// Signed-in hosts only (same rule as generate-phrases).

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const WANT = 10;
const MAX_THEME = 100;
const MAX_CAPTION = 30; // visible characters (grapheme clusters), matching the dashboard

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// verify_jwt = true already rejected unsigned/expired tokens; this distinguishes a real
// signed-in host ("authenticated") from the public anon key.
function getJwtRole(req: Request): string | null {
  const token = req.headers.get("Authorization")?.replace(/^Bearer /, "");
  const payloadB64 = token?.split(".")[1];
  if (!payloadB64) return null;
  try {
    const base64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded)).role ?? null;
  } catch {
    return null;
  }
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const visibleLength = (s: string) => [...segmenter.segment(s)].length;

function cleanCaption(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .replace(/^\s*(\d+[.)]|[-*•])\s*/, "") // list numbering / bullets
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "") // wrapping quotes
    .replace(/\s+/g, " ")
    .trim();
  if (!s || visibleLength(s) > MAX_CAPTION || s.length > 40) return null;
  return s;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (getJwtRole(req) !== "authenticated") return json({ error: "Sign in required" }, 401);

  let theme: unknown;
  try {
    ({ theme } = await req.json());
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (typeof theme !== "string" || !theme.trim()) return json({ error: "theme is required" }, 400);
  theme = theme.trim().slice(0, MAX_THEME);

  const groqKey = Deno.env.get("GROQ_API_KEY");
  if (!groqKey) return json({ error: "API key not configured" }, 500);

  const systemPrompt =
    `You write short, upbeat photo captions for an in-person icebreaker bingo game.
Players photograph each person they meet; the caption is printed on the photo.
Rules:
- Each caption is at most ${MAX_CAPTION} characters INCLUDING spaces and emoji.
- Each caption contains 1 or 2 emoji that fit the theme.
- Friendly, inclusive and suitable for school students: no sarcasm, no put-downs,
  nothing about appearance, no slang that could be read as rude.
- All captions different from each other in wording.
- Do not include names, hashtags or quotation marks.
Respond with ONLY a JSON array of ${WANT + 4} strings. No explanation, no markdown.
Example: ["🤝 New friend unlocked!", "Bingo buddies 🎉"]`;

  try {
    const res = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        max_tokens: 1500,
        temperature: 0.9,
        reasoning_effort: "low",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Theme: ${theme}` },
        ],
      }),
    });
    if (!res.ok) {
      console.error("Groq error:", res.status, await res.text());
      return json({ error: "AI service error — please try again" }, 502);
    }
    const data = await res.json();
    const content = String(data?.choices?.[0]?.message?.content ?? "")
      .replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      // Fall back to one caption per line if the model ignored the JSON instruction.
      raw = content.split("\n");
    }
    if (!Array.isArray(raw)) return json({ error: "Unexpected response from AI" }, 502);

    const seen = new Set<string>();
    const captions: string[] = [];
    for (const item of raw) {
      const c = cleanCaption(item);
      if (!c) continue;
      const key = c.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      captions.push(c);
      if (captions.length === WANT) break;
    }
    if (captions.length === 0) return json({ error: "AI returned no usable captions — try again" }, 502);
    return json({ captions });
  } catch (err) {
    console.error("generate-captions error:", err);
    return json({ error: "Server error" }, 500);
  }
});
