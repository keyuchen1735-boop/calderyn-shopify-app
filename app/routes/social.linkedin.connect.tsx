// app/routes/social.linkedin.connect.tsx
//
// GET — initiates LinkedIn OAuth. Public route (no authenticate.admin).
// Protected by a one-time setup key (?key=<CRON_SECRET>).

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { getAuthorizeUrl } from "~/lib/social/linkedin.server";
import { signState } from "~/lib/social/linkedin-connection.server";

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

  // Gate: key must match CRON_SECRET; fail explicitly when CRON_SECRET is unset
  const secret = process.env.CRON_SECRET;
  const key = url.searchParams.get("key");
  if (!secret || !key || key !== secret) {
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
