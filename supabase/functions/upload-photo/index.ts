// upload-photo — players (no login) send a square's proof photo; it's saved to the
// session host's Google Drive under  Icebreaker Bingo / <date> – session <id> / .
//
// POST multipart/form-data:
//   session_id  uuid of the session (from game.html?session=…)
//   cell_index  board position the photo is for (0-based)
//   phrase      that square's phrase text — must be one of the host's saved phrases
//   name        optional player-entered name for the square (≤ 15 chars, as in game.html)
//   file_id     optional — a Drive file id this endpoint returned earlier; when given
//               the photo REPLACES that file (retake) instead of creating a new one
//   photo       the image: JPEG, ≤ 4032 × 3024 (either orientation) and ≤ 8 MB.
//               game.html scales larger photos down to fit and re-encodes as JPEG.
//
// → 200 { file_id }
// → 4xx/5xx { error, code? } where code is one of:
//     host_not_connected  host never linked Drive (or disconnected) — keep photo local
//     drive_disconnected  host's Google access was revoked/expired — keep photo local
//     rate_limited        too many uploads for this session right now — retry later
//     session_not_found

import {
  adminClient,
  corsHeaders,
  createFolder,
  deleteFile,
  DriveDisconnectedError,
  DriveNotFoundError,
  folderUsable,
  json,
  refreshAccessToken,
  ROOT_FOLDER_NAME,
  uploadFile,
} from "../_shared/google.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Photos may be up to standard 12 MP phone resolution (4032 × 3024, either orientation).
// A JPEG at that size is typically 2–5 MB; 8 MB leaves room for very detailed scenes.
const MAX_LONG_EDGE = 4032;
const MAX_SHORT_EDGE = 3024;
const MAX_BYTES = 8 * 1024 * 1024;
const RATE_WINDOW_SECONDS = 60;
const MAX_UPLOADS_PER_WINDOW = 120; // per session — a class of ~40 snapping at once, with headroom
const MAX_UPLOADS_PER_SESSION = 3000; // hard ceiling so one leaked link can't fill a host's Drive
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Drive accepts most characters, but keep names tidy and free of path-like separators.
function cleanForFilename(s: string, max: number): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

// Read width/height from the JPEG's SOF (start-of-frame) header without decoding pixels.
// Returns null if the file isn't a well-formed JPEG.
function jpegDimensions(b: Uint8Array): { width: number; height: number } | null {
  let i = 2; // skip SOI (FF D8)
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const segLen = (b[i + 2] << 8) | b[i + 3];
    // SOF0–SOF15, excluding DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    if (marker === 0xd9 || marker === 0xda) return null; // reached image data/end with no SOF
    i += 2 + segLen;
  }
  return null;
}

interface SessionRow {
  id: string;
  host_id: string;
  created_at: string;
  drive_folder_id: string | null;
}

