import { useMemo, useState } from "react";
import { useLoaderData } from "@remix-run/react";
import { useEmbeddedNavigate } from "../lib/embedded-nav";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Banner, BlockStack, Box, Card, Page, Text } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import { fmtMoney, fmtRelTime } from "~/lib/format";
import { ACTION_LABELS, DETECTOR_TO_ACTIONS, alertDetectorLabel } from "~/lib/labels";
import type { Alert, AlertStatus, Severity } from "~/lib/types";

// Triage order: criticals first, then down. The page groups by this so a
// merchant sees "I have 2 fires" before scrolling a wall.
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const SEV_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};
// Light-only design palette (mirrors the .cmpx-* dots). The amber/medium dot is
// the design's #c79a00; low falls back to the neutral subdued grey.
const SEV_DOT: Record<Severity, string> = {
  critical: "#d72c0d",
  high: "#ff6f00",
  medium: "#b98900",
  low: "#9a9a9a",
};

// Status is the only filter (severity is handled by the grouping below). The
// live statuses are exactly open / acknowledged / resolved (Alert["status"]),
// so the tab bar renders what the data actually has — no fabricated tab.
const STATUS_TABS: { id: AlertStatus | "all"; content: string }[] = [
  { id: "open", content: "Open" },
  { id: "acknowledged", content: "Acknowledged" },
  { id: "resolved", content: "Resolved" },
  { id: "all", content: "All" },
];

type LoaderPayload = {
  alerts: Alert[];
  error: { code: string; message: string } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const alerts = await client.alerts.list({}, request.signal);
    return json<LoaderPayload>({ alerts, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      alerts: [],
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};

/** The plain-language "suggested next step" for an alert, derived from its
 *  detector's first allowed action. Presentation only — it deep-links the
 *  Review button to the detail page where the action actually runs; it never
 *  claims the action has been taken. Resolved alerts read "Resolved". */
function suggestedAction(a: Alert): string {
  if (a.status === "resolved") return "Resolved";
  const kinds = DETECTOR_TO_ACTIONS[a.detector_id] ?? ["snooze_alert"];
  return ACTION_LABELS[kinds[0]] ?? "Review";
}

/** One alert row, styled to the design (checkbox column intentionally omitted —
 *  the list route has no bulk action to back it). The whole row navigates to the
 *  detail page; the Review button is the explicit affordance. */
function AlertRow({
  a,
  badgeBg,
  badgeFg,
  onReview,
}: {
  a: Alert;
  badgeBg: string;
  badgeFg: string;
  onReview: (a: Alert) => void;
}) {
  return (
    <div
      className="alx-row"
      role="button"
      tabIndex={0}
      onClick={() => onReview(a)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onReview(a);
        }
      }}
    >
      <div className="alx-row-main">
        <div className="alx-row-title">{a.title}</div>
        <div className="alx-row-meta">
          <span className="alx-reason" style={{ background: badgeBg, color: badgeFg }}>
            {alertDetectorLabel(a.detector_id, a.evidence)}
          </span>
          <span className="alx-age">{fmtRelTime(a.created_at)}</span>
        </div>
      </div>
      <div className="alx-row-impact">
        <div className="alx-impact-val">{fmtMoney(a.dollar_impact)}</div>
        <div className="alx-impact-cap">at risk / 30d</div>
      </div>
      <div className="alx-row-act">
        <button
          type="button"
          className="alx-review"
          onClick={(e) => {
            e.stopPropagation();
            onReview(a);
          }}
        >
          Review
        </button>
        <span className="alx-suggest">
          Suggested: <span className="alx-suggest-val">{suggestedAction(a)}</span>
        </span>
      </div>
    </div>
  );
}

