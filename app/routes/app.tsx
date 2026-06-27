import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import {
  Link,
  Outlet,
  useLoaderData,
  useRevalidator,
  useRouteError,
} from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import assistantStyles from "../components/Assistant/assistant.css?url";
import bugReportStyles from "../components/BugReport/bug-report.css?url";
import calderynStyles from "../components/calderyn/calderyn.css?url";
import { AssistantSlideout } from "../components/Assistant/AssistantSlideout";
import { BugReportButton } from "../components/BugReport/BugReportButton";
import { appendEmbeddedSearch, useKeepEmbeddedUrl } from "../lib/embedded-nav";
import { useRefreshOnFocus } from "../lib/use-refresh-on-focus";
import { adminDeepLinkRedirect } from "../lib/admin-deeplink.server";
import { authenticate } from "../shopify.server";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: assistantStyles },
  { rel: "stylesheet", href: bugReportStyles },
  { rel: "stylesheet", href: calderynStyles },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  let session;
  try {
    ({ session } = await authenticate.admin(request));
  } catch (thrown) {
    // Unauthenticated hit on an alert confirm_url: send it to the Shopify
    // admin deep link (which survives login) instead of the bare login page.
    throw (await adminDeepLinkRedirect(request, thrown)) ?? thrown;
  }
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
  // Keep shop/host on the iframe URL so document reloads and focus-revalidations
  // re-authenticate instead of bouncing to the bare /auth/login form.
  useKeepEmbeddedUrl({ shop, host });
  const withParams = (to: string) => appendEmbeddedSearch(to, { shop, host });

  // Quietly revalidate the current screen's loader when the merchant returns to
  // the tab, so they never look at stale data. revalidate() re-runs in place —
  // no full reload. Throttled by the hook's cooldown.
  const { revalidate } = useRevalidator();
  useRefreshOnFocus(revalidate);

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to={withParams("/app")} rel="home">
          Dashboard
        </Link>
        <Link to={withParams("/app/alerts")}>Alerts</Link>
        <Link to={withParams("/app/queue")}>Action Queue</Link>
        <Link to={withParams("/app/analytics")}>Analytics</Link>
        <Link to={withParams("/app/audit")}>Action history</Link>
        <Link to={withParams("/app/campaigns")}>Campaigns</Link>
        <Link to={withParams("/app/skus")}>Inventory</Link>
        <Link to={withParams("/app/screener")}>Creative Predictor</Link>
        <Link to={withParams("/app/generator")}>Ad Generator</Link>
        <Link to={withParams("/app/settings")}>Settings</Link>
        <Link to={withParams("/app/mcp")}>Claude connections</Link>
      </NavMenu>
      <Outlet />
      <AssistantSlideout />
      <BugReportButton />
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
