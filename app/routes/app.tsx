import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import assistantStyles from "../components/Assistant/assistant.css?url";
import { AssistantSlideout } from "../components/Assistant/AssistantSlideout";
import { authenticate } from "../shopify.server";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: assistantStyles },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Dashboard
        </Link>
        <Link to="/app/alerts">Alerts</Link>
        <Link to="/app/analytics">Analytics</Link>
        <Link to="/app/audit">Audit log</Link>
        <Link to="/app/campaigns">Campaigns</Link>
        <Link to="/app/skus">SKUs</Link>
        <Link to="/app/simulator">Simulator</Link>
        <Link to="/app/settings">Settings</Link>
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
