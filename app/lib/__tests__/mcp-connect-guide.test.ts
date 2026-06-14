import { describe, it, expect } from "vitest";
import {
  MCP_CONNECTOR_URL,
  MCP_CONNECTOR_NAME,
  GUIDE_TABS,
  CONNECTOR_STEPS,
  CLI_COMMAND,
  CLI_NOTE,
} from "../mcp-connect-guide";

describe("mcp-connect-guide content", () => {
  it("exposes the live MCP connector URL and name", () => {
    expect(MCP_CONNECTOR_URL).toBe("https://calderyn-mcp.vercel.app/mcp");
    expect(MCP_CONNECTOR_NAME).toBe("Calderyn");
  });

  it("has exactly the two tabs", () => {
    expect(GUIDE_TABS.map((t) => t.id)).toEqual(["connector", "cli"]);
    expect(GUIDE_TABS.every((t) => t.label.length > 0)).toBe(true);
  });

  it("has 3 connector steps numbered 1..3 with distinct icons and non-empty copy", () => {
    expect(CONNECTOR_STEPS).toHaveLength(3);
    expect(CONNECTOR_STEPS.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(new Set(CONNECTOR_STEPS.map((s) => s.icon)).size).toBe(3);
    for (const s of CONNECTOR_STEPS) {
      expect(s.title.trim().length).toBeGreaterThan(0);
      expect(s.body.trim().length).toBeGreaterThan(0);
    }
  });

  it("CLI command adds the MCP server over http and references the URL", () => {
    expect(CLI_COMMAND.startsWith("claude mcp add")).toBe(true);
    expect(CLI_COMMAND).toContain("--transport http");
    expect(CLI_COMMAND).toContain(MCP_CONNECTOR_URL);
  });

  it("CLI note points to the bearer-token path", () => {
    expect(CLI_NOTE).toContain("Bearer");
  });
});
