// The merchant dashboard SPA, served for /dashboard and every dedicated
// sub-URL (/dashboard/campaigns, /dashboard/orders/labels, …) by one splat
// route. One route id on purpose: back/forward between any two dashboard URLs
// stays inside this route, so React Router revalidates the loader instead of
// remounting the shell (which would drop all fetched state). The SPA reads the
// path to pick the screen (app/components/dashboard/routes.ts) and drives
// history itself. Specific dashboard.* routes (api.*, login, signin,
// builder.*, payouts.*, connect, auth.*) rank higher and are unaffected.
// Auth-gated by the loader (redirects to /dashboard/signin when
// unauthenticated); the client fetches all data on mount so no server-only
// module leaks into the browser bundle.
import type { LoaderFunctionArgs, LinksFunction } from "@remix-run/node";
import { useLoaderData, useRouteError } from "@remix-run/react";

import { requireVerifiedSession } from "~/lib/dashboard/session.server";
import { getSupabase } from "~/lib/supabase.server";
import DashboardApp from "~/components/dashboard/DashboardApp";
import {
  DashboardErrorBoundary,
  DashboardErrorFallback,
} from "~/components/dashboard/ErrorBoundary";

import dashboardUtils from "~/styles/dashboard-utils.css?url";
import dashboard from "~/styles/dashboard.css?url";
import rglStyles from "react-grid-layout/css/styles.css?url";
import rglResize from "react-resizable/css/styles.css?url";

// Utils first so the cd-* rules in dashboard.css can override the utility layer.
// react-grid-layout base styles before dashboard.css so our .cd-tile rules win.
export const links: LinksFunction = () => [
  { rel: "stylesheet", href: dashboardUtils },
  { rel: "stylesheet", href: rglStyles },
  { rel: "stylesheet", href: rglResize },
  { rel: "stylesheet", href: dashboard },
];

export async function loader({ request }: LoaderFunctionArgs) {
  // An unmatched /dashboard/api/* path is a wrong or removed endpoint — fail
  // fast with a 404 instead of serving 200 HTML that breaks a JSON caller.
  if (new URL(request.url).pathname.startsWith("/dashboard/api/")) {
    throw new Response("Not found", { status: 404 });
  }
  const session = await requireVerifiedSession(request);
  const { data } = await getSupabase()
    .from("shops")
    .select("display_name, shop_domain")
    .eq("id", session.shopId)
    .maybeSingle();
  const storeLabel =
    (data?.display_name as string | null) ||
    (data?.shop_domain as string | null) ||
    "Your store";
  return { shopDomain: session.shopDomain, storeLabel };
}

export default function DashboardRoute() {
  const { shopDomain, storeLabel } = useLoaderData<typeof loader>();
  // Class boundary catches client-side render throws in the SPA subtree
  // (e.g. a partial poll row reaching `.toFixed`) and recovers in place.
  return (
    <DashboardErrorBoundary>
      <DashboardApp shopDomain={shopDomain} storeLabel={storeLabel} />
    </DashboardErrorBoundary>
  );
}

// Remix route boundary: catches loader throws and SSR render errors — the
// server-side counterpart to the in-tree class boundary above. Without either,
// the whole SPA fell through to Remix's bare "Application error".
export function ErrorBoundary() {
  const error = useRouteError();
  return <DashboardErrorFallback error={error} />;
}
