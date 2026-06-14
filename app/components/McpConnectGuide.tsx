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

// Calderyn brand accent (the hexagon mark's teal). Polaris Box can't take a
// brand color, so the hero + step badge use it via inline style.
const BRAND_TEAL = "#24556E";

function Hero() {
  return (
    <div
      style={{
        background: BRAND_TEAL,
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

      <ButtonGroup variant="segmented">
        {GUIDE_TABS.map((t) => (
          <Button key={t.id} pressed={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </Button>
        ))}
      </ButtonGroup>

      {tab === "connector" ? (
        <BlockStack gap="400">
          {CONNECTOR_STEPS.map((s) => (
            <div key={s.n} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div
                style={{
                  flex: "0 0 auto",
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  background: BRAND_TEAL,
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
              {/* Plain flex column so the icon+title row groups at the left;
                  Polaris InlineStack here stretched full-width and shoved the
                  title to the right edge. */}
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Icon source={STEP_ICON[s.icon]} tone="subdued" />
                  <Text as="h3" variant="headingSm">
                    {s.title}
                  </Text>
                </div>
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
              </div>
            </div>
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
