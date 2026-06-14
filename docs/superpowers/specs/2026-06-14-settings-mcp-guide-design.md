# Settings → "Claude connector" MCP install guide (both surfaces)

**Date:** 2026-06-14
**Branch:** `feat/settings-mcp-guide` (worktree)
**Reference:** the Higgsfield "MCP for any AI" layout (hero + numbered step flow), re-skinned in Calderyn's identity.

## Problem / goal

A merchant who wants Claude to read their store has to discover the connector URL and figure out the
Claude.ai connector flow themselves. Today the only install UI is a minimal 2-card `McpConnectCards`
buried on the `/app/mcp` "Claude connections" page (embedded only). We want a clear, branded,
**step-by-step install guide** as a **"Claude connector" section under Settings on both surfaces**
(embedded extension + web dashboard), styled like the reference but in Calderyn's brand accent — deep
teal `#24556E` / `var(--accent)` + the hexagon mark. (NOT purple — `#5b3df5` is only a standalone-login
link color; the real brand accent is the teal hexagon.)

## Confirmed scope decisions

- **Placement:** a new "Claude connector" section under **Settings** on both surfaces. Keep `/app/mcp`
  for key/connection management.
- **Tabs:** two — **"Claude.ai connector"** (the 3-step OAuth stepper) and **"Claude Code (CLI)"**
  (the `claude mcp add` command). No other AI clients (no Cursor/etc.).
- **`/app/mcp`:** slim the now-redundant `McpConnectCards` down to a one-line link up to the Settings
  guide (one canonical guide, not two install UIs).
- **Connector URL:** `https://calderyn-mcp.vercel.app/mcp` (matches the shipping `McpConnectCards`).

## Architecture — one content source, two renderers

Per the dashboard-parity rule (match the contract, not the code): the *content* is identical on both
surfaces; only the *rendering* differs (Polaris on embedded, `cd-*` primitives on the dashboard).

### 1. `app/lib/mcp-connect-guide.ts` (pure, isomorphic — single source of truth)

```ts
export const MCP_CONNECTOR_URL = "https://calderyn-mcp.vercel.app/mcp";
export const MCP_CONNECTOR_NAME = "Calderyn";

export type GuideTab = "connector" | "cli";
export const GUIDE_TABS: ReadonlyArray<{ id: GuideTab; label: string }> = [
  { id: "connector", label: "Claude.ai connector" },
  { id: "cli", label: "Claude Code (CLI)" },
];

export type GuideIcon = "settings" | "connector" | "signin";
export type GuideStep = { n: 1 | 2 | 3; icon: GuideIcon; title: string; body: string };

export const CONNECTOR_STEPS: ReadonlyArray<GuideStep> = [
  { n: 1, icon: "settings", title: "Open Claude settings",
    body: "In Claude.ai (or the desktop app), go to Settings → Connectors." },
  { n: 2, icon: "connector", title: "Add the Calderyn connector",
    body: "Click Add custom connector, name it “Calderyn”, and paste the URL below." },
  { n: 3, icon: "signin", title: "Connect & sign in",
    body: "Click Add → Connect, then sign in with your Shopify store. Claude can now read your alerts, campaigns, SKUs, and audit log." },
];

export const CLI_COMMAND = `claude mcp add --transport http calderyn ${MCP_CONNECTOR_URL}`;
export const CLI_NOTE =
  "Prefer a token over OAuth? Generate an access key under Claude connections and add --header \"Authorization: Bearer cala_…\".";
```

The abstract `GuideIcon` keys are mapped to surface-native icons by each renderer (so the content
module stays presentation-free).

### 2. Embedded renderer — `app/components/McpConnectGuide.tsx` (Polaris)

Slots into `app/routes/app.settings.tsx` as a new `Layout.AnnotatedSection` titled **"Claude connector"**,
placed after the "Integrations" section. Structure:
- **Hero:** a brand `Box` (inline accent background `#24556E` + subtle wash, white text/mark) holding the Calderyn
  hexagon mark + "Calderyn MCP for Claude" + a one-line tagline. (Pragmatic non-token background — this
  is a branded hero, like the reference; the rest of the component uses Polaris tokens.)
- **Tabs:** Polaris `Tabs` (or a segmented control) bound to `useState<GuideTab>("connector")`.
- **connector tab:** the 3 `CONNECTOR_STEPS` as a numbered layout — a circular `n` badge + a per-step
  Polaris icon (`settings`→Settings, `connector`→Plug/Link, `signin`→Key/Check) + title + body; step 2
  includes a read-only `TextField` showing `MCP_CONNECTOR_URL` + a **Copy** button.
