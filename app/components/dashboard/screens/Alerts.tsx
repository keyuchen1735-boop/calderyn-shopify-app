// Calderyn DashV2 — Alerts screen (LIVE).
// Ported from the prototype's screen-alerts.jsx, wired to the live DashboardCtx.
// List (ranked, filterable) + detail (narrative, evidence, guardrailed actions).
// CD.* globals → live imports: money/DETECTOR_TERMS/ACTION_LABELS (format),
// CDIcon/CD_ACTION_ICON (icons), Card/SevBadge/Pill/Segmented/Placeholder/etc. (ui).
import { useState, type ReactNode } from "react";
import {
  Card,
  SevBadge,
  Pill,
  Segmented,
  Sparkline,
  PlatformMark,
  Placeholder,
} from "../ui";
import {
  money,
  DETECTOR_TERMS,
  ACTION_LABELS,
  timeAgo,
  evidenceLabel,
  evidenceValue,
  isInternalEvidenceKey,
} from "../format";
import { CDIcon, CD_ACTION_ICON } from "../icons";
import type { ActionKind, DashboardCtx } from "../context";
import type { AlertVM, CampaignVM } from "../view-models";

/* ---------- Header (mirrors the prototype's ScreenHeader) ---------- */
function ScreenHeader({
  title,
  sub,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="cd-screen-head" data-screen-label={title}>
      <div>
        <h1 className="cd-h1">{title}</h1>
        {sub && <p className="cd-sub">{sub}</p>}
      </div>
      {children && <div className="flex items-center gap-2.5">{children}</div>}
    </header>
  );
}

/* ---------- List row ---------- */
function AlertRow({ a, onClick }: { a: AlertVM; onClick: () => void }) {
  const resolved = a.status !== "open";
  return (
    <button className="cd-row" onClick={onClick} data-dim={resolved ? "1" : "0"}>
      <span className={"cd-sev-bar sev-" + a.severity}></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="cd-row-title truncate">{a.title}</span>
          {resolved && (
            <Pill tone="success" icon="check">
              Resolved
            </Pill>
          )}
        </div>
        <div className="cd-caption truncate">
          {(DETECTOR_TERMS[a.detector_id] || a.detector_id) +
            " · " +
            (a.sku || a.campaign || "—") +
            " · " +
            timeAgo(a.created_at)}
        </div>
      </div>
      <div className="text-right whitespace-nowrap">
        <div
          className="cd-row-num tabular-nums"
          style={{ color: resolved ? "var(--text-3)" : "var(--red)" }}
        >
          {money(a.dollar_impact)}
          <span className="cd-caption">/wk</span>
        </div>
        <div className="cd-caption">at risk</div>
      </div>
      <CDIcon name="chevronRight" size={16} style={{ color: "var(--text-3)", flexShrink: 0 }} />
    </button>
  );
}

/* ---------- Linked campaign card ---------- */
function LinkedCampaign({ app, campaign }: { app: DashboardCtx; campaign: CampaignVM }) {
  const below = campaign.roas_7d < campaign.breakeven_roas;
  return (
    <Card
      hover
      onClick={() => app.navigate("campaigns", campaign.id)}
      className="flex items-center gap-3"
    >
      <PlatformMark platform={campaign.platform} />
      <div className="min-w-0 flex-1">
        <div className="cd-row-title truncate">{campaign.name}</div>
        <div className="cd-caption">
          {(campaign.status === "active"
            ? `Active · ${money(campaign.daily_budget_cents)}/day`
            : "Paused") +
            ` · ROAS ${campaign.roas_7d.toFixed(1)}× vs ${campaign.breakeven_roas.toFixed(
              1,
            )}× break-even`}
        </div>
      </div>
      {campaign.trend && campaign.trend.length > 1 && (
        <Sparkline
          data={campaign.trend}
          refLine={campaign.breakeven_roas}
          stroke={below ? "var(--red)" : "var(--green)"}
        />
      )}
      <CDIcon name="chevronRight" size={16} style={{ color: "var(--text-3)" }} />
    </Card>
  );
}

