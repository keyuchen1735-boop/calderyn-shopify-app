import { useEffect, useRef, useState, type ReactNode } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Card, Pill, Segmented, Placeholder, TableSkeleton } from "../ui";
import { money, alertDetectorLabel, ACTION_LABELS, timeAgo } from "../format";
import { CDIcon, CD_ACTION_ICON } from "../icons";
import { actionDeepLink } from "~/lib/action-deeplinks";
import type { ActionKind, DashboardCtx } from "../context";
import type { AlertVM } from "../view-models";

gsap.registerPlugin(useGSAP);

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
    <header className="cd-screen-head cd-alerts-head" data-screen-label={title}>
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
function AlertRow({ a, open, detailId, onToggle }: { a: AlertVM; open: boolean; detailId: string; onToggle: () => void }) {
  const resolved = a.status !== "open";
  const upside = isUpside(a);
  const detector = alertDetectorLabel(a.detector_id, a.evidence);
  return (
    <button
      className="cd-row cd-alert-row"
      onClick={onToggle}
      data-dim={resolved ? "1" : "0"}
      aria-expanded={open}
      aria-controls={detailId}
      aria-label={`${headline(a)}. ${detector}. ${timeAgo(a.created_at)}. ${(upside ? "Upside " : "At risk ") + money(a.dollar_impact)} over 30 days.`}
    >
      <span className={"cd-sev-bar sev-" + a.severity} aria-hidden="true"></span>
      <div className="cd-alert-main min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="cd-row-title truncate">{headline(a)}</span>
          {resolved && (
            <Pill tone="success" icon="check">
              Resolved
            </Pill>
          )}
        </div>
        <div className="cd-alert-meta cd-caption truncate">
          <span className="truncate">{detector}</span>
          <span className="cd-alert-meta-dot" aria-hidden="true">·</span>
          <span className="cd-alert-age">{timeAgo(a.created_at)}</span>
        </div>
      </div>
      <div
        className="cd-alert-impact text-right whitespace-nowrap"
        data-upside={upside ? "1" : "0"}
        data-resolved={resolved ? "1" : "0"}
        title={`${upside ? "Upside" : "At risk"} over 30 days`}
      >
        <div className="cd-row-num tabular-nums">
          {(upside ? "+" : "") + money(a.dollar_impact)}
        </div>
      </div>
      <span className="cd-alert-chevron" aria-hidden="true">
        <CDIcon name="chevronRight" size={16} />
      </span>
    </button>
  );
}

/* ---------- Expanded detail (inline, below the row) ---------- */
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
  const context = [alert.sku, alert.campaign].filter(Boolean).join(" · ");

  // Weather predictions mirror into the feed as weather_reallocation alerts
  // (pending ones only — armed/auto moves live on the Weather tab); their
  // actions run against the underlying suggestion row, not an ActionKind
  // executor. Legacy rows without a suggestion_id deep-link to the Weather tab.
  const isWeather = alert.detector_id === "weather_reallocation";
  const weatherSuggestionId = alert.evidence?.suggestion_id ?? "";
  const runWeather = async (intent: "apply" | "arm" | "dismiss") => {
    if (busy || resolved) return;
    setBusy(true);
    try {
      await app.weatherIntent(weatherSuggestionId, intent);
    } finally {
      setBusy(false);
    }
  };

  const deepLinkDomain = app.shopDomain; // string | null; narrowed to string by the guard below

  const plan = alert.remediation;

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
        <p className="cd-alert-urgent cd-body">
          Out of stock now. Restock and pause related spend until inventory returns.
        </p>
      )}
      <p className="cd-alert-narrative">{alert.narrative}</p>
      {context && <p className="cd-alert-context cd-caption">{context}</p>}
      {resolved ? (
        isWeather ? (
          // Schedule/reject write no audit row, and a scheduled move's control
          // (Cancel) lives on the Weather tab — don't point at Audit.
          <p className="cd-alert-resolution cd-caption">
            Handled. Manage scheduled moves in Weather.
          </p>
        ) : (
          <p className="cd-alert-resolution cd-caption">
            Resolved with <b>{resolvedLabel}</b>. View or undo it in Action history.
          </p>
        )
      ) : isWeather ? (
        <div className="cd-alert-actions">
          {weatherSuggestionId ? (
            <>
              <button
                disabled={busy}
                aria-busy={busy}
                aria-label="Schedule when confirmed, recommended"
                className="cd-action-btn rec"
                onClick={() => runWeather("arm")}
              >
                <CDIcon name="bolt" size={16} strokeWidth={1.9} />
                <span className="flex-1 text-left">Schedule when confirmed</span>
              </button>
              <button
                disabled={busy}
                aria-busy={busy}
                className="cd-action-btn"
                onClick={() => runWeather("apply")}
              >
                <CDIcon name="swap" size={16} strokeWidth={1.9} />
                <span className="flex-1 text-left">Shift {money(alert.dollar_impact)}/day now</span>
              </button>
              <button
                disabled={busy}
                className="cd-action-btn"
                onClick={() => runWeather("dismiss")}
              >
                <CDIcon name="x" size={16} strokeWidth={1.9} />
                <span className="flex-1 text-left">Reject</span>
              </button>
            </>
          ) : (
            <button
              className="cd-action-btn"
              onClick={() => app.navigate("customers", null, "weather")}
            >
              <CDIcon name="rain" size={16} strokeWidth={1.9} />
              <span className="flex-1 text-left">Review on the Weather tab</span>
            </button>
          )}
        </div>
      ) : (
        <>
          {plan ? (
            <>
              <div className="cd-alert-actions">
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
                        aria-label={rec ? `${m.label}, recommended` : m.label}
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
                    Use the suggested price or enter your own within the price-change guardrail.
                    You can undo this from Action history.
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
            </>
          ) : (
            <>
              <div className="cd-alert-actions">
                {alert.actions.map((kind) => {
                  const rec = kind === alert.recommended;
                  return (
                    <button
                      key={kind}
                      disabled={resolved || busy}
                      aria-busy={busy && attempted === kind}
                      aria-label={rec ? `${ACTION_LABELS[kind] || kind}, recommended` : ACTION_LABELS[kind] || kind}
                      className={"cd-action-btn" + (rec ? " rec" : "")}
                      onClick={() =>
                        kind === "create_po_draft"
                          ? setConfirmPo(true)
                          : run(kind as ActionKind)
                      }
                    >
                      <CDIcon name={CD_ACTION_ICON[kind] || "bolt"} size={16} strokeWidth={1.9} />
                      <span className="flex-1 text-left">{ACTION_LABELS[kind] || kind}</span>
                    </button>
                  );
                })}
              </div>
              {deepLinkDomain && (alert.deepLinkKinds ?? []).length > 0 && (
                <div className="cd-alert-actions cd-alert-actions-secondary">
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
                    Creates a downloadable draft only. Review and send it to your supplier yourself.
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
            </>
          )}
        </>
      )}
    </div>
  );
}

