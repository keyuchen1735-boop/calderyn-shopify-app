import { useEffect, useRef, useState, type ReactNode } from "react";
import { IMPACT_SUFFIX } from "~/lib/impact-window";
import {
  Card,
  Pill,
  Segmented,
  Sparkline,
  PlatformMark,
  Placeholder,
} from "../ui";
import {
  money,
  alertDetectorLabel,
  ACTION_LABELS,
  timeAgo,
  evidenceLabel,
  evidenceValue,
  isInternalEvidenceKey,
} from "../format";
import { CDIcon, CD_ACTION_ICON } from "../icons";
import { actionDeepLink } from "~/lib/action-deeplinks";
import type { ActionKind, DashboardCtx } from "../context";
import type { AlertVM, CampaignVM } from "../view-models";

/* ---------- Header ---------- */
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

/* ---------- Row derivations ---------- */
// Mirror of the extension's sold-out guard (app/routes/app.alerts.$id.tsx):
// when a "may sell out" alert's stock / days-of-cover are already 0, reframe the
// headline so copy never contradicts the evidence. Engine fix flagged separately.
function isSoldOut(a: AlertVM): boolean {
  return (
    a.detector_id === "scaling_sku_fulfillment_risk" &&
    (Number(a.evidence.stock) === 0 || Number(a.evidence.days_of_cover) === 0)
  );
}

function headline(a: AlertVM): string {
  const productName = a.evidence.title || a.evidence.sku_title || a.sku || "";
  return isSoldOut(a) && productName ? `${productName} is sold out — restock now` : a.title;
}

// The only detector whose dollar figure is money to be gained rather than money
// at risk; every other alert reads "at risk".
function isUpside(a: AlertVM): boolean {
  return a.detector_id === "campaign_scaling_opportunity";
}

