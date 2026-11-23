// Photo label — a caption drawn onto every photo saved to the host's Google Drive.
// The host saves a list of captions; each photo gets one of them (each used once before
// any repeats) in a random font and colour — see the "Random captions" section below.
//
// Shared by dashboard.html (SVG sample) and game.html (drawn onto the full-size photo on
// a canvas just before upload). Both use layoutPhotoLabel(), so
// the preview matches the real result: every size is relative to the photo's shorter
// edge (u = min(w, h) / 1000), which keeps the look identical for landscape, portrait,
// square, large or small photos.

const PHOTO_TITLE_MAX = 80; // code points

// Keys must match the CHECK constraint in supabase/sql/photo-label.sql.
const PHOTO_FONTS = {
  syne:     { label: 'Syne — bold',            family: 'Syne',             weight: 800 },
  dmsans:   { label: 'DM Sans — clean',        family: 'DM Sans',          weight: 700 },
  bebas:    { label: 'Bebas Neue — tall',      family: 'Bebas Neue',       weight: 400 },
  playfair: { label: 'Playfair — elegant',     family: 'Playfair Display', weight: 700 },
  pacifico: { label: 'Pacifico — script',      family: 'Pacifico',         weight: 400 },
  marker:   { label: 'Permanent Marker',       family: 'Permanent Marker', weight: 400 },
  caveat:   { label: 'Caveat — handwritten',   family: 'Caveat',           weight: 700 },
};

const PHOTO_COLORS = ['#FFFFFF', '#1A1010', '#E8521A', '#FFD43B', '#3B5BDB', '#F783AC', '#40C057'];

// Load every label font's stylesheet once. Font files themselves are only downloaded
// when a font is actually used (loadPhotoFont), so this stays light.
(function injectPhotoFonts() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Syne:wght@800&family=DM+Sans:wght@700'
    + '&family=Bebas+Neue&family=Playfair+Display:wght@700&family=Pacifico'
    + '&family=Permanent+Marker&family=Caveat:wght@700&display=swap';
  document.head.appendChild(link);
})();

function normalizePhotoLabel(raw) {
  const l = raw || {};
  return {
    // Cut by code points (never mid-emoji); room for a caption plus its emoji on both sides.
    title: Array.from(String(l.title || '').replace(/\s+/g, ' ').trim()).slice(0, PHOTO_TITLE_MAX).join(''),
    font: PHOTO_FONTS[l.font] ? l.font : 'syne',
    color: /^#[0-9a-f]{6}$/i.test(l.color || '') ? l.color.toUpperCase() : '#FFFFFF',
  };
}

function photoFontCss(font, px) {
  const f = PHOTO_FONTS[font] || PHOTO_FONTS.syne;
  return `${f.weight} ${px}px "${f.family}", sans-serif`;
}

// Waits for the font (with the glyphs this title needs). Canvas text silently falls
// back to a default font if it isn't loaded yet. Offline → falls back to sans-serif.
async function loadPhotoFont(font, text) {
  try {
    await document.fonts.load(photoFontCss(font, 64), text || 'Aa');
  } catch (e) {}
}

// Dark text gets a light band behind it; light text a dark band.
function isDarkPhotoColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = 0.2126 * lin(n >> 16 & 255) + 0.7152 * lin(n >> 8 & 255) + 0.0722 * lin(n & 255);
  return lum < 0.35;
}

let _labelMeasureCtx = null;
function measureLabelText(text, font, px) {
  if (!_labelMeasureCtx) _labelMeasureCtx = document.createElement('canvas').getContext('2d');
  _labelMeasureCtx.font = photoFontCss(font, px);
  return _labelMeasureCtx.measureText(text).width;
}

