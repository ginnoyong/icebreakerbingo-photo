// generate-captions — suggests short photo captions (with emoji) for a host's theme.
// The host reviews/edits them on the dashboard before saving; nothing generated here is
// put on photos without that step.
//
// POST JSON { theme: string } → { captions: { text, emojis }[] } (up to 10)
//   text:   emoji-free caption, ≤ 30 characters
//   emojis: 3–5 emoji relevant to that caption; the game shows 1–3 of them on the left
//           and the same ones mirrored on the right of the text
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

const MAX_EMOJIS = 5;
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const graphemes = (s: string) => [...segmenter.segment(s)].map((g) => g.segment);
const isEmoji = (g: string) => /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(g);

interface Caption { text: string; emojis: string[] }

// Accepts { text, emojis } (asked for) or a plain string (if the model ignores the
// format); emoji found in the text are moved into the emoji set.
function cleanCaption(raw: unknown): Caption | null {
  let rawText: unknown = raw;
  let rawEmojis: unknown = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    rawText = (raw as Record<string, unknown>).text;
    rawEmojis = (raw as Record<string, unknown>).emojis;
  }
  if (typeof rawText !== "string") return null;
  const emojis: string[] = [];
  const text = graphemes(rawText)
    .filter((g) => (isEmoji(g) ? (emojis.push(g), false) : true))
    .join("")
    .replace(/^\s*(\d+[.)]|[-*•])\s*/, "") // list numbering / bullets
    .replace(/["“”]/g, "")                 // quotation marks
    .replace(/\s+/g, " ")
    .trim();
  const emojiSource = Array.isArray(rawEmojis) ? rawEmojis.join("") : String(rawEmojis ?? "");
  emojis.push(...graphemes(emojiSource).filter(isEmoji));
  if (!text || graphemes(text).length > MAX_CAPTION || text.length > 40) return null;
  const unique = [...new Set(emojis)].slice(0, MAX_EMOJIS);
  if (!unique.length) return null; // every caption needs at least one emoji
  return { text, emojis: unique };
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
- "text": the caption, at most ${MAX_CAPTION} characters including spaces, with NO emoji in it.
- "emojis": 3 to ${MAX_EMOJIS} different emoji that clearly relate to that caption's words
  and the theme. They will be placed around the caption, so pick ones that read well together.
- Friendly, inclusive and suitable for school students: no sarcasm, no put-downs,
  nothing about appearance, no slang that could be read as rude.
- All captions different from each other in wording.
- Do not include names, hashtags or quotation marks.
Respond with ONLY a JSON array of ${WANT + 4} objects. No explanation, no markdown.
Example: [{"text":"New friend unlocked!","emojis":["🤝","🔓","✨"]},
          {"text":"Bingo buddies","emojis":["🎉","👯","🎯","⭐"]}]`;

  try {
    const res = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        max_tokens: 2500,
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
    const captions: Caption[] = [];
    for (const item of raw) {
      const c = cleanCaption(item);
      if (!c) continue;
      const key = c.text.toLowerCase();
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
