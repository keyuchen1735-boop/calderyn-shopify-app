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

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  DashboardErrorBoundary,
  DashboardErrorFallback,
} from "../ErrorBoundary";

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
});