// Greedy word wrap; null if it needs more than maxLines lines or a word is too wide.
function wrapLabelWords(text, font, px, maxW, maxLines) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? cur + ' ' + word : word;
    if (measureLabelText(test, font, px) <= maxW) { cur = test; continue; }
    if (!cur || measureLabelText(word, font, px) > maxW) return null;
    lines.push(cur);
    cur = word;
  }
  if (cur) lines.push(cur);
  return lines.length <= maxLines ? lines : null;
}

// Last resort at the smallest size: break anywhere, end with "…".
function truncateLabelLines(text, font, px, maxW, maxLines) {
  const chars = Array.from(text); // keeps emoji / surrogate pairs whole
  const lines = [];
  let cur = '';
  for (let k = 0; k < chars.length; k++) {
    const test = cur + chars[k];
    if (measureLabelText(test, font, px) <= maxW) { cur = test; continue; }
    if (lines.length === maxLines - 1) {
      while (cur && measureLabelText(cur + '…', font, px) > maxW) cur = Array.from(cur).slice(0, -1).join('');
      lines.push(cur.trimEnd() + '…');
      return lines;
    }
    lines.push(cur);
    cur = chars[k];
  }
  lines.push(cur);
  return lines;
}

// → geometry for a w × h photo. All values in the photo's own pixels.
function layoutPhotoLabel(w, h, label) {
  const u = Math.min(w, h) / 1000;
  const maxW = w - 2 * 70 * u;
  let px = 80 * u;
  let lines = null;
  // Prefer one line (keeps a caption's mirrored emoji level with each other), shrinking
  // down to a still-readable size; only then allow two lines.
  for (let size = 80; size >= 52 && !lines; size -= 4) {
    px = size * u;
    lines = wrapLabelWords(label.title, label.font, px, maxW, 1);
  }
  for (let size = 80; size >= 40 && !lines; size -= 4) {
    px = size * u;
    lines = wrapLabelWords(label.title, label.font, px, maxW, 2);
  }
  if (!lines) lines = truncateLabelLines(label.title, label.font, px, maxW, 2);
  const lineH = px * 1.22;
  const padY = 46 * u;
  const textTop = h - padY - lines.length * lineH;
  const dark = isDarkPhotoColor(label.color);
  return {
    u, px, lines, lineH, padY, textTop,
    frame: 12 * u,
    fadeTop: textTop - padY - 110 * u,   // where the band starts fading in
    solidTop: textTop - padY * 0.6,      // fully opaque below here
    band: dark ? '255,255,255' : '0,0,0',
    bandAlpha: dark ? 0.78 : 0.62,
    shadow: dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)',
    baseline: k => textTop + k * lineH + lineH * 0.8,
  };
}

