// The dashboard SPA had no error boundary anywhere in its tree, so any render
// throw (e.g. a partial API row hitting `.toFixed`) bubbled to Remix's bare
// "Application error" page. This boundary catches render errors in the dashboard
// subtree and shows a friendly, recoverable fallback instead.
//
// The repo's test env is node (not jsdom), and legacy renderToString re-throws
// child errors rather than recovering through a boundary — so the catch is
// verified via React's documented error-boundary contract
// (getDerivedStateFromError) plus rendering the fallback from the derived state,
// which is exactly what the boundary's render does in the browser.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import {
  DashboardErrorBoundary,
  DashboardErrorFallback,
  autoReloadForStaleDeploy,
  errorPageTitle,
  isStaleChunkError,
} from "../ErrorBoundary";

// isRouteErrorResponse duck-types on these fields, so a plain object stands in
// for a thrown 404 Response the way the router would surface it.
const NOT_FOUND = {
  status: 404,
  statusText: "Not Found",
  internal: false,
  data: "route data that must never render",
};

describe("DashboardErrorBoundary", () => {
  it("turns a thrown error into fallback state and renders the fallback", () => {
    const state = DashboardErrorBoundary.getDerivedStateFromError(
      new Error("render exploded"),
    );
    expect(state.error).toBeInstanceOf(Error);

    const html = renderToString(
      createElement(DashboardErrorFallback, { error: state.error }),
    );
    expect(html).toContain("Something went wrong");
    expect(html.toLowerCase()).toContain("reload");
  });

  it("renders children normally when nothing throws", () => {
    const html = renderToString(
      createElement(
        DashboardErrorBoundary,
        null,
        createElement("p", null, "all good"),
      ),
    );
    expect(html).toContain("all good");
    expect(html).not.toContain("Something went wrong");
  });

  it("fallback offers a reload affordance", () => {
    const html = renderToString(createElement(DashboardErrorFallback));
    expect(html).toContain("Something went wrong");
    expect(html.toLowerCase()).toContain("reload");
  });

  it("fallback offers in-place retry when the boundary can recover", () => {
    const html = renderToString(
      createElement(DashboardErrorFallback, {
        error: new Error("render exploded"),
        onRetry: () => {},
      }),
    );
    expect(html).toContain("Try again");
    expect(html).not.toContain("Reload");
  });

  it("clears a caught error on back/forward navigation so the SPA recovers", () => {
    // The self-driven SPA unmounts its own popstate handler when the fallback
    // shows, so the boundary must reset itself on navigation. Drive the
    // instance the way React would: derive error state, then fire popstate.
    const boundary = new DashboardErrorBoundary({});
    boundary.state = DashboardErrorBoundary.getDerivedStateFromError(
      new Error("render exploded"),
    );
    const patched: { error?: Error | null } = {};
    // Stub React's setState so we can observe the reset without a renderer.
    (boundary as unknown as { setState: (u: { error: null }) => void }).setState =
      (update) => Object.assign(patched, update);

    boundary.handlePopState();
    expect(patched.error).toBeNull();
  });

  it("retry clears the error, but a crash right after a retry downgrades to Reload", () => {
    const boundary = new DashboardErrorBoundary({});
    boundary.state = DashboardErrorBoundary.getDerivedStateFromError(
      new Error("render exploded"),
    );
    const patched: { error?: Error | null } = {};
    (boundary as unknown as { setState: (u: { error: null }) => void }).setState =
      (update) => Object.assign(patched, update);

    // First crash: retry is offered.
    const first = boundary.render();
    expect(isValidElement(first)).toBe(true);
    expect(
      (first as ReactElement<{ onRetry?: unknown }>).props.onRetry,
    ).toBeTypeOf("function");

    // Retrying resets the boundary...
    boundary.handleRetry();
    expect(patched.error).toBeNull();

    // ...but if the subtree crashes again immediately (deterministic error),
    // the fallback must not offer a retry loop.
    boundary.state = DashboardErrorBoundary.getDerivedStateFromError(
      new Error("render exploded again"),
    );
    const second = boundary.render();
    expect(
      (second as ReactElement<{ onRetry?: unknown }>).props.onRetry,
    ).toBeUndefined();
  });
});

describe("error variants", () => {
  it("detects stale-deploy chunk errors across browser message shapes", () => {
    const positives = [
      new TypeError(
        "Failed to fetch dynamically imported module: https://app.example.com/assets/Home-CX2ab1.js",
      ),
      new TypeError("error loading dynamically imported module"),
      new TypeError("Importing a module script failed."),
      new Error("Loading chunk 42 failed."),
      Object.assign(new Error("timeout"), { name: "ChunkLoadError" }),
    ];
    for (const err of positives) expect(isStaleChunkError(err)).toBe(true);

    expect(isStaleChunkError(new Error("boom"))).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
    expect(isStaleChunkError(NOT_FOUND)).toBe(false);
  });

  it("renders refresh guidance for a stale-deploy error instead of a crash card", () => {
    const html = renderToString(
      createElement(DashboardErrorFallback, {
        error: new TypeError(
          "Failed to fetch dynamically imported module: https://app.example.com/assets/Orders-9f1c.js",
        ),
      }),
    );
    expect(html).toContain("A quick refresh is needed");
    expect(html).toContain("Refresh");
    expect(html).not.toContain("Something went wrong");
  });

  it("renders a page-not-found card for 404 route errors", () => {
    const html = renderToString(
      createElement(DashboardErrorFallback, { error: NOT_FOUND }),
    );
    expect(html).toContain("Page not found");
    expect(html).toContain("Back to home");
    expect(html.toLowerCase()).not.toContain("reload");
    // Never render server-provided error data to end users.
    expect(html).not.toContain("route data that must never render");
  });

  it("picks the document title to match the variant", () => {
    expect(errorPageTitle(NOT_FOUND)).toBe("Page not found");
    expect(errorPageTitle(new Error("boom"))).toBe("Something went wrong");
    expect(errorPageTitle(undefined)).toBe("Something went wrong");
  });
});

describe("autoReloadForStaleDeploy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubWindow(store: Map<string, string>, reload: () => void) {
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
      location: { reload },
    });
  }

  it("reloads once, then the guard blocks a second reload inside the window", () => {
    const store = new Map<string, string>();
    const reload = vi.fn();
    stubWindow(store, reload);

    expect(autoReloadForStaleDeploy()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    // Same tab, right after the reload: guard must refuse (no reload loop).
    expect(autoReloadForStaleDeploy()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("fails closed when sessionStorage is unavailable (no unguarded reloads)", () => {
    const reload = vi.fn();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: () => {
          throw new Error("storage disabled");
        },
        setItem: () => {
          throw new Error("storage disabled");
        },
      },
      location: { reload },
    });

    expect(autoReloadForStaleDeploy()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("is a no-op on the server", () => {
    expect(autoReloadForStaleDeploy()).toBe(false);
  });
});
