import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { McpConnectCards } from "../McpConnectCards";

function render(props: Record<string, unknown> = {}): string {
  return renderToString(
    createElement(AppProvider, { i18n: en }, createElement(McpConnectCards, props)),
  );
}

describe("McpConnectCards (slimmed to a link)", () => {
  it("renders a slim 'set up' banner pointing to Settings, not the old install cards", () => {
    const html = render({ onSetup: () => {} });
    expect(html).toContain("Set up the Claude connector");
    expect(html).toContain("Settings");
    // the old two install cards are gone
    expect(html).not.toContain("Connect via bearer token");
    expect(html).not.toContain("calderyn-mcp.vercel.app");
  });
});