export default function AlertList() {
  const navigate = useEmbeddedNavigate();
  const { alerts, error } = useLoaderData<typeof loader>();
  const [statusIdx, setStatusIdx] = useState(0); // default: Open
  const [sev, setSev] = useState<Severity | "all">("all");
  const status = STATUS_TABS[statusIdx].id;

  // Per-status counts for the tab labels (computed over the full list so the
  // numbers stay stable as the active tab changes).
  const statusCounts = useMemo(
    () => ({
      open: alerts.filter((a) => a.status === "open").length,
      acknowledged: alerts.filter((a) => a.status === "acknowledged").length,
      resolved: alerts.filter((a) => a.status === "resolved").length,
      all: alerts.length,
    }),
    [alerts],
  );

  // Alerts in the active status tab (before the severity chip filter) — drives
  // the severity-chip counts so they reflect the tab, like the design.
  const inStatus = useMemo(
    () => alerts.filter((a) => status === "all" || a.status === status),
    [alerts, status],
  );

  const sevCounts = useMemo(
    () => ({
      critical: inStatus.filter((a) => a.severity === "critical").length,
      high: inStatus.filter((a) => a.severity === "high").length,
      medium: inStatus.filter((a) => a.severity === "medium").length,
      low: inStatus.filter((a) => a.severity === "low").length,
    }),
    [inStatus],
  );

  const visible = useMemo(
    () => inStatus.filter((a) => sev === "all" || a.severity === sev),
    [inStatus, sev],
  );

  // One section per severity that has alerts, each sorted by Claude's rank.
  const groups = useMemo(
    () =>
      SEVERITIES.map((s) => {
        const items = visible
          .filter((a) => a.severity === s)
          .sort((x, y) => x.claude_rank - y.claude_rank);
        return {
          sev: s,
          items,
          impact: items.reduce((acc, a) => acc + a.dollar_impact, 0),
        };
      }).filter((g) => g.items.length > 0),
    [visible],
  );

  const totalImpact = visible.reduce((s, a) => s + a.dollar_impact, 0);
  const review = (a: Alert) => navigate(`/app/alerts/${a.id}`);

  const tabLabel =
    { open: "Open alerts", acknowledged: "Acknowledged", resolved: "Resolved", all: "All alerts" }[
      status
    ];

  // Severity chips offered: "All" plus only the severities that actually appear
  // in the active status tab (no always-empty chips).
  const sevChips: { key: Severity; label: string; count: number }[] = (
    ["critical", "high", "medium", "low"] as Severity[]
  )
    .map((k) => ({ key: k, label: SEV_LABEL[k], count: sevCounts[k] }))
    .filter((c) => c.count > 0);

  return (
    <Page
      fullWidth
      title="Alerts"
      subtitle="Ranked by priority — clear the criticals first."
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" title="Couldn't load alerts">
            <p>{error.message}</p>
          </Banner>
        )}

        {/* Status tabs + at-risk readout (mirrors the design's segmented control). */}
        <div className="alx-toolbar">
          <div className="alx-tabs" role="tablist" aria-label="Alert status">
            {STATUS_TABS.map((t, i) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={statusIdx === i}
                className="alx-tab"
                data-on={statusIdx === i}
                onClick={() => {
                  setStatusIdx(i);
                  setSev("all");
                }}
              >
                {t.content}{" "}
                <span className="alx-tab-count">
                  {statusCounts[t.id as keyof typeof statusCounts]}
                </span>
              </button>
            ))}
          </div>
          {visible.length > 0 && (
            <div className="alx-atrisk">
              {tabLabel} <strong>{fmtMoney(totalImpact)}</strong>{" "}
              <span className="alx-atrisk-sub">at risk</span>
            </div>
          )}
        </div>

        {/* Severity filter chips — only the severities present in this tab. */}
        {sevChips.length > 0 && (
          <div className="alx-chips">
            <button
              type="button"
              className="alx-chip"
              data-on={sev === "all"}
              onClick={() => setSev("all")}
            >
              All severities
            </button>
            {sevChips.map((c) => (
              <button
                key={c.key}
                type="button"
                className="alx-chip"
                data-on={sev === c.key}
                onClick={() => setSev(c.key)}
              >
                <span className="alx-chip-dot" style={{ background: SEV_DOT[c.key] }} />
                {c.label} <span className="alx-chip-count">{c.count}</span>
              </button>
            ))}
          </div>
        )}

        {groups.length === 0 ? (
          <Card>
            <Box padding="400">
              <BlockStack gap="100" inlineAlign="center">
                <Text as="p" variant="headingMd">
                  {status === "open" ? "All clear" : "Nothing here"}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {status === "open"
                    ? "No open alerts. Calderyn will surface the next money-losing problem the moment it appears."
                    : "No alerts match this filter."}
                </Text>
              </BlockStack>
            </Box>
          </Card>
        ) : (
          <BlockStack gap="400">
            {groups.map((g) => {
              const noun = g.items.length === 1 ? "alert" : "alerts";
              return (
                <Card key={g.sev} padding="0">
                  <div className="alx-group">
                    <div className="alx-group-rail" style={{ background: SEV_DOT[g.sev] }} />
                    <div className="alx-group-body">
                      <div className="alx-group-head">
                        <span
                          className="alx-group-dot"
                          style={{ background: SEV_DOT[g.sev] }}
                        />
                        <span className="alx-group-label">{SEV_LABEL[g.sev]}</span>
                        <span className="alx-group-count">
                          {g.items.length} {noun} · {fmtMoney(g.impact)} at risk
                        </span>
                      </div>
                      {g.items.map((a) => (
                        <AlertRow
                          key={a.id}
                          a={a}
                          badgeBg={SEV_BADGE[g.sev].bg}
                          badgeFg={SEV_BADGE[g.sev].fg}
                          onReview={review}
                        />
                      ))}
                    </div>
                  </div>
                </Card>
              );
            })}
            <div className="alx-footer">
              Showing {visible.length} of {alerts.length} alerts
            </div>
          </BlockStack>
        )}
      </BlockStack>
    </Page>
  );
}

// Reason-pill colors per severity (design's badgeBg / badgeFg). Low reuses the
// neutral grey treatment so every severity has a legible pill.
const SEV_BADGE: Record<Severity, { bg: string; fg: string }> = {
  critical: { bg: "#fdece7", fg: "#b3300f" },
  high: { bg: "#fbe9d6", fg: "#9a4d06" },
  medium: { bg: "#fbf3da", fg: "#7a5800" },
  low: { bg: "#f1f1f1", fg: "#6a6a6a" },
};
