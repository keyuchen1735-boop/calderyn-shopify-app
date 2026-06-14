// app/lib/mcp-connect-guide.ts
//
// Single source of truth for the "Claude connector" install guide rendered on
// BOTH surfaces (embedded Polaris + dashboard cd-*). Content only — no
// presentation. Each surface maps the abstract GuideIcon keys to its own icons.

export const MCP_CONNECTOR_URL = "https://calderyn-mcp.vercel.app/mcp";

export type GuideTab = "connector" | "cli";

export const GUIDE_TABS: ReadonlyArray<{ id: GuideTab; label: string }> = [
  { id: "connector", label: "Claude.ai connector" },
  { id: "cli", label: "Claude Code (CLI)" },
];

export type GuideIcon = "settings" | "connector" | "signin";

export interface GuideStep {
  n: 1 | 2 | 3;
  icon: GuideIcon;
  title: string;
  body: string;
}

export const CONNECTOR_STEPS: ReadonlyArray<GuideStep> = [
  {
    n: 1,
    icon: "settings",
    title: "Open Claude settings",
    body: "In Claude.ai (or the desktop app), go to Settings → Connectors.",
  },
  {
    n: 2,
    icon: "connector",
    title: "Add the Calderyn connector",
    body: "Click Add custom connector, name it “Calderyn”, and paste the URL below.",
  },
  {
    n: 3,
    icon: "signin",
    title: "Connect and sign in",
    body: "Click Add → Connect, then sign in with your Shopify store. Claude can now read your alerts, campaigns, SKUs, and audit log.",
  },
];

export const CLI_COMMAND = `claude mcp add --transport http calderyn ${MCP_CONNECTOR_URL}`;

export const CLI_NOTE =
  "Prefer a token over OAuth? Generate an access key under Claude connections and add --header \"Authorization: Bearer cala_…\".";
