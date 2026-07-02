import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router";
import { EmbeddedAppProvider } from "../../components/EmbeddedAppProvider";
import { ActionList, Button } from "@shopify/polaris";

// Characterization tests for why the "Open web dashboard" header action
// (app._index) uses window.open instead of Polaris `url`/`external`/`target`.
// Polaris loses the new-tab intent at two independent layers in embedded apps;
// if either test below starts FAILING, upstream fixed its layer and the action
// can be simplified back to a plain url + external descriptor.
const DASHBOARD_URL =
  "https://calderyncompany.com/dashboard/login?shop=acme.myshopify.com";

function render(children: ReturnType<typeof h>) {
  return renderToString(
    h(
      StaticRouter,
      { location: "/app" },
      // `embedded` only toggles the app-bridge <script>; the Polaris link
      // shim is injected unconditionally, which is what these tests exercise.
      h(EmbeddedAppProvider, { embedded: false, apiKey: "test-key" }, children),
    ),
  );
}

describe("Polaris external-link gaps behind the embedded link shim", () => {
  it("layer 1: the AppProvider link shim drops `external` (no target on the anchor)", () => {
    const html = render(
      h(Button, { url: DASHBOARD_URL, external: true }, "Open web dashboard"),
    );
    expect(html).toContain("href=");
    expect(html).not.toContain("_blank");
  });

  it("layer 2: the action-rollup menu drops `target` (narrow-viewport path)", () => {
    const html = render(
      h(ActionList, {
        items: [
          {
            content: "Open web dashboard",
            url: DASHBOARD_URL,
            external: true,
            target: "_blank" as const,
          },
        ],
      }),
    );
    expect(html).toContain("href=");
    expect(html).not.toContain("_blank");
  });
});
