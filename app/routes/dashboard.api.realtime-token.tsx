// app/routes/dashboard.api.realtime-token.tsx
// Mints a short-lived Supabase JWT (role=authenticated, shop_id claim) so the
// dashboard UI can open a Realtime subscription scoped by the RLS policies in
// migration 20260609140000_dashboard_realtime.sql. Polling the read API is the
// fallback when this is unavailable.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { SignJWT } from "jose";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { jsonOk, jsonError } from "~/lib/dashboard/http.server";

const TTL_SECONDS = 3600;

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);

  const secret = process.env.SUPABASE_JWT_SECRET;
  // The project URL is public (it ships in every supabase-js browser app) and
  // the client needs it to open the Realtime socket.
  const url = process.env.SUPABASE_URL;
  if (!secret || !url) return jsonError(503, "realtime_not_configured");

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

  return jsonOk({ token, url, expires_at: new Date(exp * 1000).toISOString() });
}
