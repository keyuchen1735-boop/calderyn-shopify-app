import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useMatches,
  useRouteError,
} from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { randomBytes } from "node:crypto";

import { DashboardErrorFallback } from "~/components/dashboard/ErrorBoundary";

export function loader({ request }: LoaderFunctionArgs) {
  const pathname = new URL(request.url).pathname;
  const needsNonce = pathname.startsWith("/storefront/checkout") ||
    /^\/storefront\/account\/cards\/?$/.test(pathname);
  return json({ nonce: needsNonce ? randomBytes(18).toString("base64url") : null });
}

function DocumentScripts({ restoreScroll = false }: { restoreScroll?: boolean }) {
  const matches = useMatches();
  let nonce: string | undefined;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const data = matches[index].data;
    if (data !== null && typeof data === "object" && typeof (data as { nonce?: unknown }).nonce === "string") {
      nonce = (data as { nonce: string }).nonce;
      break;
    }
  }
  return (
    <>
      {restoreScroll ? <ScrollRestoration nonce={nonce} /> : null}
      <Scripts nonce={nonce} />
    </>
  );
}

export default function App() {
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <DocumentScripts restoreScroll />
      </body>
    </html>
  );
}

// Ultimate backstop: any error from a route without its own boundary (or from
// the root itself) renders a recoverable page inside a valid document instead of
// Remix's bare default. The embedded Shopify app (app.tsx) keeps its own
// boundary; this catches everything else.
export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <title>Something went wrong</title>
        <Meta />
        <Links />
      </head>
      <body>
        <DashboardErrorFallback error={error} />
        <DocumentScripts />
      </body>
    </html>
  );
}
