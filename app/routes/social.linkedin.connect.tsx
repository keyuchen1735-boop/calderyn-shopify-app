// app/routes/social.linkedin.connect.tsx
//
// GET — initiates LinkedIn OAuth. Public route (no authenticate.admin); a
// browser navigation, so the one-time setup key rides in ?key= (can't use a
// header from a link). It is a DEDICATED, rotatable secret (LINKEDIN_SETUP_KEY)
// — never CRON_SECRET — so a key landing in access logs can't compromise the
// cron auth. Remove/rotate LINKEDIN_SETUP_KEY after the one-time connect.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { timingSafeEqual } from "node:crypto";
import { json, redirect } from "@remix-run/node";
import { getAuthorizeUrl } from "~/lib/social/linkedin.server";
import { signState } from "~/lib/social/linkedin-connection.server";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Brand palette (shared across social.linkedin.* routes)
// ---------------------------------------------------------------------------

const BRAND = {
  navy: "#10293B",
  cream: "#F1EFE8",
  teal: "#1E7079",
  muted: "#5b6b6e",
} as const;

const pageStyle = `
  min-height:100vh;
  background:${BRAND.cream};
  padding:24px 16px;
  font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
`;

const cardStyle = `
  max-width:480px;
  margin:80px auto;
  padding:40px 36px;
  background:#ffffff;
  border-radius:18px;
  border:1px solid rgba(0,0,0,.07);
  color:${BRAND.navy};
`;

function infoPage(heading: string, body: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>LinkedIn Connect — Calderyn</title></head>
<body style="${pageStyle}">
  <div style="${cardStyle}">
    <h1 style="margin:0 0 12px;font-size:22px;color:${BRAND.navy}">${heading}</h1>
    <p style="color:${BRAND.muted};margin:0">${body}</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  // Gate: dedicated, rotatable setup key (NOT CRON_SECRET); fail closed when unset.
  const secret = process.env.LINKEDIN_SETUP_KEY;
  const key = url.searchParams.get("key");
  if (!secret || !key || !safeEqual(key, secret)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  if (!clientId) {
    return infoPage(
      "LinkedIn not configured",
      "LINKEDIN_CLIENT_ID is not set — add it to your environment variables and redeploy.",
    );
  }

  const baseUrl =
    process.env.SOCIAL_DIGEST_BASE_URL ?? "https://app.calderyncompany.com";
  const redirectUri = `${baseUrl}/social/linkedin/callback`;

  const state = signState();
  const authorizeUrl = getAuthorizeUrl({ clientId, redirectUri, state });

  return redirect(authorizeUrl);
}

// ---------------------------------------------------------------------------
// Default export (Remix requires one even for loader-only routes)
// ---------------------------------------------------------------------------

export default function LinkedInConnect() {
  return null;
}