// Draws frame + band + title onto a canvas that already holds the photo.
function drawPhotoLabel(ctx, w, h, label) {
  const L = layoutPhotoLabel(w, h, label);
  const g = ctx.createLinearGradient(0, L.fadeTop, 0, L.solidTop);
  g.addColorStop(0, `rgba(${L.band},0)`);
  g.addColorStop(1, `rgba(${L.band},${L.bandAlpha})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, L.fadeTop, w, L.solidTop - L.fadeTop);
  ctx.fillStyle = `rgba(${L.band},${L.bandAlpha})`;
  ctx.fillRect(0, L.solidTop, w, h - L.solidTop);

  ctx.strokeStyle = label.color;
  ctx.lineWidth = L.frame;
  ctx.strokeRect(L.frame / 2, L.frame / 2, w - L.frame, h - L.frame);

  ctx.save();
  ctx.font = photoFontCss(label.font, L.px);
  ctx.fillStyle = label.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = L.shadow;
  ctx.shadowBlur = 8 * L.u;
  ctx.shadowOffsetY = 2 * L.u;
  L.lines.forEach((line, k) => ctx.fillText(line, w / 2, L.baseline(k)));
  ctx.restore();
}

// Full-size JPEG → same photo with the label drawn on. Returns the input unchanged if
// there's no title.
async function composeLabelledPhoto(blob, label) {
  if (!label || !label.title) return blob;
  await loadPhotoFont(label.font, label.title);
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  drawPhotoLabel(ctx, c.width, c.height, label);
  return new Promise((resolve, reject) => c.toBlob(out => {
    c.width = c.height = 0;
    out ? resolve(out) : reject(new Error('JPEG encode failed'));
  }, 'image/jpeg', 0.85));
}

// SVG sample for the dashboard: a placeholder "photo" with the label laid out exactly
// as it will be on a 4:3 photo.
function photoLabelSvg(label, w = 800, h = 600) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const f = PHOTO_FONTS[label.font] || PHOTO_FONTS.syne;
  const photo = `
    <defs>
      <linearGradient id="plSky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#8EC5E8"/><stop offset="1" stop-color="#F4D9B8"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#plSky)"/>
    <rect y="${h * 0.62}" width="${w}" height="${h * 0.38}" fill="#9BBF85"/>
    <g fill="#5A4A6B" opacity="0.85">
      <circle cx="${w * 0.38}" cy="${h * 0.36}" r="${h * 0.075}"/>
      <rect x="${w * 0.31}" y="${h * 0.45}" width="${w * 0.14}" height="${h * 0.36}" rx="${h * 0.06}"/>
    </g>
    <g fill="#B85C38" opacity="0.85">
      <circle cx="${w * 0.6}" cy="${h * 0.33}" r="${h * 0.08}"/>
      <rect x="${w * 0.525}" y="${h * 0.43}" width="${w * 0.15}" height="${h * 0.38}" rx="${h * 0.06}"/>
    </g>`;
  if (!label.title) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Sample photo with no label">${photo}</svg>`;
  }
  const L = layoutPhotoLabel(w, h, label);
  const fadeH = L.solidTop - L.fadeTop;
  const text = L.lines.map((line, k) =>
    `<text x="${w / 2}" y="${L.baseline(k).toFixed(1)}">${esc(line)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Sample photo labelled: ${esc(label.title)}">
    ${photo}
    <defs>
      <linearGradient id="plFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="rgb(${L.band})" stop-opacity="0"/>
        <stop offset="1" stop-color="rgb(${L.band})" stop-opacity="${L.bandAlpha}"/>
      </linearGradient>
      <filter id="plShadow" x="-10%" y="-50%" width="120%" height="200%">
        <feDropShadow dx="0" dy="${(2 * L.u).toFixed(2)}" stdDeviation="${(4 * L.u).toFixed(2)}" flood-color="${L.shadow}"/>
      </filter>
    </defs>
    <rect y="${L.fadeTop.toFixed(1)}" width="${w}" height="${fadeH.toFixed(1)}" fill="url(#plFade)"/>
    <rect y="${L.solidTop.toFixed(1)}" width="${w}" height="${(h - L.solidTop).toFixed(1)}" fill="rgb(${L.band})" fill-opacity="${L.bandAlpha}"/>
    <rect x="${L.frame / 2}" y="${L.frame / 2}" width="${w - L.frame}" height="${h - L.frame}" fill="none" stroke="${label.color}" stroke-width="${L.frame}"/>
    <g font-family="&quot;${f.family}&quot;, sans-serif" font-weight="${f.weight}" font-size="${L.px.toFixed(1)}"
       fill="${label.color}" text-anchor="middle" filter="url(#plShadow)">${text}</g>
  </svg>`;
}

// ── Random captions ──
// A caption is { text, emojis }: emoji-free text plus a small set of emoji relevant to
// it. Each photo shows 1–3 of those emoji (random) on the left and the same ones in
// reverse order on the right, e.g. "🌴🚲 Pedal to the next match 🚲🌴".
// Older saved captions were plain strings with emoji inside; they're converted here.
const CAPTION_MAX = 30;        // visible characters of the text
const CAPTION_EMOJI_MAX = 6;   // emoji kept per caption (each photo uses 1–3 of them)
const CAPTIONS_MAX_COUNT = 20; // matches captions_are_valid() in photo-captions.sql

const _graphemes = (typeof Intl !== 'undefined' && Intl.Segmenter)
  ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
function graphemesOf(s) {
  return _graphemes ? [..._graphemes.segment(s)].map(g => g.segment) : Array.from(s);
}
function captionLength(s) { return graphemesOf(s).length; }

// A grapheme cluster that's an emoji (incl. flags, keycaps, skin tones, ZWJ sequences).
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
function isEmoji(g) { return EMOJI_RE.test(g); }

// "🌴 Island vibes 🏝️" → { text: 'Island vibes', emojis: ['🌴', '🏝️'] }
function splitEmojis(s) {
  const emojis = [];
  const text = graphemesOf(String(s || '')).filter(g => {
    if (isEmoji(g)) { emojis.push(g); return false; }
    return true;
  }).join('').replace(/\s+/g, ' ').trim();
  return { text, emojis };
}

function uniqueEmojis(list) {
  return [...new Set(list)].slice(0, CAPTION_EMOJI_MAX);
}

// → clean [{ text, emojis }]: emoji moved out of the text, empties/over-long dropped,
// duplicate texts removed, count capped.
function normalizeCaptions(list) {
  const seen = new Set();
  const out = [];
  (Array.isArray(list) ? list : []).forEach(c => {
    let text, emojis;
    if (typeof c === 'string') {
      ({ text, emojis } = splitEmojis(c));
    } else if (c && typeof c === 'object') {
      const t = splitEmojis(c.text);
      const e = Array.isArray(c.emojis) ? c.emojis.join('') : String(c.emojis || '');
      text = t.text;
      emojis = [...t.emojis, ...splitEmojis(e).emojis];
    } else {
      return;
    }
    if (!text || captionLength(text) > CAPTION_MAX || text.length > 40) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text, emojis: uniqueEmojis(emojis) });
  });
  return out.slice(0, CAPTIONS_MAX_COUNT);
}

