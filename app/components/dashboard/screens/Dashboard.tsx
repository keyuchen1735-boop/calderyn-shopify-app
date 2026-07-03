import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn, Card, Placeholder } from "../ui";
import { CDIcon, CD_ACTION_ICON } from "../icons";
import { money } from "../format";
import * as client from "~/lib/dashboard/client";
import { useLiveAnalytics } from "../use-live-analytics";
import type { ActionKind, DashboardCtx } from "../context";
import type { ProductSummaryVM } from "~/lib/dashboard/client";

// Kinds that are safe to run one-click from the home card: no dialog inputs
// (adjust_price shows a price, create_po_draft asks quantity/cost — those
// review steps live on the Autopilot inspector / Alerts detail, so the card
// routes there instead of silently executing with defaults).
const ONE_CLICK_KINDS: ActionKind[] = [
  "pause_campaign",
  "reduce_campaign_budget",
  "increase_campaign_budget",
  "exclude_geo",
  "reallocate_inventory",
  "discontinue_sku",
  "reallocate_spend_sku",
];

function oneClickKind(k: string): k is ActionKind {
  return (ONE_CLICK_KINDS as string[]).includes(k);
}

const CAMPAIGN_KINDS = new Set(["pause_campaign", "reduce_campaign_budget", "increase_campaign_budget", "exclude_geo"]);

/** Circular calibration gauge (ticks + arc + knob), driven by a real pct. */
function CalibGauge({ pct, size }: { pct: number; size: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const ticks = useMemo(() => {
    const out: { x1: string; y1: string; x2: string; y2: string; lit: boolean }[] = [];
    for (let i = 0; i < 60; i++) {
      const a = -Math.PI / 2 + (i / 60) * Math.PI * 2;
      const lit = (i / 60) * 100 <= clamped + 0.01;
      const r1 = 93;
      const r2 = 82;
      out.push({
        x1: (100 + r1 * Math.cos(a)).toFixed(2),
        y1: (100 + r1 * Math.sin(a)).toFixed(2),
        x2: (100 + r2 * Math.cos(a)).toFixed(2),
        y2: (100 + r2 * Math.sin(a)).toFixed(2),
        lit,
      });
    }
    return out;
  }, [clamped]);
  const arcOffset = (100 - clamped).toFixed(2);
  const deg = ((clamped / 100) * 360).toFixed(2);
  return (
    <div className="cd-gauge cd-gauge-sm" style={{ width: size, height: size }}>
      <svg viewBox="0 0 200 200" width={size} height={size} fill="none">
        <defs>
          <linearGradient id="cdMcGauge" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="color-mix(in oklch, var(--live) 42%, #ffffff)" />
            <stop offset="1" stopColor="var(--live)" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <line
            key={i}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            stroke={t.lit ? "var(--live)" : "var(--gauge-dim)"}
            strokeWidth={t.lit ? 2.6 : 2}
            strokeLinecap="round"
          />
        ))}
        <circle cx="100" cy="100" r="72" stroke="var(--gauge-track)" strokeWidth="6" />
        <circle
          className="cd-gauge-arc"
          cx="100"
          cy="100"
          r="72"
          pathLength={100}
          stroke="url(#cdMcGauge)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray="100"
          strokeDashoffset={arcOffset}
          transform="rotate(-90 100 100)"
        />
        <g className="cd-gauge-dot" style={{ transform: `rotate(${deg}deg)` }}>
          <circle cx="100" cy="28" r="11" fill="var(--live)" opacity="0.22" />
          <circle cx="100" cy="28" r="5" fill="var(--gauge-knob)" />
        </g>
      </svg>
      <div className="cd-gauge-c">
        <div className="cd-gauge-num">
          <b>{Math.round(clamped)}</b>
          <i>%</i>
        </div>
      </div>
    </div>
  );
}