- **cli tab:** a monospaced `TextField` (readOnly) showing `CLI_COMMAND` + Copy, and `CLI_NOTE` as
  subdued text.
- Footer link: "Manage access keys & connected workspaces →" navigating to `/app/mcp`.

Icon mapping lives in this file (`Record<GuideIcon, IconSource>`), not in the shared module.

### 3. Dashboard renderer — `app/components/dashboard/McpGuide.tsx` (`cd-*` primitives)

Rendered as a new `<section>` titled **"Claude connector"** in
`app/components/dashboard/screens/Settings.tsx`, placed after the "Connections" section. Same content,
dashboard look:
- **Hero:** a `cd-card` with a brand wash using `var(--accent)` / `var(--accent-bg)` + the hexagon SVG
  (reuse the `cd-logo-mark` markup from `DashboardApp.tsx`) + headline + tagline.
- **Tabs:** a small `cd-*` segmented/tab control bound to `useState<GuideTab>("connector")`.
- **connector tab:** the same 3 steps with numbered badges + dashboard `icons.tsx` glyphs; step 2 shows
  the URL in a `cd` code chip + a Copy button.
- **cli tab:** the `CLI_COMMAND` in a `cd` code block + Copy + the `CLI_NOTE`.
- Footer note: key/connection management lives in the embedded Shopify app (the dashboard is read-only
  for connections today, per the existing Settings "Connections" note).

### 4. `/app/mcp` slim-down

Replace the 2-card `<McpConnectCards />` usage on `app/routes/app.mcp.tsx` with a single slim
"Set up the connector → Settings" link/banner (one canonical guide). `McpConnectCards.tsx` is either
repurposed into that slim link component or deleted with the link inlined — plan decides; either way the
old two install cards go away.

## Visual translation (Higgsfield → Calderyn)

| Higgsfield | Calderyn |
|---|---|
| Lime hero, stacked app icons | **Teal `#24556E`** hero, Calderyn hexagon + "Calderyn MCP for Claude" |
| MCP / CLI / Skill + client tabs | 2 tabs: **Claude.ai connector**, **Claude Code (CLI)** |
| 3 numbered steps w/ URL chip + copy | 3 numbered steps w/ per-step icon, URL chip + **Copy** |
| "better to use the CLI" callout | the **CLI tab** itself |

Graphic elements: numbered circular step badges, a per-step icon (⚙ → 🔌 → ✓), the URL/command chip
with one-click copy, brand-teal (`#24556E`) hero with the hexagon. On-brand, identical content both sides.

## Testing (TDD: red → green)

**Unit — `app/lib/__tests__/mcp-connect-guide.test.ts`:**
- `MCP_CONNECTOR_URL` is the expected https URL; `CONNECTOR_STEPS` has exactly 3 steps with `n` 1..3 and
  the three distinct `icon` keys; every step has non-empty `title`/`body`; `CLI_COMMAND` contains
  `MCP_CONNECTOR_URL` and starts with `claude mcp add`; `GUIDE_TABS` has the two ids.

**Render-smoke — embedded (`renderToString`, node env, per `onboarding-ui.test.ts`):**
- Renders the hero headline, all 3 step titles, the connector URL, a Copy affordance, both tab labels.
- With the cli tab active, renders `CLI_COMMAND` and not the step list; default (connector) tab renders
  the steps and the URL, not the raw CLI command.
- Renders the "/app/mcp" management link.

**Render-smoke — dashboard (`renderToString`):**
- Hero + 3 step titles + URL + Copy + both tabs; cli-tab swap shows `CLI_COMMAND`.

**Regression:** existing `app.settings.tsx` and dashboard `Settings.tsx` tests (if any) still pass; the
`/app/mcp` slim-down keeps `app-mcp` / connection tests green.

## Out of scope / non-goals

- No other AI clients (Cursor/OpenClaw/Hermes) — Claude + Claude Code only.
- No connector/OAuth backend changes — the MCP server, `/oauth/*`, and `/app/connect` are all live.
- No redesign of `/app/mcp` key management beyond removing the old install cards.
- No new connector URL — document the existing `calderyn-mcp.vercel.app/mcp`.

## Pre-commit gate (CLAUDE.md)

`/code-review` → patch sanity → `npm run typecheck` → `npm run lint` (`--max-warnings=0` on touched
files) → `npm run build` → `npm test`. No `.graphql`/schema/migration changes → codegen/prisma steps N/A.