/* ---------- List row ---------- */
function AlertRow({ a, open, onToggle }: { a: AlertVM; open: boolean; onToggle: () => void }) {
  const resolved = a.status !== "open";
  const upside = isUpside(a);
  return (
    <button
      className="cd-row"
      onClick={onToggle}
      data-dim={resolved ? "1" : "0"}
      aria-expanded={open}
    >
      <span className={"cd-sev-bar sev-" + a.severity}></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="cd-row-title truncate">{headline(a)}</span>
          {resolved && (
            <Pill tone="success" icon="check">
              Resolved
            </Pill>
          )}
        </div>
        <div className="cd-caption truncate" style={{ marginTop: 2 }}>
          {alertDetectorLabel(a.detector_id, a.evidence) +
            " · " +
            (a.sku || a.campaign || "—") +
            " · " +
            timeAgo(a.created_at)}
        </div>
      </div>
      <div className="text-right whitespace-nowrap">
        <div
          className="cd-row-num tabular-nums"
          style={{
            color: resolved ? "var(--text-3)" : upside ? "var(--green)" : "var(--red)",
          }}
        >
          {(upside ? "+" : "") + money(a.dollar_impact)}
          <span className="cd-caption">{IMPACT_SUFFIX}</span>
        </div>
        <div className="cd-caption">{upside ? "upside" : "at risk"}</div>
      </div>
      <CDIcon
        name="chevronRight"
        size={16}
        style={{
          color: "var(--text-3)",
          flexShrink: 0,
          transition: "transform 0.18s ease",
          transform: open ? "rotate(90deg)" : "none",
        }}
      />
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

/* ---------- Expanded detail (inline, below the row) ---------- */
const EYEBROW_STYLE = {
  fontWeight: 650,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  fontSize: 10.5,
} as const;

function AlertDetail({ app, alert }: { app: DashboardCtx; alert: AlertVM }) {
  // Track the kind we attempted, so a freshly-resolved alert can read "Resolved — <label>".
  // (AlertVM has no `resolved_with` field; the shell only flips status to "resolved".)
  const [attempted, setAttempted] = useState<ActionKind | null>(null);
  const [busy, setBusy] = useState(false);
  // adjust_price confirms in a dialog (customer-visible price change). priceInput
  // is an optional override (blank → engine's restore-to-margin price).
  const [confirmPrice, setConfirmPrice] = useState(false);
  const [priceInput, setPriceInput] = useState("");
  // create_po_draft confirms in a dialog collecting quantity (+ optional cost).
  // Quantity defaults to the alert's shortfall when the evidence carries one.
  const [confirmPo, setConfirmPo] = useState(false);
  const [poQty, setPoQty] = useState(() => {
    const shortfall = Number(alert.evidence?.shortfall_units);
    return Number.isFinite(shortfall) && shortfall > 0 ? String(Math.ceil(shortfall)) : "";
  });
  const [poCost, setPoCost] = useState("");

  const resolved = alert.status !== "open";
  const resolvedLabel =
    (attempted && ACTION_LABELS[attempted]) ||
    (alert.recommended && ACTION_LABELS[alert.recommended]) ||
    "action taken";

  const soldOut = isSoldOut(alert);

  const campaign = alert.campaign_id
    ? app.campaigns.find((c) => c.id === alert.campaign_id) ?? null
    : null;
  const deepLinkDomain = app.shopDomain; // string | null; narrowed to string by the guard below

  // Merchant-facing evidence: drop raw platform IDs and empty values, then map
  // each key/value through the shared labeler/formatter (see ../format).
  const evidenceCells = Object.entries(alert.evidence).filter(
    ([k, v]) => !isInternalEvidenceKey(k) && v != null && v !== "",
  );

  // The one-line "Fix" is the primary recommended action's label: the
  // remediation plan's recommended move when a plan exists, else the legacy
  // recommended kind mapped through ACTION_LABELS.
  const plan = alert.remediation;
  const fixLabel = plan
    ? plan.moves.find((m) => m.kind === plan.recommended)?.label ?? null
    : alert.recommended
      ? ACTION_LABELS[alert.recommended] || alert.recommended
      : null;

  // adjust_price: parse the optional override (dollars → cents; blank → engine
  // suggestion) and execute. The executor bounds the price to the guardrail cap
  // and surfaces success/failure toasts via the shell.
  const runAdjustPrice = async () => {
    if (busy || resolved) return;
    const raw = priceInput.trim();
    let newPriceCents: number | undefined;
    if (raw !== "") {
      const dollars = Number(raw.replace(/^\$/, ""));
      if (!Number.isFinite(dollars) || dollars <= 0) {
        app.toast("Enter a valid price, or leave it blank for the suggested price.", "warn", "critical");
        return;
      }
      newPriceCents = Math.round(dollars * 100);
    }
    setConfirmPrice(false);
    setAttempted("adjust_price");
    setBusy(true);
    try {
      await app.executeAction(alert, "adjust_price", { newPriceCents });
    } finally {
      setBusy(false);
    }
  };

  // create_po_draft: validate quantity (digits, 1..1,000,000) and run with the
  // optional unit cost (blank → TBD). The server re-validates + builds the PO.
  const runPo = async () => {
    if (busy || resolved) return;
    const qty = poQty.trim();
    if (!/^\d+$/.test(qty) || Number(qty) <= 0 || Number(qty) > 1_000_000) {
      app.toast("Order quantity must be a positive whole number.", "warn", "critical");
      return;
    }
    const cost = poCost.trim().replace(/^\$/, "");
    if (cost !== "" && (!Number.isFinite(Number(cost)) || Number(cost) < 0)) {
      app.toast("Unit cost must be a non-negative amount, or blank for TBD.", "warn", "critical");
      return;
    }
    setConfirmPo(false);
    setAttempted("create_po_draft");
    setBusy(true);
    try {
      await app.executeAction(alert, "create_po_draft", { poQuantity: qty, poUnitCost: cost });
    } finally {
      setBusy(false);
    }
  };

  const run = async (kind: ActionKind, opts?: { campaignId?: string; loserBudgetCents?: number }) => {
    if (busy || resolved) return;
    setAttempted(kind);
    setBusy(true);
    try {
      // executeAction is async; the shell handles optimistic state + error toasts
      // internally (it does not re-throw). On success it flips alert.status to
      // "resolved" via app.alerts, which re-renders this detail. On failure the
      // status stays "open", so the buttons simply re-enable below.
      await app.executeAction(alert, kind, opts);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cd-alert-detail">
      {soldOut && (
        <p
          className="cd-body"
          style={{ color: "var(--red)", margin: "8px 0 0", maxWidth: "62ch" }}
        >
          On-hand stock is 0 — this isn&apos;t a &ldquo;may sell out&rdquo; risk, it&apos;s a
          stockout. Restock now and pause or exclude the spend until inventory is back.
        </p>
      )}
      <div
        style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-2)", maxWidth: "68ch", marginTop: 8 }}
      >
        {alert.narrative}
      </div>
      {evidenceCells.length > 0 && (
        <>
          <div className="cd-caption" style={{ ...EYEBROW_STYLE, marginTop: 12 }}>
            Evidence
          </div>
          <div className="cd-evidence">
            {evidenceCells.map(([k, v]) => (
              <div key={k} className="cd-evidence-cell">
                <div className="cd-caption">{evidenceLabel(k)}</div>
                <div className="cd-h3 tabular-nums">{evidenceValue(k, v)}</div>
              </div>
            ))}
          </div>
        </>
      )}
      {campaign && (
        <div style={{ marginTop: 10 }}>
          <LinkedCampaign app={app} campaign={campaign} />
        </div>
      )}
      {resolved ? (
        <p className="cd-caption" style={{ marginTop: 10 }}>
          This alert was resolved with{" "}
          <b style={{ color: "var(--text-1)" }}>{resolvedLabel}</b>. The action is logged in
          your audit history and can be reverted there.
        </p>
      ) : (
        <>
          {fixLabel && (
            <div
              style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 10, flexWrap: "wrap" }}
            >
              <span className="cd-caption" style={{ ...EYEBROW_STYLE, color: "var(--live)" }}>
                Fix
              </span>
              <span style={{ fontSize: 13, fontWeight: 560 }}>{fixLabel}</span>
            </div>
          )}
          {plan ? (
            <>
              {alert.rec_detail && (
                <p className="cd-body" style={{ maxWidth: "52ch", marginTop: 8 }}>
                  {alert.rec_detail}
                </p>
              )}
              <div className="flex flex-col gap-2" style={{ marginTop: 12 }}>
                {plan.moves.map((m) => {
                  const rec = m.kind === plan.recommended;
                  const executable = m.executor !== null;
                  if (executable) {
                    // Executable move: render as a button. Danger styling for
                    // destructive executors (discontinue). Phase 3 adds
                    // reallocate_spend_sku, reduce_campaign_budget, pause_campaign.
                    const isDiscontinue = m.executor === "discontinue_sku";
                    return (
                      <button
                        key={m.kind}
                        disabled={resolved || busy}
                        aria-busy={busy && attempted === m.executor}
                        className={"cd-action-btn" + (rec ? " rec" : "") + (isDiscontinue ? " danger" : "")}
                        onClick={() =>
                          m.executor === "adjust_price"
                            ? setConfirmPrice(true)
                            : run(
                                m.executor as ActionKind,
                                m.target?.loserCampaignId
                                  ? {
                                      campaignId: m.target.loserCampaignId,
                                      loserBudgetCents: m.target.loserCampaignBudgetCents,
                                    }
                                  : undefined,
                              )
                        }
                      >
                        <CDIcon name={CD_ACTION_ICON[m.executor as string] || "bolt"} size={16} strokeWidth={1.9} />
                        <span className="flex-1 text-left">{m.label}</span>
                        {rec && <span className="cd-rec-tag">Recommended</span>}
                      </button>
                    );
                  }
                  // Advisory move (executor === null): show guidance row with
                  // ineligibleReason when set (rule 12 — never a dead button).
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
                      {m.ineligibleReason && (
                        <span className="cd-caption" style={{ color: "var(--text-3)", flexShrink: 0, maxWidth: "32ch", textAlign: "right" }}>
                          {m.ineligibleReason}
                        </span>
                      )}
                      {m.deepLink && (
                        <a
                          href={m.deepLink.href}
                          target={m.deepLink.external ? "_blank" : undefined}
                          rel={m.deepLink.external ? "noopener noreferrer" : undefined}
                          className="cd-move-link"
                          style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, color: "var(--accent)" }}
                        >
                          {m.deepLink.label}
                          <CDIcon name="arrowUpRight" size={14} strokeWidth={1.9} />
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
              {confirmPrice && (
                <div
                  className="cd-move-row"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    padding: "12px",
                    borderRadius: 10,
                    border: "1px solid var(--border)",
                    background: "var(--surface-2)",
                    marginTop: 8,
                  }}
                >
                  <span className="cd-caption">
                    This changes the live selling price on Shopify to restore this product&apos;s
                    margin. Leave the field blank to use the suggested price, or set your own
                    (within your price-change guardrail). Reversible from your action history.
                  </span>
                  <label className="cd-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <span className="cd-caption">New price</span>
                    <input
                      className="cd-input tabular-nums"
                      type="number"
                      min={0}
                      step={0.01}
                      inputMode="decimal"
                      placeholder="Suggested"
                      value={priceInput}
                      disabled={busy}
                      onChange={(e) => setPriceInput(e.target.value)}
                    />
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      className="cd-action-btn rec"
                      disabled={busy}
                      aria-busy={busy}
                      onClick={runAdjustPrice}
                      style={{ flex: "0 0 auto", width: "auto" }}
                    >
                      <CDIcon name="tag" size={16} strokeWidth={1.9} />
                      <span>{busy ? "Updating…" : "Update price"}</span>
                    </button>
                    <button
                      className="cd-action-btn"
                      disabled={busy}
                      onClick={() => {
                        setConfirmPrice(false);
                        setPriceInput("");
                      }}
                      style={{ flex: "0 0 auto", width: "auto" }}
                    >
                      <span>Cancel</span>
                    </button>
                  </div>
                </div>
              )}
              <p className="cd-caption" style={{ marginTop: 10, display: "flex", gap: 6, alignItems: "center" }}>
                <CDIcon name="shield" size={13} /> Guardrails apply — every action is reversible and
                logged. Advisory moves are guidance; the highlighted action runs with one click.
              </p>
            </>
          ) : (
            <>
              {alert.rec_detail && (
                <p className="cd-caption" style={{ marginTop: 8 }}>
                  {alert.rec_detail}
                </p>
              )}
              <div className="flex flex-col gap-2" style={{ marginTop: 12 }}>
                {alert.actions.map((kind) => {
                  const rec = kind === alert.recommended;
                  return (
                    <button
                      key={kind}
                      disabled={resolved || busy}
                      aria-busy={busy && attempted === kind}
                      className={"cd-action-btn" + (rec ? " rec" : "")}
                      onClick={() =>
                        kind === "create_po_draft"
                          ? setConfirmPo(true)
                          : run(kind as ActionKind)
                      }
                    >
                      <CDIcon name={CD_ACTION_ICON[kind] || "bolt"} size={16} strokeWidth={1.9} />
                      <span className="flex-1 text-left">{ACTION_LABELS[kind] || kind}</span>
                      {rec && <span className="cd-rec-tag">Recommended</span>}
                    </button>
                  );
                })}
              </div>
              {deepLinkDomain && (alert.deepLinkKinds ?? []).length > 0 && (
                <div className="flex flex-col gap-2" style={{ marginTop: 8 }}>
                  {alert.deepLinkKinds!.map((kind) => {
                    const dl = actionDeepLink(kind, deepLinkDomain);
                    if (!dl) return null;
                    return (
                      <a
                        key={kind}
                        href={dl.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="cd-action-btn"
                        style={{ textDecoration: "none" }}
                      >
                        <CDIcon name="arrowUpRight" size={16} strokeWidth={1.9} />
                        <span className="flex-1 text-left">{dl.label}</span>
                      </a>
                    );
                  })}
                </div>
              )}
              {confirmPo && (
                <div
                  className="cd-move-row"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    padding: "12px",
                    borderRadius: 10,
                    border: "1px solid var(--border)",
                    background: "var(--surface-2)",
                    marginTop: 8,
                  }}
                >
                  <span className="cd-caption">
                    Drafts a purchase order for this product and records it in your action
                    history, where the PDF can be downloaded. Review and send to your supplier
                    manually — nothing is ordered automatically.
                  </span>
                  <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
                    <label className="cd-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <span className="cd-caption">Quantity</span>
                      <input
                        className="cd-input tabular-nums"
                        type="number"
                        min={1}
                        max={1_000_000}
                        value={poQty}
                        disabled={busy}
                        onChange={(e) => setPoQty(e.target.value)}
                      />
                    </label>
                    <label className="cd-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <span className="cd-caption">Unit cost</span>
                      <input
                        className="cd-input tabular-nums"
                        type="number"
                        min={0}
                        step={0.01}
                        placeholder="TBD"
                        value={poCost}
                        disabled={busy}
                        onChange={(e) => setPoCost(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="cd-action-btn rec"
                      disabled={busy}
                      aria-busy={busy}
                      onClick={runPo}
                      style={{ flex: "0 0 auto", width: "auto" }}
                    >
                      <CDIcon name="doc" size={16} strokeWidth={1.9} />
                      <span>{busy ? "Drafting…" : "Create PO draft"}</span>
                    </button>
                    <button
                      className="cd-action-btn"
                      disabled={busy}
                      onClick={() => setConfirmPo(false)}
                      style={{ flex: "0 0 auto", width: "auto" }}
                    >
                      <span>Cancel</span>
                    </button>
                  </div>
                </div>
              )}
              <p className="cd-caption" style={{ marginTop: 10, display: "flex", gap: 6, alignItems: "center" }}>
                <CDIcon name="shield" size={13} /> Guardrails apply — every action is reversible and
                logged.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ---------- Screen ---------- */
type Filter = "open" | "resolved" | "all";

export default function Alerts({ app }: { app: DashboardCtx }) {
  const [filter, setFilter] = useState<Filter>("open");

  // Deep-link / row-click: nav.param carries the expanded alert id. Expansion
  // rides the URL so /dashboard/alerts/:id links keep working, and the shell's
  // enriched-alert fetch (keyed on nav.param) still fires when a row opens.
  const expandedId = app.nav.param;

  // Keep the expanded row on screen: a click below the fold stays put (row
  // already visible → "nearest" is a no-op) and a deep link scrolls down to
  // the opened detail instead of stranding it below the fold.
  const expandedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (expandedId) {
      expandedRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [expandedId]);

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
  // A deep-linked alert must stay visible even when the current filter would
  // hide it (e.g. a resolved alert opened from an old link while on "Open").
  const expanded = expandedId ? app.alerts.find((a) => a.id === expandedId) ?? null : null;
  const rows = expanded && !shown.some((a) => a.id === expanded.id) ? [expanded, ...shown] : shown;
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
            : `${open.length} open · ${money(atRisk)}${IMPACT_SUFFIX} at risk if left alone`
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
        ) : rows.length === 0 ? (
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
            {rows.map((a) => (
              <div key={a.id} ref={a.id === expandedId ? expandedRef : undefined}>
                <AlertRow
                  a={a}
                  open={a.id === expandedId}
                  onToggle={() =>
                    // In-place expansion: keep the pane where the user is
                    // instead of navigate()'s default jump to top.
                    app.navigate("alerts", a.id === expandedId ? null : a.id, null, {
                      preserveScroll: true,
                    })
                  }
                />
                {a.id === expandedId && <AlertDetail app={app} alert={a} />}
              </div>
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
