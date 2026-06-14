# Settings "Claude connector" MCP guide — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a branded, Higgsfield-style "Claude connector" install guide as a new Settings section on both surfaces (embedded Polaris + web dashboard), driven by one shared content module.

**Architecture:** One isomorphic content module (`mcp-connect-guide.ts`) is rendered twice — a Polaris `McpConnectGuide` (embedded) and a `cd-*` `McpGuide` (dashboard) — plus a shared `CalderynHexMark` SVG. The old `/app/mcp` install cards shrink to a link. Brand accent is **teal `#24556E` / `var(--accent)`** (the hexagon mark), NOT purple.

**Tech Stack:** Remix + Shopify Polaris (+ `@shopify/polaris-icons`) embedded; bespoke `cd-*` React + CSS on the dashboard; Vitest (node env, `renderToString` for component smoke tests).

**Spec:** `docs/superpowers/specs/2026-06-14-settings-mcp-guide-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `app/lib/mcp-connect-guide.ts` (create) | Shared content: URL, name, tabs, 3 steps, CLI command + note. No presentation. |
| `app/lib/__tests__/mcp-connect-guide.test.ts` (create) | Unit tests for the content. |
| `app/components/CalderynHexMark.tsx` (create) | Shared isomorphic hexagon SVG (size prop). |
| `app/components/__tests__/calderyn-hex-mark.test.ts` (create) | Render smoke. |
| `app/components/McpConnectGuide.tsx` (create) | Embedded Polaris renderer (hero + tabs + steps/CLI). |
| `app/components/__tests__/mcp-connect-guide-embedded.test.ts` (create) | Render smoke. |
| `app/routes/app.settings.tsx` (modify) | New "Claude connector" `Layout.AnnotatedSection`. |
| `app/components/dashboard/McpGuide.tsx` (create) | Dashboard `cd-*` renderer. |
| `app/styles/dashboard.css` (modify) | `.cd-mcp-*` styles. |
| `app/components/dashboard/__tests__/mcp-guide.test.ts` (create) | Render smoke. |
| `app/components/dashboard/screens/Settings.tsx` (modify) | New "Claude connector" `<section>`. |
| `app/components/McpConnectCards.tsx` (modify) | Slim to a "set up" banner/link. |
| `app/components/__tests__/mcp-connect-cards.test.ts` (create) | Slim-down regression. |
| `app/routes/app.mcp.tsx` (modify) | Pass `onSetup` to the slimmed banner. |

---

## Task 1: Shared content module

**Files:**
- Create: `app/lib/mcp-connect-guide.ts`
- Test: `app/lib/__tests__/mcp-connect-guide.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/__tests__/mcp-connect-guide.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/__tests__/mcp-connect-guide.test.ts`
Expected: FAIL — `Cannot find module '../mcp-connect-guide'`.

- [ ] **Step 3: Write minimal implementation**

Create `app/lib/mcp-connect-guide.ts`:

```ts
// app/lib/mcp-connect-guide.ts
//
// Single source of truth for the "Claude connector" install guide rendered on
// BOTH surfaces (embedded Polaris + dashboard cd-*). Content only — no
// presentation. Each surface maps the abstract GuideIcon keys to its own icons.

export const MCP_CONNECTOR_URL = "https://calderyn-mcp.vercel.app/mcp";
export const MCP_CONNECTOR_NAME = "Calderyn";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/__tests__/mcp-connect-guide.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/mcp-connect-guide.ts app/lib/__tests__/mcp-connect-guide.test.ts
git commit -m "lib/mcp-connect-guide: shared Claude-connector install-guide content"
```

---

## Task 2: Shared Calderyn hexagon mark

**Files:**
- Create: `app/components/CalderynHexMark.tsx`
- Test: `app/components/__tests__/calderyn-hex-mark.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/components/__tests__/calderyn-hex-mark.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CalderynHexMark } from "../CalderynHexMark";

