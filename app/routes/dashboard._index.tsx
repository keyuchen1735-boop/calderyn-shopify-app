// app/routes/dashboard._index.tsx
// The merchant dashboard SPA. Auth-gated by the loader (redirects to
// /dashboard/login when unauthenticated); the client fetches all data on mount
// so no server-only module leaks into the browser bundle.
import type { LoaderFunctionArgs, LinksFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { getSessionOrRedirect } from "~/lib/dashboard/session.server";
import DashboardApp from "~/components/dashboard/DashboardApp";

import dashboardUtils from "~/styles/dashboard-utils.css?url";
import dashboard from "~/styles/dashboard.css?url";

// Utils first so the cd-* rules in dashboard.css can override the utility layer.
export const links: LinksFunction = () => [
  { rel: "stylesheet", href: dashboardUtils },
  { rel: "stylesheet", href: dashboard },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await getSessionOrRedirect(request);
  return { shopDomain: session.shopDomain };
}

export default function DashboardRoute() {
  const { shopDomain } = useLoaderData<typeof loader>();
  return <DashboardApp shopDomain={shopDomain} />;
}
