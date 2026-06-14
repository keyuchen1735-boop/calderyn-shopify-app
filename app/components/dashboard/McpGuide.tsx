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
        aria-label={copied ? "Copied" : label}
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          // Reset the ✓ so the chip stays re-copyable (React 18 ignores the
          // late setState if the component has unmounted).
          setTimeout(() => setCopied(false), 1500);
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
        Manage access keys &amp; connected workspaces from the Calderyn app in your Shopify admin.
      </div>
    </div>
  );
}
