// Shared helpers for the Google Drive Edge Functions (store-drive-token, upload-photo).
// Folders starting with "_" are not deployed as functions themselves.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const ROOT_FOLDER_NAME = "Icebreaker Bingo";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Service-role client — bypasses RLS. Only ever used server-side, inside these functions.
export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

// Thrown when Google says the refresh token is no longer valid (host revoked access,
// changed password, token expired because the OAuth app is still in "Testing", etc.).
export class DriveDisconnectedError extends Error {}

export interface TokenResult {
  accessToken: string;
  scope: string;
}

// Swap a long-lived refresh token for a ~1h access token.
export async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Google OAuth client not configured");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === "invalid_grant") throw new DriveDisconnectedError("Refresh token revoked or expired");
    throw new Error(`Google token error: ${data.error ?? res.status}`);
  }
  return { accessToken: data.access_token, scope: data.scope ?? "" };
}

export async function revokeToken(token: string): Promise<void> {
  await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  }).catch(() => {});
}

// Thrown for a 404 on a parent folder/file — e.g. the host deleted the folder in Drive.
export class DriveNotFoundError extends Error {}

async function driveFetch(accessToken: string, url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) throw new DriveNotFoundError(url);
  if (res.status === 401) throw new DriveDisconnectedError("Access token rejected");
  if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Returns true if the folder exists and isn't in the bin.
export async function folderUsable(accessToken: string, folderId: string): Promise<boolean> {
  try {
    const f = await driveFetch(
      accessToken,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,trashed`,
    );
    return !f.trashed;
  } catch (e) {
    if (e instanceof DriveNotFoundError) return false;
    throw e;
  }
}

export async function createFolder(accessToken: string, name: string, parentId?: string): Promise<string> {
  const f = await driveFetch(accessToken, "https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  return f.id;
}

export async function deleteFile(accessToken: string, fileId: string): Promise<void> {
  await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  }).catch(() => {});
}

// Build a multipart/related body (JSON metadata + binary media) for the Drive upload API.
function multipartBody(metadata: unknown, media: Uint8Array, mimeType: string) {
  const boundary = "bingo" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + media.length + tail.length);
  body.set(head, 0);
  body.set(media, head.length);
  body.set(tail, head.length + media.length);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

// Create a new file, or (when fileId is given) replace an existing file's contents + name.
export async function uploadFile(
  accessToken: string,
  opts: { name: string; parentId?: string; fileId?: string; media: Uint8Array; mimeType: string },
): Promise<string> {
  const metadata: Record<string, unknown> = { name: opts.name, mimeType: opts.mimeType };
  if (!opts.fileId && opts.parentId) metadata.parents = [opts.parentId];
  const { body, contentType } = multipartBody(metadata, opts.media, opts.mimeType);

  const url = opts.fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(opts.fileId)}?uploadType=multipart&fields=id`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id";

  const f = await driveFetch(accessToken, url, {
    method: opts.fileId ? "PATCH" : "POST",
    headers: { "Content-Type": contentType },
    body,
  });
  return f.id;
}
