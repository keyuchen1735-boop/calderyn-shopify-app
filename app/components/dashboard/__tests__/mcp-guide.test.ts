import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { McpGuide } from "../McpGuide";
import { MCP_CONNECTOR_URL, CLI_COMMAND } from "~/lib/mcp-connect-guide";

function render(props: Record<string, unknown> = {}): string {
  return renderToString(createElement(McpGuide, props));
}

describe("dashboard McpGuide", () => {
  it("renders hero, both tabs, connector steps + URL by default", () => {
    const html = render();
    expect(html).toContain("Calderyn MCP for Claude");
    expect(html).toContain("Claude.ai connector");
    expect(html).toContain("Claude Code (CLI)");
    expect(html).toContain("Open Claude settings");
    expect(html).toContain(MCP_CONNECTOR_URL);
    expect(html).not.toContain(CLI_COMMAND);
  });

  it("renders the CLI command (not the steps) when the cli tab is active", () => {
    const html = render({ initialTab: "cli" });
    expect(html).toContain(CLI_COMMAND);
    expect(html).not.toContain("Open Claude settings");
  });
});