// Mission Control — the calm home. Real today-numbers up top, the action queue
// as a to-do grid, the autopilot trust dial, a collapsible live strip over the
// engine trace, and a storefront card. Everything binds to live endpoints.
export default function Dashboard({ app }: { app: DashboardCtx }) {
  // Time-of-day greeting resolves the local hour POST-MOUNT only (SSR renders
  // "Welcome back") to avoid a UTC-vs-local hydration mismatch.
  const [clientHour, setClientHour] = useState<number | null>(null);
  useEffect(() => setClientHour(new Date().getHours()), []);
  const greet =
    clientHour === null
      ? "Welcome back"
      : clientHour < 12
        ? "Good morning"
        : clientHour < 17
          ? "Good afternoon"
          : "Good evening";

  // Today's store numbers (owned storefront events + orders). The shared hook
  // brings the 60s visibility-gated poll, focus-refetch cooldown, monotonic
  // response ordering, and the realtime order ping — same live contract as the
  // Analytics Live subtab. The strip renders em dashes until numbers arrive.
  const { snapshot: live } = useLiveAnalytics(true);

  // Storefront card: real catalog products (title + image), no invented prices.
  const [products, setProducts] = useState<ProductSummaryVM[] | null>(null);
  useEffect(() => {
    let alive = true;
    client
      .fetchProducts()
      .then((p) => {
        if (alive) setProducts(p.products.slice(0, 3));
      })
      .catch(() => {
        if (alive) setProducts([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const [stripOpen, setStripOpen] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);

  // One-click is only offered when the client can actually run the action
  // here: a whitelisted kind, the alert loaded, and (for campaign kinds) a
  // resolvable campaign id. Everything else renders "Review" and opens the
  // Autopilot inspector — never a button that can't succeed, never a silent
  // default on a kind that deserves a review step (price, PO quantities).
  const canOneClick = useCallback(
    (alertId: string, kind: string): boolean => {
      if (!oneClickKind(kind)) return false;
      const alert = app.alerts.find((a) => a.id === alertId);
      if (!alert) return false;
      if (CAMPAIGN_KINDS.has(kind) && !alert.campaign_id) return false;
      if (kind === "exclude_geo" && !alert.region) return false;
      return true;
    },
    [app.alerts],
  );

  const approve = useCallback(
    async (alertId: string, kind: string) => {
      const alert = app.alerts.find((a) => a.id === alertId);
      if (!alert || !oneClickKind(kind) || !canOneClick(alertId, kind)) {
        app.navigate("autopilot");
        return;
      }
      setApproving(alertId);
      try {
        const { ok } = await app.executeAction(alert, kind);
        if (ok) app.refresh();
      } finally {
        setApproving(null);
      }
    },
    [app, canOneClick],
  );

  const conversion =
    live && live.sessions_today > 0
      ? ((live.funnel.purchased_sessions / live.sessions_today) * 100).toFixed(1) + "%"
      : null;

  const todo = app.actionQueue.slice(0, 2);
  const lastDone = app.audit.find((a) => a.outcome === "succeeded");
  const pct = app.calibration?.pct ?? app.liveEngine?.calibrationPct ?? null;
  const graduated = pct !== null && pct >= 100;
  const atRiskCents = app.actionQueue.reduce((a, p) => a + (p.dollar_impact || 0), 0);
  const engine = app.liveEngine;
  const trace = engine?.trace.slice(0, 5) ?? [];

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" style={{ alignItems: "flex-start", marginBottom: 8 }} data-screen-label="Mission Control">
        <div>
          <h1 className="cd-display">
            {greet},<span className="cd-display-it"> welcome back.</span>
          </h1>
        </div>
      </header>

      <button type="button" className="cd-daterange" onClick={() => app.navigate("analytics", null, "live")}>
        <span className={"cd-live-dot" + (live ? " on" : "")} />
        <span style={{ whiteSpace: "nowrap" }}>Today · live view</span>
        <CDIcon name="chevronRight" size={14} strokeWidth={1.9} style={{ color: "var(--text-3)" }} />
      </button>

      <div className="cd-kstrip" style={{ marginTop: 12 }}>
        <div className="cd-kcell">
          <span className="cd-kcell-l">Revenue · today</span>
          <span className="cd-kcell-v tabular-nums">
            {live ? money(live.total_sales_today_cents) : "—"}
          </span>
        </div>
        <div className="cd-kcell">
          <span className="cd-kcell-l">Orders · today</span>
          <span className="cd-kcell-v tabular-nums">{live ? live.orders_today : "—"}</span>
        </div>
        <div className="cd-kcell">
          <span className="cd-kcell-l">Conversion · today</span>
          <span className="cd-kcell-v tabular-nums">{conversion ?? "—"}</span>
          {live && !conversion && <span className="cd-caption">no sessions yet today</span>}
        </div>
      </div>

      <div className="cd-grid-main" style={{ marginTop: 16 }}>
        <Card className="cd-pad-lg cd-todo-card" pad={false}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
            <h2 className="cd-h2">To do</h2>
            <span className="cd-caption">
              {app.actionQueue.length > 0
                ? `${app.actionQueue.length} waiting on you`
                : "nothing waiting on you"}
            </span>
          </div>
          <div className="cd-todo-grid">
            {todo.map((p) => (
              <div key={p.alertId} className="cd-todo">
                <div className="cd-todo-top">
                  <span className="cd-todo-ico">
                    <CDIcon name={CD_ACTION_ICON[p.action_kind] ?? "bolt"} size={18} strokeWidth={1.8} />
                  </span>
                  <button
                    type="button"
                    aria-label="Review in Autopilot"
                    style={{ border: 0, background: "none", cursor: "pointer", color: "var(--text-3)", padding: 2 }}
                    onClick={() => app.navigate("autopilot")}
                  >
                    <CDIcon name="arrowUpRight" size={16} strokeWidth={1.9} />
                  </button>
                </div>
                <div>
                  <div className="cd-todo-title">{p.title}</div>
                  <div className="cd-todo-sub">{p.reasoning}</div>
                </div>
                <div className="cd-todo-foot" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {canOneClick(p.alertId, p.action_kind) ? (
                    <Btn
                      kind="primary"
                      small
                      disabled={approving === p.alertId}
                      onClick={() => approve(p.alertId, p.action_kind)}
                    >
                      {approving === p.alertId ? "Approving…" : "Approve"}
                    </Btn>
                  ) : (
                    <Btn kind="primary" small onClick={() => app.navigate("autopilot")}>
                      Review
                    </Btn>
                  )}
                  {p.dollar_impact > 0 && (
                    <span className="cd-todo-money" style={{ color: "var(--orange)" }}>
                      {money(p.dollar_impact)}
                    </span>
                  )}
                </div>
              </div>
            ))}
            {lastDone && (
              <div className="cd-todo">
                <div className="cd-todo-top">
                  <span className="cd-todo-ico" style={{ background: "var(--green-bg)", color: "var(--green)" }}>
                    <CDIcon name="check" size={18} strokeWidth={1.9} />
                  </span>
                  <button
                    type="button"
                    aria-label="Open history"
                    style={{ border: 0, background: "none", cursor: "pointer", color: "var(--text-3)", padding: 2 }}
                    onClick={() => app.navigate("audit")}
                  >
                    <CDIcon name="arrowUpRight" size={16} strokeWidth={1.9} />
                  </button>
                </div>
                <div>
                  <div className="cd-todo-title">{lastDone.verb}</div>
                  <div className="cd-todo-sub">{lastDone.target}</div>
                </div>
                <div className="cd-todo-foot">
                  <span className="cd-todo-money" style={{ color: "var(--green)" }}>
                    Done{lastDone.dollar_impact_at_exec ? ` · ${money(lastDone.dollar_impact_at_exec)}` : ""}
                  </span>
                </div>
              </div>
            )}
            {todo.length === 0 && !lastDone && (
              <div className="cd-todo" style={{ gridColumn: "1 / -1" }}>
                <Placeholder
                  icon="check"
                  title="All clear"
                  sub="Nothing needs you right now. Calderyn keeps watching."
                />
              </div>
            )}
          </div>
        </Card>

        <Card
          className="cd-pad-lg cd-apside"
          pad={false}
          onClick={() => app.navigate("autopilot")}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 5 }}>
            <span
              className="cd-caption"
              style={{ fontWeight: 650, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-3)" }}
            >
              Autopilot
            </span>
            <CDIcon name="chevronRight" size={13} strokeWidth={2} style={{ color: "var(--text-3)" }} />
          </div>
          {graduated && engine ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 18, margin: "auto 0" }}>
              <div>
                <div className="cd-caption" style={{ textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 650 }}>
                  Protected · 7d
                </div>
                <div
                  className="tabular-nums"
                  style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.1, color: "var(--green)", marginTop: 3 }}
                >
                  {money(engine.moneyProtectedWeekCents)}
                </div>
              </div>
              <div>
                <div className="cd-caption" style={{ textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 650 }}>
                  Waiting on you
                </div>
                <div
                  className="tabular-nums"
                  style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.1, color: "var(--orange)", marginTop: 3 }}
                >
                  {money(atRiskCents)}
                </div>
              </div>
            </div>
          ) : pct !== null ? (
            <div style={{ alignSelf: "center", margin: "auto 0" }}>
              <CalibGauge pct={pct} size={150} />
              <div className="cd-caption" style={{ textAlign: "center", marginTop: 8 }}>
                calibration score
              </div>
            </div>
          ) : (
            <Placeholder
              icon="bolt"
              title="Calibrating"
              sub="Approve suggestions to teach autopilot."
            />
          )}
        </Card>
      </div>

      {/* Live strip — collapsed one-liner over the real engine trace. */}
      <Card className="cd-livestrip" pad={false}>
        <button type="button" className="cd-ls-head" onClick={() => setStripOpen((v) => !v)}>
          <span className={"cd-live-dot" + (engine?.autopilotEnabled ? " on" : "")} />
          <span className="cd-ls-title">
            {engine
              ? engine.autopilotEnabled
                ? "Calderyn is watching"
                : "Autopilot is paused"
              : "Connecting to the engine"}
          </span>
          <span style={{ flex: 1 }} />
          <span className="cd-ls-money tabular-nums">
            {engine ? money(engine.moneyProtectedWeekCents) : "—"} <em>protected · 7d</em>
          </span>
          <span className="cd-ls-toggle">
            <CDIcon name={stripOpen ? "chevronDown" : "chevronRight"} size={14} strokeWidth={2} />
          </span>
        </button>
        {stripOpen && (
          <div style={{ borderTop: "0.5px solid var(--hairline-strong)" }}>
            {trace.length === 0 ? (
              <Placeholder icon="scan" title="No engine activity yet" sub="Recent scans and actions land here." />
            ) : (
              trace.map((t) => (
                <div key={t.id} className="cd-punch-row" style={{ padding: "10px 22px" }}>
                  <span
                    className="cd-punch-ico"
                    data-k={t.tag === "BLOCKED" ? "need" : t.moneyCents > 0 ? "done" : "prog"}
                  >
                    <CDIcon name={CD_ACTION_ICON[t.actionKind] ?? "scan"} size={15} strokeWidth={1.9} />
                  </span>
                  <div className="cd-punch-body">
                    <div className="cd-punch-title">{t.text}</div>
                    <div className="cd-punch-sub">{t.signal}</div>
                  </div>
                  {t.moneyCents !== 0 && (
                    <span
                      className="cd-ls-money tabular-nums"
                      style={{ color: t.moneyCents > 0 ? "var(--green)" : "var(--orange)" }}
                    >
                      {money(t.moneyCents)}
                    </span>
                  )}
                  <span className="cd-eftime" style={{ color: "var(--text-3)" }}>
                    {t.rel}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </Card>

      {/* Storefront */}
      <Card className="cd-pad-lg" pad={false}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <h2 className="cd-serif-h">Storefront</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn
              small
              onClick={() => window.open("/storefront", "_blank", "noopener")}
            >
              View live
            </Btn>
            <Btn kind="primary" small onClick={() => app.navigate("storefront")}>
              Open studio
            </Btn>
          </div>
        </div>
        <div className="cd-browser">
          <div className="cd-browser-bar">
            <span className="cd-dot3">
              <i style={{ background: "#FF5F57" }} />
              <i style={{ background: "#FEBC2E" }} />
              <i style={{ background: "#28C840" }} />
            </span>
            <span className="cd-url">{app.storeLabel}</span>
          </div>
          {products === null ? (
            <Placeholder icon="store" title="Loading your catalog" />
          ) : products.length === 0 ? (
            <Placeholder
              icon="store"
              title="No products yet"
              sub="Add products or import them from Shopify to see your storefront here."
            />
          ) : (
            <div className="cd-store-grid">
              {products.map((p) => (
                <div key={p.id}>
                  {p.imageUrl ? (
                    <img
                      src={p.imageUrl}
                      alt={p.title}
                      style={{ display: "block", width: "100%", height: 96, objectFit: "cover", borderRadius: 10 }}
                    />
                  ) : (
                    <div style={{ width: "100%", height: 96, borderRadius: 10, background: "var(--gray-bg)" }} />
                  )}
                  <div className="cd-store-prod-name">{p.title}</div>
                  <div className="cd-store-prod-price">{p.status === "active" ? "Active" : p.status}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