// Find (or lazily create) this session's Drive folder, recreating it — and the root
// app folder — if the host has deleted or binned them.
async function ensureSessionFolder(
  admin: SupabaseClient,
  accessToken: string,
  session: SessionRow,
  rootFolderId: string | null,
): Promise<string> {
  if (session.drive_folder_id && await folderUsable(accessToken, session.drive_folder_id)) {
    return session.drive_folder_id;
  }

  let rootId = rootFolderId;
  if (!rootId || !(await folderUsable(accessToken, rootId))) {
    rootId = await createFolder(accessToken, ROOT_FOLDER_NAME);
    await admin.from("host_drive_tokens").update({ root_folder_id: rootId }).eq("user_id", session.host_id);
  }

  const date = session.created_at.slice(0, 10);
  const newId = await createFolder(accessToken, `${date} – session ${session.id.slice(0, 8)}`, rootId);

  // Compare-and-swap so two players uploading the very first photos at the same moment
  // don't leave the session pointing at two different folders.
  let q = admin.from("sessions").update({ drive_folder_id: newId }).eq("id", session.id);
  q = session.drive_folder_id === null ? q.is("drive_folder_id", null) : q.eq("drive_folder_id", session.drive_folder_id);
  const { data: won } = await q.select("id");
  if (won && won.length > 0) return newId;

  // Lost the race — use the winner's folder and discard ours.
  await deleteFile(accessToken, newId);
  const { data: fresh } = await admin.from("sessions").select("drive_folder_id").eq("id", session.id).single();
  return fresh!.drive_folder_id as string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Expected multipart/form-data" }, 400);
  }

  // ── Validate input ──
  const sessionId = String(form.get("session_id") ?? "");
  const cellIndex = Number(form.get("cell_index"));
  const phrase = String(form.get("phrase") ?? "");
  const name = String(form.get("name") ?? "").slice(0, 15);
  const retakeFileId = form.get("file_id") ? String(form.get("file_id")) : null;
  const photo = form.get("photo");

  if (!UUID_RE.test(sessionId)) return json({ error: "Invalid session_id" }, 400);
  if (!Number.isInteger(cellIndex) || cellIndex < 0) return json({ error: "Invalid cell_index" }, 400);
  if (!(photo instanceof File)) return json({ error: "photo is required" }, 400);
  if (photo.size === 0 || photo.size > MAX_BYTES) return json({ error: "Photo must be under 8 MB" }, 413);
  if (retakeFileId !== null && !/^[A-Za-z0-9_-]{10,200}$/.test(retakeFileId)) {
    return json({ error: "Invalid file_id" }, 400);
  }
  const media = new Uint8Array(await photo.arrayBuffer());
  if (!isJpeg(media)) return json({ error: "Photo must be a JPEG" }, 415);
  const dims = jpegDimensions(media);
  if (!dims || dims.width === 0 || dims.height === 0) return json({ error: "Unreadable JPEG" }, 415);
  if (Math.max(dims.width, dims.height) > MAX_LONG_EDGE || Math.min(dims.width, dims.height) > MAX_SHORT_EDGE) {
    return json({ error: `Photo must be at most ${MAX_LONG_EDGE} × ${MAX_SHORT_EDGE}` }, 413);
  }

  const admin = adminClient();

  try {
    // ── Session + host checks ──
    const { data: session } = await admin
      .from("sessions").select("id, host_id, created_at, drive_folder_id").eq("id", sessionId).maybeSingle();
    if (!session) return json({ error: "Session not found", code: "session_not_found" }, 404);

    const { data: hostPhrases } = await admin
      .from("user_phrases").select("phrases").eq("user_id", session.host_id).maybeSingle();
    const phraseList: string[] = Array.isArray(hostPhrases?.phrases) ? hostPhrases.phrases : [];
    // Board has phrases.length + 1 cells (the centre free space).
    if (cellIndex > phraseList.length) return json({ error: "Invalid cell_index" }, 400);
    if (!phraseList.includes(phrase)) return json({ error: "Phrase is not on this session's board" }, 400);

    const { data: tokenRow } = await admin
      .from("host_drive_tokens").select("refresh_token, root_folder_id").eq("user_id", session.host_id).maybeSingle();
    if (!tokenRow) return json({ error: "Host has not connected Google Drive", code: "host_not_connected" }, 409);

    // ── Rate limits ──
    const since = new Date(Date.now() - RATE_WINDOW_SECONDS * 1000).toISOString();
    const { count: recent } = await admin
      .from("photo_uploads").select("id", { count: "exact", head: true })
      .eq("session_id", sessionId).gte("created_at", since);
    if ((recent ?? 0) >= MAX_UPLOADS_PER_WINDOW) {
      return json({ error: "Too many uploads right now — try again in a minute", code: "rate_limited" }, 429);
    }
    const { count: lifetime } = await admin
      .from("photo_uploads").select("id", { count: "exact", head: true }).eq("session_id", sessionId);
    if ((lifetime ?? 0) >= MAX_UPLOADS_PER_SESSION) {
      return json({ error: "This session has reached its photo limit", code: "rate_limited" }, 429);
    }

    // A retake may only overwrite a file previously uploaded for THIS session.
    if (retakeFileId) {
      const { data: owned } = await admin
        .from("photo_uploads").select("id").eq("session_id", sessionId).eq("file_id", retakeFileId).limit(1);
      if (!owned || owned.length === 0) return json({ error: "file_id does not belong to this session" }, 403);
    }

    // ── Upload ──
    const { accessToken } = await refreshAccessToken(tokenRow.refresh_token);
    const folderId = await ensureSessionFolder(admin, accessToken, session, tokenRow.root_folder_id);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fileName = [
      String(cellIndex + 1).padStart(2, "0"),
      cleanForFilename(phrase, 60),
      cleanForFilename(name, 15) || "anon",
      stamp,
    ].join(" - ") + ".jpg";

    let fileId: string;
    try {
      fileId = await uploadFile(accessToken, {
        name: fileName, parentId: folderId, fileId: retakeFileId ?? undefined, media, mimeType: "image/jpeg",
      });
    } catch (e) {
      // Host deleted the original photo in Drive — save the retake as a new file instead.
      if (!(e instanceof DriveNotFoundError) || !retakeFileId) throw e;
      fileId = await uploadFile(accessToken, { name: fileName, parentId: folderId, media, mimeType: "image/jpeg" });
    }

    await admin.from("photo_uploads").insert({ session_id: sessionId, file_id: fileId, cell_index: cellIndex });
    return json({ file_id: fileId });
  } catch (err) {
    if (err instanceof DriveDisconnectedError) {
      // Token's dead — drop it so the host's dashboard prompts them to reconnect.
      const { data: s } = await admin.from("sessions").select("host_id").eq("id", sessionId).maybeSingle();
      if (s) await admin.from("host_drive_tokens").delete().eq("user_id", s.host_id);
      return json({ error: "Host's Google Drive is disconnected", code: "drive_disconnected" }, 409);
    }
    console.error("upload-photo error:", err);
    return json({ error: "Upload failed" }, 500);
  }
});
