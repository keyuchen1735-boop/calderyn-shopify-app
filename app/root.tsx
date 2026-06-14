import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from "@remix-run/react";

import { DashboardErrorFallback } from "~/components/dashboard/ErrorBoundary";

export default function App() {
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
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
        <ScrollRestoration />
        <Scripts />
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
        <title>Something went wrong</title>
        <Meta />
        <Links />
      </head>
      <body>
        <DashboardErrorFallback error={error} />
        <Scripts />
      </body>
    </html>
  );
}
