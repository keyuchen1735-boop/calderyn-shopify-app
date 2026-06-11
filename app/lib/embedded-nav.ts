// Embedded-app navigation that survives full-document reloads.
//
// Client-side navigation strips the `shop`/`host`/`embedded` params Shopify
// puts on the initial iframe URL. That's normally fine — until Remix falls
// back to a document navigation (e.g. the deployed build changed under an
// open tab and /__manifest returns 204). A document request without those
// params can't be authenticated, so the merchant lands on the login screen
// inside the admin iframe ("accounts.shopify.com refused to connect").
//
// Keeping the params on every in-app URL lets authenticate.admin serve its
// App Bridge bounce page on document requests, which re-mints a session
// token and retries — the reload self-heals instead of bouncing to login.

import { useCallback } from "react";
import { useNavigate, useRouteLoaderData } from "@remix-run/react";

type NavigateOptions = {
  replace?: boolean;
  state?: unknown;
  preventScrollReset?: boolean;
};

export type EmbeddedParams = { shop: string | null; host: string | null };

// Sticky module-level copy: loader data can lose `host` on revalidations
// whose request URL lacked it, so remember the last non-null values seen.
const cached: EmbeddedParams = { shop: null, host: null };

export function rememberEmbeddedParams(p: Partial<EmbeddedParams>): void {
  if (p.shop) cached.shop = p.shop;
  if (p.host) cached.host = p.host;
}

/** Append shop/host/embedded=1 to an internal path, keeping its own params. */
export function appendEmbeddedSearch(to: string, p: EmbeddedParams): string {
  if (!to.startsWith("/")) return to;
  if (!p.shop && !p.host) return to;
  const hashIdx = to.indexOf("#");
  const hash = hashIdx === -1 ? "" : to.slice(hashIdx);
  const base = hashIdx === -1 ? to : to.slice(0, hashIdx);
  const [path, search = ""] = splitSearch(base);
  const sp = new URLSearchParams(search);
  if (p.shop && !sp.has("shop")) sp.set("shop", p.shop);
  if (p.host && !sp.has("host")) sp.set("host", p.host);
  if (!sp.has("embedded")) sp.set("embedded", "1");
  return `${path}?${sp.toString()}${hash}`;
}

function splitSearch(to: string): [string, string] {
  const q = to.indexOf("?");
  return q === -1 ? [to, ""] : [to.slice(0, q), to.slice(q + 1)];
}

/**
 * Drop-in replacement for useNavigate() inside /app routes. String targets
 * get the embedded params appended; numeric (history) deltas pass through.
 */
export function useEmbeddedNavigate() {
  const navigate = useNavigate();
  const data = useRouteLoaderData("routes/app") as Partial<EmbeddedParams> | undefined;
  if (data) rememberEmbeddedParams(data);
  return useCallback(
    (to: string | number, options?: NavigateOptions) => {
      if (typeof to === "number") return navigate(to);
      return navigate(appendEmbeddedSearch(to, cached), options);
    },
    [navigate],
  );
}
