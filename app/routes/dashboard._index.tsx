// app/routes/dashboard._index.tsx
// The merchant dashboard SPA. Auth-gated by the loader (redirects to
// /dashboard/login when unauthenticated); the client fetches all data on mount
// so no server-only module leaks into the browser bundle.
import type { LoaderFunctionArgs, LinksFunction } from "@remix-run/node";
import { useLoaderData, useRouteError } from "@remix-run/react";

import { getSessionOrRedirect } from "~/lib/dashboard/session.server";
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
  const session = await getSessionOrRedirect(request);
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
