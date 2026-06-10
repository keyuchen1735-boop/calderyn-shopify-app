// app/routes/dashboard.auth.callback.tsx
// Finishes the dashboard OAuth round-trip. The exchanged access token is
// discarded — the grant only proves the requester controls the shop. The shop
// must already exist in Supabase (app installed) to get a session.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  isValidShopDomain,
  verifyShopifyHmac,
  exchangeCodeForToken,
} from "~/lib/dashboard/shopify-oauth.server";
import { createSession, sessionCookieHeader } from "~/lib/dashboard/session.server";
import { jsonError, rateLimit, clientIpKey } from "~/lib/dashboard/http.server";
import { resolveShopId } from "~/lib/supabase.server";
import { STATE_COOKIE_NAME } from "./dashboard.login";

function readStateCookie(request: Request): { nonce: string; shop: string } | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === STATE_COOKIE_NAME) {
      const [nonce, shop] = decodeURIComponent(rest.join("=")).split(":");
      if (nonce && shop) return { nonce, shop };
    }
  }
  return null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!rateLimit(clientIpKey(request, "dash-callback"), 10, 60_000)) {
    return jsonError(429, "rate_limited");
  }

  const publicUrl = process.env.DASHBOARD_PUBLIC_URL ?? process.env.SHOPIFY_APP_URL ?? "";
  const failure = redirect(`${publicUrl}/dashboard/login?error=oauth_failed`, {
    headers: { "Set-Cookie": `${STATE_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax` },
  });

  const url = new URL(request.url);
  const shop = (url.searchParams.get("shop") ?? "").toLowerCase();
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";

  const cookieState = readStateCookie(request);
  if (
    !isValidShopDomain(shop) ||
    !code ||
    !cookieState ||
    cookieState.nonce !== state ||
    cookieState.shop !== shop ||
    !verifyShopifyHmac(url.searchParams, process.env.SHOPIFY_API_SECRET ?? "")
  ) {
    return failure;
  }

  const accepted = await exchangeCodeForToken({
    shop,
    code,
    clientId: process.env.SHOPIFY_API_KEY ?? "",
    clientSecret: process.env.SHOPIFY_API_SECRET ?? "",
  });
  if (!accepted) return failure;

  // Gate: only shops with the app installed (provisioned in Supabase) may in.
  try {
    await resolveShopId(shop);
  } catch {
    return jsonError(403, "app_not_installed");
  }

  const { raw } = await createSession(shop);
  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookieHeader(raw));
  headers.append(
    "Set-Cookie",
    `${STATE_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
  return redirect(`${publicUrl}/dashboard`, { headers });
}