describe("CalderynHexMark", () => {
  it("renders an accessible hexagon svg at the given size", () => {
    const html = renderToString(createElement(CalderynHexMark, { size: 32 }));
    expect(html).toContain("<svg");
    expect(html).toContain('aria-label="Calderyn"');
    expect(html).toContain('width="32"');
    expect(html).toContain('height="32"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/components/__tests__/calderyn-hex-mark.test.ts`
Expected: FAIL — `Cannot find module '../CalderynHexMark'`.

- [ ] **Step 3: Write minimal implementation**

Create `app/components/CalderynHexMark.tsx`:

```tsx
// app/components/CalderynHexMark.tsx
//
// Calderyn hexagon brand mark — shared, isomorphic SVG with no styling-system
// deps, so both the embedded Polaris guide and the dashboard cd-* guide render
// the same logo. Mirrors the sidebar mark in DashboardApp (teal fill, white
// stroke); on a colored hero, wrap it in a white chip.
export function CalderynHexMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Calderyn"
    >
      <path
        d="M16 2 L28.12 9 L28.12 23 L16 30 L3.88 23 L3.88 9 Z"
        fill="#24556E"
      />
      <path
        d="M24.4 11.15 L16 6.3 L7.6 11.15 L7.6 20.85 L16 25.7 L24.4 20.85"
        stroke="#fff"
        strokeWidth="3.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/components/__tests__/calderyn-hex-mark.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add app/components/CalderynHexMark.tsx app/components/__tests__/calderyn-hex-mark.test.ts
git commit -m "components/CalderynHexMark: shared hexagon brand-mark SVG"
```

---

## Task 3: Embedded renderer + wire into Settings

**Files:**
- Create: `app/components/McpConnectGuide.tsx`
- Test: `app/components/__tests__/mcp-connect-guide-embedded.test.ts`
- Modify: `app/routes/app.settings.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/components/__tests__/mcp-connect-guide-embedded.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/components/__tests__/mcp-connect-guide-embedded.test.ts`
Expected: FAIL — `Cannot find module '../McpConnectGuide'`.

- [ ] **Step 3: Write the component**

Create `app/components/McpConnectGuide.tsx`:

```tsx
// app/components/McpConnectGuide.tsx
//
// Embedded (Polaris) renderer of the "Claude connector" install guide. Content
// comes from ~/lib/mcp-connect-guide (shared with the dashboard renderer); this
// file maps it to Polaris + the Calderyn hero. Two tabs: the Claude.ai connector
// stepper and the Claude Code CLI command. The teal hero is a styled element
// (Polaris Box can't take a brand color); everything else uses Polaris.
import { useCallback, useState } from "react";
import {
  BlockStack,
  Button,
  ButtonGroup,
  Icon,
  InlineStack,
  Text,
  TextField,
} from "@shopify/polaris";
import { SettingsIcon, ConnectIcon, KeyIcon, ClipboardIcon } from "@shopify/polaris-icons";
import {
  MCP_CONNECTOR_URL,
  CLI_COMMAND,
  CLI_NOTE,
  CONNECTOR_STEPS,
  GUIDE_TABS,
  type GuideIcon,
  type GuideTab,
} from "~/lib/mcp-connect-guide";
import { CalderynHexMark } from "./CalderynHexMark";

const STEP_ICON: Record<GuideIcon, typeof SettingsIcon> = {
  settings: SettingsIcon,
  connector: ConnectIcon,
  signin: KeyIcon,
};

function Hero() {
  return (
    <div
      style={{
        background: "#24556E",
        borderRadius: "12px",
        padding: "28px 24px",
        color: "#fff",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 14,
          background: "#fff",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 12,
        }}
      >
        <CalderynHexMark size={34} />
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em" }}>
        Calderyn MCP for Claude
      </div>
      <div style={{ fontSize: 14, opacity: 0.85, marginTop: 4 }}>
        Connect your store to Claude — let it read your ads, inventory, and alerts and act within your guardrails.
      </div>
    </div>
  );
}

export function McpConnectGuide({
  onManage,
  initialTab = "connector",
}: {
  onManage?: () => void;
  initialTab?: GuideTab;
}) {
  const [tab, setTab] = useState<GuideTab>(initialTab);
  const copy = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text);
  }, []);

  return (
    <BlockStack gap="400">
      <Hero />

      <ButtonGroup>
        {GUIDE_TABS.map((t) => (
          <Button key={t.id} pressed={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </Button>
        ))}
      </ButtonGroup>

      {tab === "connector" ? (
        <BlockStack gap="400">
          {CONNECTOR_STEPS.map((s) => (
            <InlineStack key={s.n} gap="300" blockAlign="start" wrap={false}>
              <div
                style={{
                  flex: "0 0 auto",
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  background: "#24556E",
                  color: "#fff",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: 14,
                }}
              >
                {s.n}
              </div>
              <BlockStack gap="100">
                <InlineStack gap="150" blockAlign="center">
                  <Icon source={STEP_ICON[s.icon]} tone="subdued" />
                  <Text as="h3" variant="headingSm">
                    {s.title}
                  </Text>
                </InlineStack>
                <Text as="p" variant="bodyMd">
                  {s.body}
                </Text>
                {s.n === 2 && (
                  <TextField
                    label="MCP URL"
                    labelHidden
                    value={MCP_CONNECTOR_URL}
                    autoComplete="off"
                    readOnly
                    monospaced
                    connectedRight={
                      <Button
                        icon={ClipboardIcon}
                        onClick={() => copy(MCP_CONNECTOR_URL)}
                        accessibilityLabel="Copy MCP URL"
                      />
                    }
                  />
                )}
              </BlockStack>
            </InlineStack>
          ))}
        </BlockStack>
      ) : (
        <BlockStack gap="200">
          <TextField
            label="Run in your terminal"
            labelHidden
            value={CLI_COMMAND}
            autoComplete="off"
            readOnly
            monospaced
            connectedRight={
              <Button
                icon={ClipboardIcon}
                onClick={() => copy(CLI_COMMAND)}
                accessibilityLabel="Copy command"
              />
            }
          />
          <Text as="p" tone="subdued" variant="bodySm">
            {CLI_NOTE}
          </Text>
        </BlockStack>
      )}

      {onManage && (
        <Button variant="plain" onClick={onManage}>
          Manage access keys & connected workspaces
        </Button>
      )}
    </BlockStack>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/components/__tests__/mcp-connect-guide-embedded.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into `app/routes/app.settings.tsx`**

Add the import after the existing `import { GuardrailMeter } from "~/components/calderyn";` line:

```tsx
import { McpConnectGuide } from "~/components/McpConnectGuide";
```

Then, inside `<Layout>`, immediately AFTER the Integrations `</Layout.AnnotatedSection>` and BEFORE the `account-data` `<Layout.AnnotatedSection ...>`, insert:

```tsx
          <Layout.AnnotatedSection
            id="claude-connector"
            title="Claude connector"
            description="Connect Claude (or Claude Code) to read your store over MCP."
          >
            <Card>
              <McpConnectGuide onManage={() => navigate("/app/mcp")} />
            </Card>
          </Layout.AnnotatedSection>
```

(`navigate` and `Card` are already imported/used in this file.)

- [ ] **Step 6: Typecheck + build the route**

Run: `npx tsc --noEmit`
Expected: exit 0.
Run: `npx vitest run app/routes/__tests__/onboarding-ui.test.ts` (smoke that Polaris route components still import cleanly)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/components/McpConnectGuide.tsx app/components/__tests__/mcp-connect-guide-embedded.test.ts app/routes/app.settings.tsx
git commit -m "settings: add embedded Claude-connector install guide section"
```

---

## Task 4: Dashboard renderer + wire into dashboard Settings

**Files:**
- Create: `app/components/dashboard/McpGuide.tsx`
- Modify: `app/styles/dashboard.css`
- Test: `app/components/dashboard/__tests__/mcp-guide.test.ts`
- Modify: `app/components/dashboard/screens/Settings.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/components/dashboard/__tests__/mcp-guide.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/components/dashboard/__tests__/mcp-guide.test.ts`
Expected: FAIL — `Cannot find module '../McpGuide'`.

- [ ] **Step 3: Write the component**

Create `app/components/dashboard/McpGuide.tsx`:

```tsx
// app/components/dashboard/McpGuide.tsx
//
// Dashboard (cd-*) renderer of the "Claude connector" install guide. Same shared
// content as the embedded Polaris McpConnectGuide; dashboard look. Styles live in
// app/styles/dashboard.css under .cd-mcp-*.
import { useState } from "react";
import { Segmented } from "./ui";
import { CDIcon } from "./icons";
import { CalderynHexMark } from "../CalderynHexMark";
import {
  MCP_CONNECTOR_URL,
  CLI_COMMAND,
  CLI_NOTE,
  CONNECTOR_STEPS,
  GUIDE_TABS,
  type GuideIcon,
  type GuideTab,
} from "~/lib/mcp-connect-guide";

const STEP_ICON: Record<GuideIcon, string> = {
  settings: "gear",
  connector: "bolt",
  signin: "check",
};

function CopyChip({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cd-mcp-chip">
      <code className="cd-mcp-code">{text}</code>
      <button
        type="button"
        className="cd-btn cd-btn-secondary cd-mcp-copy"
        aria-label={label}
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
        }}
      >
        <CDIcon name={copied ? "check" : "doc"} size={15} />
      </button>
    </div>
  );
}

export function McpGuide({ initialTab = "connector" }: { initialTab?: GuideTab }) {
  const [tab, setTab] = useState<GuideTab>(initialTab);

  return (
    <div className="cd-mcp">
      <div className="cd-mcp-hero">
        <span className="cd-mcp-hero-mark">
          <CalderynHexMark size={32} />
        </span>
        <div className="cd-mcp-hero-title">Calderyn MCP for Claude</div>
        <div className="cd-mcp-hero-sub">
          Connect your store to Claude — let it read your ads, inventory, and alerts and act within your guardrails.
        </div>
      </div>

      <Segmented
        value={tab}
        onChange={(v) => setTab(v as GuideTab)}
        options={GUIDE_TABS.map((t) => ({ value: t.id, label: t.label }))}
      />

      {tab === "connector" ? (
        <div className="cd-mcp-steps">
          {CONNECTOR_STEPS.map((s) => (
            <div className="cd-mcp-step" key={s.n}>
              <div className="cd-mcp-badge">{s.n}</div>
              <div className="cd-mcp-step-body">
                <div className="cd-mcp-step-title">
                  <CDIcon name={STEP_ICON[s.icon]} size={15} /> {s.title}
                </div>
                <div className="cd-caption">{s.body}</div>
                {s.n === 2 && <CopyChip text={MCP_CONNECTOR_URL} label="Copy MCP URL" />}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="cd-mcp-cli">
          <CopyChip text={CLI_COMMAND} label="Copy command" />
          <div className="cd-caption">{CLI_NOTE}</div>
        </div>
      )}

      <div className="cd-caption cd-mcp-foot">
        Manage access keys & connected workspaces from the Calderyn app in your Shopify admin.
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add styles to `app/styles/dashboard.css`**

Append this block at the END of `app/styles/dashboard.css`:

```css
/* Claude connector install guide (Settings → Claude connector) */
.cd-mcp { display: flex; flex-direction: column; gap: 16px; }
.cd-mcp-hero {
  background: var(--accent); color: #fff; border-radius: 14px;
  padding: 26px 22px; text-align: center;
}
.cd-mcp-hero-mark {
  display: inline-flex; align-items: center; justify-content: center;
  width: 52px; height: 52px; border-radius: 13px; background: #fff; margin-bottom: 10px;
}
.cd-mcp-hero-title { font-size: 19px; font-weight: 680; letter-spacing: -0.01em; }
.cd-mcp-hero-sub { font-size: 13px; opacity: 0.86; margin-top: 4px; max-width: 42ch; margin-inline: auto; }
.cd-mcp-steps { display: flex; flex-direction: column; gap: 14px; }
.cd-mcp-step { display: flex; gap: 12px; align-items: flex-start; }
.cd-mcp-badge {
  flex: 0 0 auto; width: 26px; height: 26px; border-radius: 999px;
  background: var(--accent); color: #fff; font-weight: 700; font-size: 13px;
  display: inline-flex; align-items: center; justify-content: center;
}
.cd-mcp-step-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 5px; }
.cd-mcp-step-title { display: flex; align-items: center; gap: 7px; font-weight: 600; font-size: 14px; }
.cd-mcp-step-title svg { color: var(--accent); }
.cd-mcp-chip {
  display: flex; align-items: center; gap: 8px; margin-top: 4px;
  background: var(--accent-bg); border: 1px solid rgba(120, 120, 128, 0.2);
  border-radius: 9px; padding: 7px 8px 7px 11px;
}
.cd-mcp-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
  overflow-x: auto; white-space: nowrap; flex: 1;
}
.cd-mcp-copy { flex: 0 0 auto; padding: 5px 8px; }
.cd-mcp-cli { display: flex; flex-direction: column; gap: 8px; }
.cd-mcp-foot { padding-top: 2px; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/components/dashboard/__tests__/mcp-guide.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Wire into `app/components/dashboard/screens/Settings.tsx`**

Add the import after `import type { GuardrailConfig } from "~/lib/types";`:

```tsx
import { McpGuide } from "../McpGuide";
```

Then, immediately AFTER the closing `</section>` of the "Connections" section (the last `<section>` in the returned JSX) and BEFORE the closing `</div>` of `cd-screen`, insert:

```tsx
      <section>
        <SectionTitle>Claude connector</SectionTitle>
        <McpGuide />
      </section>
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add app/components/dashboard/McpGuide.tsx app/styles/dashboard.css app/components/dashboard/__tests__/mcp-guide.test.ts app/components/dashboard/screens/Settings.tsx
git commit -m "dashboard/settings: add Claude-connector install guide section"
```

---

## Task 5: Slim the old /app/mcp install cards to a link

**Files:**
- Modify: `app/components/McpConnectCards.tsx`
- Test: `app/components/__tests__/mcp-connect-cards.test.ts`
- Modify: `app/routes/app.mcp.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/components/__tests__/mcp-connect-cards.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/components/__tests__/mcp-connect-cards.test.ts`
Expected: FAIL — the current component renders the bearer-token card + the URL.

- [ ] **Step 3: Replace the component body**

Replace the ENTIRE contents of `app/components/McpConnectCards.tsx` with:

```tsx
import { Banner } from "@shopify/polaris";

// The full install guide now lives under Settings → "Claude connector". This
// slim banner points there so the "Claude connections" page stays focused on
// key/connection management.
export function McpConnectCards({ onSetup }: { onSetup?: () => void }) {
  return (
    <Banner
      tone="info"
      title="Set up the Claude connector"
      action={onSetup ? { content: "Open setup guide", onAction: onSetup } : undefined}
    >
      <p>New here? The step-by-step connector setup lives under Settings → Claude connector.</p>
    </Banner>
  );
}
```

- [ ] **Step 4: Pass `onSetup` in `app/routes/app.mcp.tsx`**

Find the usage `<McpConnectCards />` (around line 219) and replace it with:

```tsx
        <McpConnectCards onSetup={() => navigate("/app/settings")} />
```

(`navigate` is already defined in this file via `useEmbeddedNavigate`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run app/components/__tests__/mcp-connect-cards.test.ts`
Expected: PASS (1 test).
Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/components/McpConnectCards.tsx app/components/__tests__/mcp-connect-cards.test.ts app/routes/app.mcp.tsx
git commit -m "app.mcp: slim the old install cards to a 'set up under Settings' link"
```

---

## Task 6: Full pre-commit gate + graph update

**Files:** none (verification only).

- [ ] **Step 1: Full test suite** — Run: `npm test` → exit 0, all pass.
- [ ] **Step 2: Typecheck** — Run: `npm run typecheck` → exit 0.
- [ ] **Step 3: Lint** — Run: `npm run lint` → exit 0, no warnings on touched files.
- [ ] **Step 4: Build** — Run: `npm run build` → exit 0.
- [ ] **Step 5: Patch sanity** — Run: `git diff --stat main...HEAD && git diff --check main...HEAD` → only the files in the File Structure table; no stray `console.log`/`.only`/`TODO(me)`.
- [ ] **Step 6: `/code-review`** — run the slash command on the branch diff; resolve blockers, downgrade nits with justification.
- [ ] **Step 7: Graph update** — Run: `graphify update .`

---

## Self-Review

**1. Spec coverage:**
- Shared content module → Task 1 ✓
- Two tabs (Claude.ai connector + Claude Code CLI) → Task 1 `GUIDE_TABS` + Tasks 3/4 tab render ✓
- Embedded Settings section (Polaris, hero + steps + URL copy + CLI) → Task 3 ✓
- Dashboard Settings section (cd-*, same content) → Task 4 ✓
- Brand teal `#24556E` / `var(--accent)` hero + hexagon → Task 2 mark + Task 3 hero + Task 4 CSS ✓
- Slim /app/mcp McpConnectCards to a link → Task 5 ✓
- Per-step icons (settings/connector/signin) → Task 3 `STEP_ICON` (Polaris) + Task 4 `STEP_ICON` (CDIcon) ✓
- "Manage access keys" link to /app/mcp → Task 3 `onManage` ✓

**2. Placeholder scan:** none — every step has complete code. ✓

**3. Type consistency:** `GuideTab`/`GuideIcon`/`GuideStep`, `CONNECTOR_STEPS`, `GUIDE_TABS`, `MCP_CONNECTOR_URL`, `CLI_COMMAND`, `CLI_NOTE` defined in Task 1 and used verbatim in Tasks 3/4/5. `initialTab` prop name consistent across both renderers and their tests. `onManage` (embedded) vs `onSetup` (slim card) are distinct props on distinct components — intentional. ✓

**Note:** Polaris Box can't take a brand color, so the embedded hero + step badge use small inline-styled `<div>`s (teal `#24556E`); the rest is Polaris. The dashboard hero/badges use `var(--accent)` via the `.cd-mcp-*` CSS. Both render the shared `CalderynHexMark`.
