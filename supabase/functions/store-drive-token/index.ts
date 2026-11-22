// store-drive-token — host-only (signed-in) endpoint for the host's Google Drive connection.
//
// POST JSON body, one of:
//   { action: "store", refresh_token: "<session.provider_refresh_token>" }
//       Called from auth.html right after Google sign-in — the only moment Supabase
//       hands the browser Google's refresh token (it doesn't persist it). The token is
//       checked against Google (and for the drive.file scope) before being saved.
//   { action: "status" }
//       → { connected: boolean } — for the dashboard's "Photos save to your Drive" badge.
//       Does a live refresh, so a token the host revoked in their Google account shows
//       as disconnected (and is cleaned up) rather than looking fine until upload time.
//   { action: "disconnect" }
//       Revokes the token at Google and deletes it. Photos already in Drive are untouched.

import {
  adminClient,
  corsHeaders,
  DRIVE_FILE_SCOPE,
  DriveDisconnectedError,
  json,
  refreshAccessToken,
  revokeToken,
} from "../_shared/google.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // verify_jwt = true already rejected unsigned/expired tokens; resolve it to a real user
  // so the bare anon key (role "anon", no user) can't call this.
  const jwt = req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  const admin = adminClient();
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const user = userData?.user;
  if (userErr || !user) return json({ error: "Sign in required" }, 401);

  let body: { action?: string; refresh_token?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  try {
    switch (body.action) {
      case "store": {
        const refreshToken = body.refresh_token;
        if (typeof refreshToken !== "string" || refreshToken.length < 10 || refreshToken.length > 2048) {
          return json({ error: "refresh_token is required" }, 400);
        }
        // Prove the token is real, belongs to our OAuth client, and carries Drive access.
        let scope: string;
        try {
          ({ scope } = await refreshAccessToken(refreshToken));
        } catch (e) {
          if (e instanceof DriveDisconnectedError) return json({ error: "Google rejected this token" }, 400);
          throw e;
        }
        if (!scope.split(" ").includes(DRIVE_FILE_SCOPE)) {
          return json({ error: "Google Drive access was not granted", code: "missing_scope" }, 400);
        }

        const { error } = await admin.from("host_drive_tokens").upsert({
          user_id: user.id,
          refresh_token: refreshToken,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });
        if (error) throw error;
        return json({ connected: true });
      }

      case "status": {
        const { data: row, error } = await admin
          .from("host_drive_tokens").select("refresh_token").eq("user_id", user.id).maybeSingle();
        if (error) throw error;
        if (!row) return json({ connected: false });
        try {
          await refreshAccessToken(row.refresh_token);
          return json({ connected: true });
        } catch (e) {
          if (e instanceof DriveDisconnectedError) {
            await admin.from("host_drive_tokens").delete().eq("user_id", user.id);
            return json({ connected: false });
          }
          throw e;
        }
      }

      case "disconnect": {
        const { data: row } = await admin
          .from("host_drive_tokens").select("refresh_token").eq("user_id", user.id).maybeSingle();
        if (row) await revokeToken(row.refresh_token);
        await admin.from("host_drive_tokens").delete().eq("user_id", user.id);
        return json({ connected: false });
      }

      default:
        return json({ error: "action must be store, status, or disconnect" }, 400);
    }
  } catch (err) {
    console.error("store-drive-token error:", err);
    return json({ error: "Server error" }, 500);
  }
});
