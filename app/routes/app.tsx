import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import assistantStyles from "../components/Assistant/assistant.css?url";
import calderynStyles from "../components/calderyn/calderyn.css?url";
import { AssistantSlideout } from "../components/Assistant/AssistantSlideout";
import { appendEmbeddedSearch, rememberEmbeddedParams } from "../lib/embedded-nav";
import { authenticate } from "../shopify.server";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: assistantStyles },
  { rel: "stylesheet", href: calderynStyles },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  // shop/host are re-appended to every in-app URL (useEmbeddedNavigate) so
  // document-level reloads can re-authenticate instead of hitting /auth/login.
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    shop: session.shop,
    host: url.searchParams.get("host"),
  };
};

export default function App() {
  const { apiKey, shop, host } = useLoaderData<typeof loader>();
  rememberEmbeddedParams({ shop, host });
  const withParams = (to: string) => appendEmbeddedSearch(to, { shop, host });

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to={withParams("/app")} rel="home">
          Dashboard
        </Link>
        <Link to={withParams("/app/alerts")}>Alerts</Link>
        <Link to={withParams("/app/analytics")}>Analytics</Link>
        <Link to={withParams("/app/audit")}>Audit log</Link>
        <Link to={withParams("/app/campaigns")}>Campaigns</Link>
        <Link to={withParams("/app/skus")}>SKUs</Link>
        <Link to={withParams("/app/screener")}>Ad Pre-Screen</Link>
        <Link to={withParams("/app/settings")}>Settings</Link>
        <Link to={withParams("/app/mcp")}>Claude connections</Link>
      </NavMenu>
      <Outlet />
      <AssistantSlideout />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses to bubble auth errors
// up to the App Bridge. This boundary handles that.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
