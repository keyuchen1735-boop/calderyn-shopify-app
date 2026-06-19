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

import { useCallback, useEffect } from "react";
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
 * Given the iframe's current absolute URL, return a corrected URL carrying the
 * embedded params, or null when nothing is missing. Pure (unit-tested); the
 * hook below applies the result via history.replaceState.
 *
 * `embedded=1` is only asserted when we actually have a shop/host to
 * authenticate with — we never brand a shop-less URL as embedded.
 */
export function ensureEmbeddedUrl(href: string, p: EmbeddedParams): string | null {
  const url = new URL(href);
  const sp = url.searchParams;
  let changed = false;
  if (p.shop && !sp.has("shop")) {
    sp.set("shop", p.shop);
    changed = true;
  }
  if (p.host && !sp.has("host")) {
    sp.set("host", p.host);
    changed = true;
  }
  if ((p.shop || p.host) && !sp.has("embedded")) {
    sp.set("embedded", "1");
    changed = true;
  }
  return changed ? url.toString() : null;
}

/**
 * Keep shop/host/embedded on the iframe's address bar for the whole session.
 *
 * App Bridge rewrites window.location to the bare path on client navigations,
 * dropping the params Shopify seeded the iframe with. A later document reload
 * (deploy-under-open-tab → /__manifest 204) OR a focus-triggered revalidate()
 * then re-requests that param-less URL, which authenticate.admin can't bounce
 * through App Bridge — so it 302s to /auth/login and the bare login form lands
 * inside the admin iframe. Re-stocking the params after every render means any
 * such reload/revalidation carries shop context and self-heals instead.
 *
 * replaceState only edits the URL (no navigation, no reload), so it can't loop
 * and doesn't disturb React Router. Client-only; standalone (non-iframe) loads
 * manage their own URL and are left untouched.
 */
export function useKeepEmbeddedUrl(p: EmbeddedParams): void {
  rememberEmbeddedParams(p);
  // No dependency array on purpose: App Bridge can strip the params on a
  // navigation that doesn't change React Router's location, so we re-check the
  // real window.location after every commit. The change-guard makes it a no-op
  // once the URL is correct.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.top === window.self) return; // not embedded — leave the URL alone
    const next = ensureEmbeddedUrl(window.location.href, cached);
    if (next) window.history.replaceState(window.history.state, "", next);
  });
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
