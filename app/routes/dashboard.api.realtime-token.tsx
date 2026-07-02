// app/routes/dashboard.api.realtime-token.tsx
// Mints a short-lived Supabase JWT (role=authenticated, shop_id claim) so the
// dashboard UI can open a Realtime subscription scoped by the RLS policies in
// migration 20260609140000_dashboard_realtime.sql. Polling the read API is the
// fallback when this is unavailable.

import type { LoaderFunctionArgs } from "react-router";
import { SignJWT } from "jose";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { jsonOk, jsonError } from "~/lib/dashboard/http.server";

const TTL_SECONDS = 3600;

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);

  const secret = process.env.SUPABASE_JWT_SECRET;
  // The project URL and publishable key are public (they ship in every
  // supabase-js browser app). The hosted gateway only accepts real API keys
  // for the socket handshake — the shop-scoped JWT authorizes via setAuth.
  const url = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!secret || !url || !publishableKey) return jsonError(503, "realtime_not_configured");

  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const token = await new SignJWT({
    role: "authenticated",
    shop_id: session.shopId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .setAudience("authenticated")
    .sign(new TextEncoder().encode(secret));

  // shop_id lets the client add a defense-in-depth postgres_changes filter on
  // top of the RLS scoping (it is the session's own shop, not a secret).
  return jsonOk({
    token,
    url,
    publishable_key: publishableKey,
    shop_id: session.shopId,
    expires_at: new Date(exp * 1000).toISOString(),
  });
}