// 1–3 of the caption's emoji (random pick, random order) left of the text, mirrored
// on the right.
function framedCaption(c) {
  if (!c.emojis || !c.emojis.length) return c.text;
  const pool = c.emojis.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picks = pool.slice(0, 1 + Math.floor(Math.random() * Math.min(3, pool.length)));
  return picks.join('') + ' ' + c.text + ' ' + picks.slice().reverse().join('');
}

function randomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Next caption for this board, using each caption once before any repeats. The
// remaining "bag" is kept in localStorage per board, so it survives reloads; captions
// the host has since removed are skipped, new ones join when the bag refills.
function nextCaption(captions, bagKey) {
  if (!captions.length) return null;
  const storeKey = 'bingo-photo:captionbag:' + bagKey;
  let bag = [];
  let last = null;
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey) || 'null');
    if (saved && Array.isArray(saved.bag)) { bag = saved.bag; last = saved.last || null; }
  } catch (e) {}
  // The bag holds caption texts; look the caption objects up by text.
  const byText = new Map(captions.map(c => [c.text, c]));
  bag = bag.filter(t => byText.has(t));
  if (!bag.length) {
    bag = captions.map(c => c.text);
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    // Don't start a new round with the caption that just ended the last one.
    if (bag.length > 1 && bag[0] === last) bag.push(bag.shift());
  }
  const text = bag.shift();
  try { localStorage.setItem(storeKey, JSON.stringify({ bag, last: text })); } catch (e) {}
  return byText.get(text);
}

// A complete overlay style: { title, font, color } — the shape drawPhotoLabel() takes.
// The emoji framing is rolled here too, so every photo (and retake) gets a fresh mix.
function randomCaptionStyle(caption) {
  return normalizePhotoLabel({
    title: framedCaption(caption),
    font: randomItem(Object.keys(PHOTO_FONTS)),
    color: randomItem(PHOTO_COLORS),
  });
}