function AlertItem({ a, app, open }: { a: AlertVM; app: DashboardCtx; open: boolean }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const closingRef = useRef(false);
  const detailId = `alert-detail-${a.id}`;

  useEffect(() => {
    if (open) rootRef.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  const { contextSafe } = useGSAP(
    () => {
      const chevron = rootRef.current?.querySelector<HTMLElement>(".cd-alert-chevron");
      const detail = detailRef.current;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      closingRef.current = false;
      if (rootRef.current) rootRef.current.dataset.closing = "0";
      if (chevron) {
        if (reduceMotion) gsap.set(chevron, { rotation: open ? 90 : 0 });
        else gsap.to(chevron, { rotation: open ? 90 : 0, duration: 0.24, ease: "power2.out", overwrite: "auto" });
      }
      if (!open || !detail) return;

      const inner = detail.firstElementChild;
      if (reduceMotion) {
        gsap.set(detail, { height: "auto" });
        return;
      }

      const tl = gsap.timeline({ defaults: { ease: "power2.out" } });
      tl.fromTo(detail, { height: 0 }, { height: detail.scrollHeight, duration: 0.3, clearProps: "height" });
      if (inner) {
        tl.fromTo(
          inner,
          { autoAlpha: 0, y: -6 },
          { autoAlpha: 1, y: 0, duration: 0.24, clearProps: "opacity,visibility,transform" },
          "<0.05",
        );
      }
    },
    { scope: rootRef, dependencies: [open], revertOnUpdate: true },
  );

  const toggle = contextSafe(() => {
    if (closingRef.current) return;
    if (!open) {
      app.navigate("alerts", a.id, null, { preserveScroll: true });
      return;
    }

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      app.navigate("alerts", null, null, { preserveScroll: true });
    };
    const detail = detailRef.current;
    const inner = detail?.firstElementChild;
    if (!detail || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      close();
      return;
    }

    closingRef.current = true;
    if (rootRef.current) rootRef.current.dataset.closing = "1";
    gsap.killTweensOf([detail, inner]);
    const tl = gsap.timeline({
      defaults: { ease: "power2.inOut" },
      onComplete: close,
      onInterrupt: close,
    });
    if (inner) tl.to(inner, { autoAlpha: 0, y: -4, duration: 0.15 });
    tl.to(detail, { height: 0, duration: 0.22 }, inner ? "<0.02" : 0);
  });

  return (
    <div ref={rootRef} className="cd-alert-item" data-open={open ? "1" : "0"} data-resolved={a.status === "open" ? "0" : "1"}>
      <AlertRow a={a} open={open} detailId={detailId} onToggle={toggle} />
      {open && (
        <div ref={detailRef} id={detailId} className="cd-alert-detail-motion">
          <AlertDetail app={app} alert={a} />
        </div>
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
    <div className="cd-screen cd-alerts">
      <ScreenHeader
        title="Alerts"
        sub={
          loading
            ? "Scanning for issues across your accounts…"
            : `${open.length} open · ${money(atRisk)} at risk over 30 days`
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
      <Card pad={false} className="cd-alerts-card">
        {loading ? (
          <TableSkeleton />
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
          <div className="cd-rows cd-alert-list">
            {rows.map((a) => (
              <AlertItem key={a.id} a={a} app={app} open={a.id === expandedId} />
            ))}
          </div>
        )}
      </Card>
      <p className="cd-alerts-foot cd-caption">
        <CDIcon name="scan" size={13} /> 12 detectors · refreshed every 15 min
      </p>
    </div>
  );
}
