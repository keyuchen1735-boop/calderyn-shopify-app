import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { McpConnectGuide } from "../McpConnectGuide";
import { MCP_CONNECTOR_URL, CLI_COMMAND } from "~/lib/mcp-connect-guide";

function render(props: Record<string, unknown> = {}): string {
  return renderToString(
    createElement(AppProvider, { i18n: en }, createElement(McpConnectGuide, props)),
  );
}

describe("McpConnectGuide (embedded)", () => {
  it("renders the hero, both tabs, and the connector steps + URL by default", () => {
    const html = render();
    expect(html).toContain("Calderyn MCP for Claude");
    expect(html).toContain("Claude.ai connector");
    expect(html).toContain("Claude Code (CLI)");
    expect(html).toContain("Open Claude settings");
    expect(html).toContain("Add the Calderyn connector");
    expect(html).toContain(MCP_CONNECTOR_URL);
    expect(html).not.toContain(CLI_COMMAND);
  });

  it("renders the CLI command (not the steps) when the cli tab is active", () => {
    const html = render({ initialTab: "cli" });
    expect(html).toContain(CLI_COMMAND);
    expect(html).not.toContain("Open Claude settings");
  });

  it("shows the manage-connections link when onManage is provided", () => {
    const html = render({ onManage: () => {} });
    expect(html).toContain("Manage access keys");
  });
});