/* ---------- Detail ---------- */
function AlertDetail({
  app,
  alert,
  onBack,
}: {
  app: DashboardCtx;
  alert: AlertVM;
  onBack: () => void;
}) {
  // Track the kind we attempted, so a freshly-resolved alert can read "Resolved — <label>".
  // (AlertVM has no `resolved_with` field; the shell only flips status to "resolved".)
  const [attempted, setAttempted] = useState<ActionKind | null>(null);
  const [busy, setBusy] = useState(false);

  const resolved = alert.status !== "open";
  const resolvedLabel =
    (attempted && ACTION_LABELS[attempted]) ||
    (alert.recommended && ACTION_LABELS[alert.recommended]) ||
    "action taken";

  // Mirror of the extension's sold-out guard (app/routes/app.alerts.$id.tsx):
  // when a "may sell out" alert's stock / days-of-cover are already 0, reframe the
  // headline so copy never contradicts the evidence. Engine fix flagged separately.
  const soldOut =
    alert.detector_id === "scaling_sku_fulfillment_risk" &&
    (Number(alert.evidence.stock) === 0 || Number(alert.evidence.days_of_cover) === 0);
  const productName =
    alert.evidence.title || alert.evidence.sku_title || alert.sku || "";
  const headline =
    soldOut && productName ? `${productName} is sold out — restock now` : alert.title;

  const campaign = alert.campaign_id
    ? app.campaigns.find((c) => c.id === alert.campaign_id) ?? null
    : null;

  // Merchant-facing evidence: drop raw platform IDs and empty values, then map
  // each key/value through the shared labeler/formatter (see ../format).
  const evidenceCells = Object.entries(alert.evidence).filter(
    ([k, v]) => !isInternalEvidenceKey(k) && v != null && v !== "",
  );

  const run = async (kind: ActionKind) => {
    if (busy || resolved) return;
    setAttempted(kind);
    setBusy(true);
    try {
      // executeAction is async; the shell handles optimistic state + error toasts
      // internally (it does not re-throw). On success it flips alert.status to
      // "resolved" via app.alerts, which re-renders this detail. On failure the
      // status stays "open", so the buttons simply re-enable below.
      await app.executeAction(alert, kind);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cd-screen" data-screen-label="Alert detail">
      <button className="cd-back" onClick={onBack}>
        <CDIcon name="chevronLeft" size={15} />
        Alerts
      </button>
      <header className="cd-screen-head" style={{ marginTop: 4 }}>
        <div>
          <div className="flex items-center gap-2 mb-2">
            <SevBadge severity={alert.severity} />
            <span className="cd-caption">
              {(DETECTOR_TERMS[alert.detector_id] || alert.detector_id) +
                " · detected " +
                timeAgo(alert.created_at)}
            </span>
            {resolved && (
              <Pill tone="success" icon="check">
                Resolved — {resolvedLabel}
              </Pill>
            )}
          </div>
          <h1 className="cd-h1">{headline}</h1>
        </div>
        <div className="text-right">
          <div
            className="cd-stat-value tabular-nums"
            style={{ color: resolved ? "var(--text-3)" : "var(--red)" }}
          >
            {money(alert.dollar_impact)}
          </div>
          <div className="cd-caption">at risk per week</div>
        </div>
      </header>

      <div className="cd-grid-main">
        <div className="flex flex-col gap-4 min-w-0">
          <Card>
            <h2 className="cd-h2 mb-2">What&apos;s happening</h2>
            {soldOut && (
              <p className="cd-body" style={{ color: "var(--red)", marginBottom: 8, maxWidth: "62ch" }}>
                On-hand stock is 0 — this isn&apos;t a &ldquo;may sell out&rdquo; risk, it&apos;s a
                stockout. Restock now and pause or exclude the spend until inventory is back.
              </p>
            )}
            <p className="cd-body" style={{ maxWidth: "62ch" }}>
              {alert.narrative}
            </p>
          </Card>
          {evidenceCells.length > 0 && (
            <Card pad={false}>
              <div className="cd-pad-x cd-pad-t">
                <h2 className="cd-h2">Evidence</h2>
              </div>
              <div className="cd-evidence">
                {evidenceCells.map(([k, v]) => (
                  <div key={k} className="cd-evidence-cell">
                    <div className="cd-caption">{evidenceLabel(k)}</div>
                    <div className="cd-h3 tabular-nums">{evidenceValue(k, v)}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}
          {campaign && <LinkedCampaign app={app} campaign={campaign} />}
        </div>

        <div className="flex flex-col gap-4 min-w-0">
          <Card className="flex flex-col gap-2.5">
            <h2 className="cd-h2">Fix it</h2>
            {resolved ? (
              <p className="cd-caption">
                This alert was resolved with{" "}
                <b style={{ color: "var(--text-1)" }}>{resolvedLabel}</b>. The action is logged in
                your audit history and can be reverted there.
              </p>
            ) : alert.remediation ? (
              <>
                {alert.rec_detail && (
                  <p className="cd-body" style={{ maxWidth: "52ch" }}>
                    {alert.rec_detail}
                  </p>
                )}
                <div className="flex flex-col gap-2 mt-1">
                  {alert.remediation.moves.map((m) => {
                    const rec = m.kind === alert.remediation!.recommended;
                    if (m.executor) {
                      // Executable move: snooze (Phase 1) or discontinue_sku (Phase 2).
                      const isDiscontinue = m.executor === "discontinue_sku";
                      return (
                        <button
                          key={m.kind}
                          disabled={resolved || busy}
                          aria-busy={busy && attempted === m.executor}
                          className={"cd-action-btn" + (rec ? " rec" : "") + (isDiscontinue ? " danger" : "")}
                          onClick={() => run(m.executor as ActionKind)}
                        >
                          <CDIcon name={CD_ACTION_ICON[m.executor] || "bolt"} size={16} strokeWidth={1.9} />
                          <span className="flex-1 text-left">{m.label}</span>
                          {rec && <span className="cd-rec-tag">Recommended</span>}
                        </button>
                      );
                    }
                    return (
                      <div
                        key={m.kind}
                        className={"cd-move-row" + (rec ? " rec" : "")}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "10px 12px",
                          borderRadius: 10,
                          border: "1px solid var(--border)",
                          background: rec ? "var(--surface-2)" : "transparent",
                        }}
                      >
                        <CDIcon name={CD_ACTION_ICON[m.kind] || "bolt"} size={16} strokeWidth={1.9} />
                        <span className="flex-1 text-left">{m.label}</span>
                        {rec && <span className="cd-rec-tag">Recommended</span>}
                      </div>
                    );
                  })}
                </div>
                <p className="cd-caption mt-1" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <CDIcon name="shield" size={13} /> Guardrails apply — every action is reversible and
                  logged. Advisory moves are guidance; the highlighted action runs with one click.
                </p>
              </>
            ) : (
              <>
                {alert.rec_detail && <p className="cd-caption">{alert.rec_detail}</p>}
                <div className="flex flex-col gap-2 mt-1">
                  {alert.actions.map((kind) => {
                    const rec = kind === alert.recommended;
                    return (
                      <button
                        key={kind}
                        disabled={resolved || busy}
                        aria-busy={busy && attempted === kind}
                        className={"cd-action-btn" + (rec ? " rec" : "")}
                        onClick={() => run(kind as ActionKind)}
                      >
                        <CDIcon name={CD_ACTION_ICON[kind] || "bolt"} size={16} strokeWidth={1.9} />
                        <span className="flex-1 text-left">{ACTION_LABELS[kind] || kind}</span>
                        {rec && <span className="cd-rec-tag">Recommended</span>}
                      </button>
                    );
                  })}
                </div>
                <p className="cd-caption mt-1" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <CDIcon name="shield" size={13} /> Guardrails apply — every action is reversible and
                  logged.
                </p>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------- Screen ---------- */
type Filter = "open" | "resolved" | "all";

export default function Alerts({ app }: { app: DashboardCtx }) {
  const [filter, setFilter] = useState<Filter>("open");

  // Deep-link / row-click: nav.param carries the selected alert id.
  const selected = app.nav.param ? app.alerts.find((a) => a.id === app.nav.param) : null;
  if (selected) {
    return (
      <AlertDetail app={app} alert={selected} onBack={() => app.navigate("alerts")} />
    );
  }

  const open = app.alerts.filter((a) => a.status === "open");
  const shown = (
    filter === "open"
      ? open
      : filter === "resolved"
        ? app.alerts.filter((a) => a.status !== "open")
        : app.alerts
  )
    .slice()
    .sort((a, b) => a.claude_rank - b.claude_rank);
  const atRisk = open.reduce((s, a) => s + a.dollar_impact, 0);

  // Initial load: no data yet → calm placeholder rather than an empty "All clear".
  const loading = app.loading && app.alerts.length === 0;

  return (
    <div className="cd-screen">
      <ScreenHeader
        title="Alerts"
        sub={
          loading
            ? "Scanning for issues across your accounts…"
            : `${open.length} open · ${money(atRisk)}/wk at risk if left alone`
        }
      >
        <Segmented
          small
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          options={[
            { value: "open", label: `Open (${open.length})` },
            { value: "resolved", label: "Resolved" },
            { value: "all", label: "All" },
          ]}
        />
      </ScreenHeader>
      <Card pad={false}>
        {loading ? (
          <Placeholder icon="scan" title="Loading alerts" sub="Detectors are sweeping your accounts." />
        ) : shown.length === 0 ? (
          filter === "open" ? (
            <Placeholder
              icon="check"
              title="All clear"
              sub="No open alerts. Calderyn keeps watching ad spend and inventory together."
            />
          ) : (
            <Placeholder icon="check" title="Nothing here" sub="No alerts match this filter." />
          )
        ) : (
          <div className="cd-rows">
            {shown.map((a) => (
              <AlertRow key={a.id} a={a} onClick={() => app.navigate("alerts", a.id)} />
            ))}
          </div>
        )}
      </Card>
      <p className="cd-caption" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <CDIcon name="scan" size={13} /> 12 detectors sweep every 15 minutes across Shopify, Meta,
        Google, TikTok and QuickBooks.
      </p>
    </div>
  );
}
