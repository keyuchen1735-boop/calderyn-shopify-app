// app/routes/social.linkedin.callback.tsx
//
// GET — LinkedIn OAuth callback. Public route (no authenticate.admin).
// Exchanges the code, fetches the member URN, and saves the connection.
// Never throws past this loader — all failures render an error page (rule 12).

import type { LoaderFunctionArgs } from "@remix-run/node";
import { exchangeCode, fetchMemberUrn } from "~/lib/social/linkedin.server";
import { saveConnection, verifyState } from "~/lib/social/linkedin-connection.server";

// ---------------------------------------------------------------------------
// Brand palette
// ---------------------------------------------------------------------------

const BRAND = {
  navy: "#10293B",
  cream: "#F1EFE8",
  teal: "#1E7079",
  muted: "#5b6b6e",
  red: "#c0392b",
} as const;

const PAGE_STYLE = `min-height:100vh;background:${BRAND.cream};padding:24px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;`;
const CARD_STYLE = `max-width:520px;margin:80px auto;padding:40px 36px;background:#ffffff;border-radius:18px;border:1px solid rgba(0,0,0,.07);color:${BRAND.navy};`;
const H1_STYLE = (color: string) => `margin:0 0 12px;font-size:22px;color:${color}`;
const P_STYLE = `color:${BRAND.muted};margin:0;line-height:1.6`;

function htmlPage(heading: string, headingColor: string, body: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>LinkedIn — Calderyn</title></head>
<body style="${PAGE_STYLE}">
  <div style="${CARD_STYLE}">
    <h1 style="${H1_STYLE(headingColor)}">${heading}</h1>
    <p style="${P_STYLE}">${escHtml(body)}</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Minimal HTML escaping so error messages render safely. */
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const errorParam = url.searchParams.get("error");
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";

  // User denied access
  if (errorParam) {
    return htmlPage(
      "Connection cancelled",
      BRAND.muted,
      "You declined the LinkedIn authorisation request. No connection was saved. You can try again whenever you like.",
    );
  }

  // Validate the HMAC state to confirm we issued this flow
  if (!verifyState(state)) {
    return htmlPage(
      "Link invalid or expired",
      BRAND.red,
      "This OAuth callback link is invalid or has expired (links are valid for 10 minutes). Please restart the connection flow.",
    );
  }

  const clientId = process.env.LINKEDIN_CLIENT_ID ?? "";
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET ?? "";
  const baseUrl =
    process.env.SOCIAL_DIGEST_BASE_URL ?? "https://app.calderyncompany.com";
  const redirectUri = `${baseUrl}/social/linkedin/callback`;

  try {
    const tokens = await exchangeCode({ code, redirectUri, clientId, clientSecret });
    const memberUrn = await fetchMemberUrn(tokens.accessToken);
    await saveConnection({ tokens, memberUrn });

    return htmlPage(
      "LinkedIn connected",
      BRAND.teal,
      `LinkedIn connected as ${memberUrn} — approvals will now auto-post.`,
    );
  } catch (err) {
    console.error("[linkedin.callback]", err);
    return htmlPage(
      "Connection failed",
      BRAND.red,
      "Couldn't connect LinkedIn — please retry, or check server logs.",
    );
  }
}

// ---------------------------------------------------------------------------
// Default export (Remix requires one even for loader-only routes)
// ---------------------------------------------------------------------------

export default function LinkedInCallback() {
  return null;
}
