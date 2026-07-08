import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Btn, Card, SkelBar, TickGauge } from "../ui";
import { hasEngineSignals } from "../first-run";
import { reduced } from "../hero/hero-motion";
import { CDIcon } from "../icons";
import { money } from "../format";
import { CalderynHexMark } from "~/components/CalderynHexMark";
import * as client from "~/lib/dashboard/client";
import { fetchCommerceAnalytics } from "~/lib/dashboard/commerce-analytics-client";
import type { CommerceAnalytics } from "~/lib/dashboard/commerce-analytics-client";
import {
  analyticsCacheKey,
  cacheScreenData,
  cachedScreenData,
  catalogCacheKey,
  prefetchScreenData,
  SCREEN_CACHE_KEYS,
} from "~/lib/dashboard/screen-cache";
import { canOneClickAlert, oneClickKind } from "~/lib/dashboard/one-click";
import { actionTier } from "~/lib/calibration/confidence";
import { recoveredWithin } from "~/lib/recovered";
import { sparklinePath } from "~/lib/sparkline";
import { useLiveAnalytics } from "../use-live-analytics";
import type { DashboardCtx } from "../context";
import type { BillingStatus, ProductSummaryVM } from "~/lib/dashboard/client";
import type { QueueProposalVM } from "../view-models";

// How many queue items get their own deck card per session; the reversible
// one-click remainder folds into a single batch card so a deep queue never
// becomes an inbox. Judgment calls (review kinds) always get their own card.
const DECK_TOP_N = 3;

/** Small brand mark used as the live-status indicator. Monochrome: ink when
 *  live (pulses via .cd-live-mark.on), muted when dormant. */
function LiveMark({ on }: { on: boolean }) {
  return (
    <span className={"cd-live-mark" + (on ? " on" : "")} aria-hidden="true">
      <CalderynHexMark size={13} fill="currentColor" stroke="var(--card-solid)" />
    </span>
  );
}

/** Tiny sparkline over a daily series; shares the extension's path geometry
 *  (app/lib/sparkline.ts) so both surfaces draw the same shape. Renders an
 *  empty box until data lands so the strip never reflows. */
const Spark = memo(function Spark({ points }: { points: number[] }) {
  const d = sparklinePath(points, 100, 18);
  return (
    <svg className="cd-hmet-spark" viewBox="0 0 100 18" preserveAspectRatio="none" fill="none" aria-hidden="true">
      {d && <path d={d} stroke="var(--live)" strokeWidth="1.5" />}
    </svg>
  );
});

// Home — the calm landing screen. Greeting with the agent's one-liner, a
// compact today strip, the decision deck (one ask at a time), the autopilot
// card, and a prompt bar into the assistant. New stores get the setup guide.
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

  // Today's store numbers (owned storefront events + orders); shared live
  // contract with the Analytics Live subtab (60s visibility-gated poll +
  // realtime order ping). Cells render em dashes until numbers arrive.
  const { snapshot: live } = useLiveAnalytics(true);

  // 30-day daily series for the metric sparklines — same request/key as the
  // Analytics screen's default range. Rides prefetchScreenData so it dedups
  // against the idle warm-up and skips entirely when the cache is already
  // warm; session-stale is fine for a trend line (it's an enhancement).
  const [commerce, setCommerce] = useState<CommerceAnalytics | null>(() =>
    cachedScreenData<CommerceAnalytics>(analyticsCacheKey(30)),
  );
  useEffect(() => {
    let alive = true;
    void prefetchScreenData(analyticsCacheKey(30), () => fetchCommerceAnalytics(30)).then(() => {
      if (alive) setCommerce(cachedScreenData<CommerceAnalytics>(analyticsCacheKey(30)));
    });
    return () => {
      alive = false;
    };
  }, []);
  const series = useMemo(() => {
    const days = commerce?.daily.slice(-14) ?? [];
    return {
      gross: days.map((d) => d.grossCents),
      orders: days.map((d) => d.orders),
      conversion: days.map((d) => d.conversionPct ?? 0),
      sessions: days.map((d) => d.sessions),
    };
  }, [commerce]);

  // catalogTotal is the first-run signal: 0 = brand-new store, null = not yet
  // fetched. Until the fetch lands, the loader's `hasCatalog` hint decides the
  // layout — so the FIRST paint (including SSR) is already the right page
  // (established layout vs setup guide) instead of a void that swaps in
  // wholesale seconds later. The client fetch stays authoritative once it
  // resolves (returning after adding a product flips the state); errors keep
  // the hint's verdict, so the guide never flashes on a transient failure.
  const seededCatalog = cachedScreenData<{ products: ProductSummaryVM[]; total: number }>(
    catalogCacheKey("", undefined),
  );
  const [catalogTotal, setCatalogTotal] = useState<number | null>(() => seededCatalog?.total ?? null);
  useEffect(() => {
    let alive = true;
    client
      .fetchProducts()
      .then((p) => {
        cacheScreenData(catalogCacheKey("", undefined), p);
        if (alive) setCatalogTotal(p.total);
      })
      .catch(() => {
        // Keep whatever the cache or the loader hint decided.
      });
    return () => {
      alive = false;
    };
  }, []);
  const freshStore = catalogTotal !== null ? catalogTotal === 0 : !app.hasCatalog;
  const hasProduct = !freshStore;

  // Payouts state powers the setup checklist's "Connect payouts" step and keeps
  // the whole guide open until money can actually move — a store with products
  // but no live Stripe isn't set up yet. Seeded from the shared billing cache
  // (the same key Payments/Settings write) so a return visit knows instantly;
  // the mount fetch revalidates. Until billing is known we never force the guide
  // open on an established store, so a fully set-up shop can't flash the guide.
  const seededBilling = cachedScreenData<BillingStatus>(SCREEN_CACHE_KEYS.billing);
  const [billing, setBilling] = useState<BillingStatus | null>(() => seededBilling ?? null);
  useEffect(() => {
    let alive = true;
    client
      .fetchBilling()
      .then((b) => {
        cacheScreenData(SCREEN_CACHE_KEYS.billing, b);
        if (alive) setBilling(b);
      })
      .catch(() => {
        // An unreadable billing state stays "not yet known" — never a reason to
        // pop the setup guide onto an established store.
      });
    return () => {
      alive = false;
    };
  }, []);
  const payoutsActive =
    billing != null &&
    billing.connected &&
    billing.chargesEnabled &&
    billing.payoutsEnabled &&
    billing.detailsSubmitted;
  const payoutsKnown = billing != null;

  // The setup checklist tracks the three milestones that gate selling: account
  // (done at signup), a first product, and live payouts. It stays until all
  // three are met — the old gate hid the whole card the instant a product
  // existed, stranding a merchant who hadn't connected payouts yet. A brand-new
  // store shows it on first paint via the catalog hint (freshStore); a store
  // that already has products only reopens it once we KNOW payouts aren't live.
  const setupSteps = 3;
  const setupDone = 1 + (hasProduct ? 1 : 0) + (payoutsActive ? 1 : 0);
  const setupComplete = hasProduct && payoutsActive;
  const showSetup = !setupComplete && (freshStore || (payoutsKnown && !payoutsActive));

  // ---- prompt bar (the front door to Ask Calderyn) ----
  const [ask, setAsk] = useState("");
  const askRef = useRef<HTMLInputElement | null>(null);

  // ---- decision deck ----
  // The queue is triaged, not listed: the biggest asks get one card at a time,
  // the reversible one-click remainder folds into a single batch card, and the
  // tail is a count. Approvals execute for real; "Later" snoozes server-side.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [handledSession, setHandledSession] = useState(0);
  const [approving, setApproving] = useState<string | null>(null);
  const [batchLeft, setBatchLeft] = useState<number | null>(null);
  const [batchDismissed, setBatchDismissed] = useState(false);

  const alertsById = useMemo(() => new Map(app.alerts.map((a) => [a.id, a])), [app.alerts]);

  const remaining = useMemo(
    () =>
      [...app.actionQueue]
        .filter((p) => !dismissed.has(p.alertId))
        .sort((a, b) => b.dollar_impact - a.dollar_impact),
    [app.actionQueue, dismissed],
  );

  // Card budget shrinks as the merchant works the deck; once the session's
  // top-N cards are handled, every remaining *reversible* one-click folds into
  // the batch instead of paging on forever. Judgment calls (dialog kinds,
  // hard-to-reverse moves) never batch — they always get their own card.
  const { cardQueue, batch } = useMemo(() => {
    const budget = Math.max(0, DECK_TOP_N - handledSession);
    const topIds = new Set(remaining.slice(0, budget).map((p) => p.alertId));
    const eligible = remaining.filter(
      (p) =>
        !topIds.has(p.alertId) &&
        canOneClickAlert(alertsById.get(p.alertId), p.action_kind) &&
        oneClickKind(p.action_kind) &&
        actionTier(p.action_kind) === "reversible",
    );
    // A batch of one isn't a batch — keep it as a regular card so nothing
    // becomes unreachable.
    if (eligible.length < 2) return { cardQueue: remaining, batch: [] as QueueProposalVM[] };
    const batchIds = new Set(eligible.map((p) => p.alertId));
    return { cardQueue: remaining.filter((p) => !batchIds.has(p.alertId)), batch: eligible };
  }, [remaining, handledSession, alertsById]);

  // Freeze the deck while a batch run is in flight so an in-flight item can't
  // leak a live single-approve card and get double-submitted.
  const current: QueueProposalVM | null = batchLeft !== null ? null : (cardQueue[0] ?? null);
  const showBatch = !current && !batchDismissed && batch.length >= 2;
  const atStake = remaining.reduce((a, p) => a + (p.dollar_impact || 0), 0);
  // Session-stable counter: totals don't rewind when refresh() drops an
  // executed item from the queue (handled+remaining is invariant under that).
  const deckTotal = handledSession + remaining.length;
  const position = Math.min(handledSession + 1, deckTotal);
  const stacked = cardQueue.length + (batch.length >= 2 && !batchDismissed ? 1 : 0);

  const currentOneClick = current
    ? canOneClickAlert(alertsById.get(current.alertId), current.action_kind)
    : false;

  const approveCurrent = useCallback(async () => {
    if (!current) return;
    const alert = alertsById.get(current.alertId);
    if (!alert || !canOneClickAlert(alert, current.action_kind) || !oneClickKind(current.action_kind)) {
      // Safety net — the Review button navigates directly; this path only
      // runs if state shifted between render and click.
      app.navigate("alerts", current.alertId);
      return;
    }
    setApproving(current.alertId);
    try {
      const { ok } = await app.executeAction(alert, current.action_kind);
      if (ok) {
        setDismissed((s) => new Set(s).add(current.alertId));
        setHandledSession((n) => n + 1);
        app.refresh();
      }
    } finally {
      setApproving(null);
    }
  }, [app, current, alertsById]);

  const skipCurrent = useCallback(() => {
    if (!current) return;
    const id = current.alertId;
    setDismissed((s) => new Set(s).add(id));
    setHandledSession((n) => n + 1);
    // Real deferral where the platform supports it: snooze hides the alert
    // server-side until tomorrow or the next login (its own toast confirms).
    // The snooze endpoint rides the Shopify-connected engine (422s with
    // shopify_required on owned stores), so owned stores defer session-
    // locally with an honest toast instead of surfacing a connect error.
    const alert = app.shopDomain ? alertsById.get(id) : undefined;
    if (alert) {
      void app.executeAction(alert, "snooze_alert").then(({ ok }) => {
        if (ok) app.refresh();
      });
    } else {
      app.toast("Skipped for now — it stays in the Autopilot queue.", "check");
    }
  }, [app, current, alertsById]);

  const approveBatch = useCallback(async () => {
    if (batchLeft !== null) return;
    const items = batch;
    let left = items.length;
    setBatchLeft(left);
    let okCount = 0;
    for (const p of items) {
      const alert = alertsById.get(p.alertId);
      if (alert && canOneClickAlert(alert, p.action_kind) && oneClickKind(p.action_kind)) {
        // Sequential on purpose: the engine applies guardrails per action; a
        // parallel burst would race budget caps.
        const { ok } = await app.executeAction(alert, p.action_kind);
        if (ok) {
          okCount += 1;
          setDismissed((s) => new Set(s).add(p.alertId));
        }
      }
      left -= 1;
      setBatchLeft(left);
    }
    setBatchLeft(null);
    setBatchDismissed(true);
    app.toast(
      okCount === items.length
        ? `Approved all ${okCount}.`
        : `Approved ${okCount} of ${items.length} — the rest are in Autopilot.`,
      "check",
    );
    app.refresh();
  }, [app, batch, batchLeft, alertsById]);

  // ---- greeting one-liner (the agent reports, in one sentence) ----
  // Autopilot-run actions only (mode === "auto") — the agent must not take
  // credit for the merchant's own approvals — with undo rows excluded and
  // undone originals clawed back via the shared recovered math, so Home can
  // never disagree with the History/Recovered tiles. Computed per render (no
  // memo): it is time-dependent and must roll over at midnight.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const autoToday = recoveredWithin(
    app.audit.filter((a) => a.mode === "auto"),
    startOfToday.toISOString(),
  );
  const totalAsks = app.actionQueue.length;

  const subline = freshStore
    ? `Let's get ${app.storeLabel} ready to sell.`
    : !app.booted
      ? ""
      : autoToday.count > 0
        ? `I handled ${autoToday.count} ${autoToday.count === 1 ? "thing" : "things"} today and saved ${money(autoToday.cents)}.`
        : totalAsks > 0
          ? `${totalAsks} ${totalAsks === 1 ? "decision is" : "decisions are"} waiting on you.`
          : "All quiet. I'm watching your store.";

  const conversion =
    live && live.sessions_today > 0
      ? ((live.funnel.purchased_sessions / live.sessions_today) * 100).toFixed(1) + "%"
      : null;

  const engine = app.liveEngine;
  const pct = app.calibration?.pct ?? engine?.calibrationPct ?? null;
  // Zero-states are claims about the data, so they require the FULL picture
  // (app.booted): keyed on !loading alone, an in-flight or partially failed
  // boot would flash "standing by" at every established store.
  const dormant = app.booted && (freshStore || !hasEngineSignals(app));
  const graduated = !dormant && pct !== null && pct >= 100;
  const engineOn = Boolean(engine?.autopilotEnabled) && !dormant;
  const trace = engine?.trace.slice(0, 2) ?? [];

  // Until a load has delivered the full picture and no ask has landed yet, the
  // deck holds a skeleton card — the real page structure, honestly loading —
  // never a premature "All clear" and never a void. Keyed on booted (not
  // loading) so a FAILED boot keeps the skeleton + error toast instead of
  // claiming an all-clear off data that never arrived.
  const deckLoading = !app.booted && !current && !showBatch;

  // ---- deck motion ----
  // Advancing the deck slides the incoming card in from the right (enter-only:
  // React unmounts the outgoing card instantly, and the enter slide is the
  // signature move). The first paint of the deck lands statically — only a
  // change of the current card animates; the skeleton→content swap counts as
  // first paint, not an advance. Reduced motion lands on final state.
  const deckRef = useRef<HTMLDivElement | null>(null);
  const deckKey = freshStore
    ? null
    : deckLoading
      ? "loading"
      : current
        ? current.alertId
        : showBatch
          ? "batch"
          : "done";
  const lastDeckKey = useRef<string | null>(null);
  useGSAP(
    () => {
      const prev = lastDeckKey.current;
      lastDeckKey.current = deckKey;
      if (!deckKey || prev === null || prev === "loading" || prev === deckKey || reduced()) return;
      gsap.from(".cd-deck-card", {
        x: 26,
        autoAlpha: 0,
        duration: 0.32,
        ease: "power2.out",
        clearProps: "opacity,visibility,transform",
      });
    },
    { dependencies: [deckKey], scope: deckRef },
  );

  // ---- trace motion ----
  // Rows the engine genuinely just delivered (ids not present on the previous
  // refresh) tick in; everything else stays put. The first delivery paints
  // statically, and no timer ever fakes activity.
  const feedRef = useRef<HTMLDivElement | null>(null);
  const knownTraceIds = useRef<Set<string> | null>(null);
  const traceKey = trace.map((t) => t.id).join("|");
  useGSAP(
    () => {
      const prev = knownTraceIds.current;
      if (engine) knownTraceIds.current = new Set(trace.map((t) => t.id));
      if (!prev || reduced() || !feedRef.current) return;
      const rows = trace
        .filter((t) => !prev.has(t.id))
        .map((t) => feedRef.current?.querySelector(`[data-tid="${CSS.escape(t.id)}"]`))
        .filter((el): el is Element => Boolean(el));
      if (rows.length === 0) return;
      gsap.from(rows, {
        autoAlpha: 0,
        y: -8,
        duration: 0.45,
        ease: "power2.out",
        clearProps: "opacity,visibility,transform",
      });
    },
    { dependencies: [traceKey, Boolean(engine)] },
  );

  return (
    <div className="cd-screen cd-home" data-screen-label="Home">
      <header className="cd-home-head">
        <div className="cd-home-head-t">
          <h1 className="cd-h1">{freshStore ? "Welcome." : `${greet}.`}</h1>
          {subline ? (
            <p className="cd-sub">{subline}</p>
          ) : (
            // Reserve the subline's line while the agent's one-liner loads so
            // the whole page doesn't shift down when it lands.
            <p className="cd-sub">
              <SkelBar width={260} maxWidth="70%" />
            </p>
          )}
        </div>
        {/* Live-visitor readout: reuses the pulsing brand mark as a realtime
            pulse. Shown only when the owned storefront has someone on it right
            now (visitors_now = distinct sessions active in the last 5 min), so
            it never sits at a dead "0". */}
        {!freshStore && live && live.visitors_now > 0 && (
          <div
            className="cd-live-visitors"
            title="Visitors on your storefront in the last 5 minutes"
          >
            <LiveMark on />
            <span className="cd-live-visitors-n tabular-nums">{live.visitors_now}</span>
            <span className="cd-live-visitors-l">live now</span>
          </div>
        )}
      </header>

      {!freshStore && (
        <Card className="cd-hmet" pad={false} onClick={() => app.navigate("analytics", null, "live")}>
          <div className="cd-hmet-cell">
            <span className="cd-hmet-l">Sales · today</span>
            <span className="cd-hmet-v tabular-nums">{live ? money(live.total_sales_today_cents) : "—"}</span>
            <Spark points={series.gross} />
          </div>
          <div className="cd-hmet-cell">
            <span className="cd-hmet-l">Orders</span>
            <span className="cd-hmet-v tabular-nums">{live ? live.orders_today : "—"}</span>
            <Spark points={series.orders} />
          </div>
          <div className="cd-hmet-cell">
            <span className="cd-hmet-l">Conversion</span>
            <span className="cd-hmet-v tabular-nums">{conversion ?? "—"}</span>
            <Spark points={series.conversion} />
          </div>
          <div className="cd-hmet-cell">
            <span className="cd-hmet-l">Sessions</span>
            <span className="cd-hmet-v tabular-nums">{live ? live.sessions_today : "—"}</span>
            <Spark points={series.sessions} />
          </div>
        </Card>
      )}

      {freshStore ? (
        // Fresh store: the bar routes to the prompt-first product flow — no
        // free text here, the editor owns the description.
        <button
          type="button"
          className="cd-promptbar"
          onClick={() => app.navigate("product-editor", "new")}
        >
          <LiveMark on={false} />
          <span className="cd-promptbar-ph">Describe your first product…</span>
          <CDIcon name="arrowRight" size={15} strokeWidth={1.9} style={{ color: "var(--text-3)" }} />
        </button>
      ) : (
        // The page bar is only an entry point — the conversation lives in the
        // assistant panel, so Home never floods. Submitting hands the text off
        // and the panel opens with it as the first turn.
        <form
          className="cd-promptbar cd-promptbar-form"
          onSubmit={(e) => {
            e.preventDefault();
            const text = ask.trim();
            // With text: the panel opens and sends it as the next turn.
            // Empty: still open the panel (the bar's old click behavior — the
            // thread stays reachable from here without typing).
            app.openAssistant(text || undefined);
            setAsk("");
          }}
          onClick={() => askRef.current?.focus()}
        >
          <LiveMark on={false} />
          <input
            ref={askRef}
            className="cd-promptbar-in"
            type="text"
            placeholder="Tell Calderyn what to do…"
            aria-label="Ask Calderyn"
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
          />
          <button type="submit" className="cd-promptbar-send" aria-label="Send to Calderyn">
            <CDIcon name="arrowRight" size={15} strokeWidth={1.9} />
          </button>
        </form>
      )}

      {showSetup && (
        <Card className="cd-su-card" pad={false}>
          <div className="cd-su-head">
            <span className="cd-su-title">Set up your store</span>
            <div className="cd-su-meter" aria-hidden="true">
              <i className="on" />
              <i className={hasProduct ? "on" : undefined} />
              <i className={payoutsActive ? "on" : undefined} />
            </div>
            <span className="cd-caption tabular-nums">{`${setupDone} of ${setupSteps}`}</span>
          </div>
          <div className="cd-su-row cd-su-done">
            <span className="cd-su-ic cd-su-ic-done">
              <CDIcon name="check" size={17} strokeWidth={2.2} />
            </span>
            <div className="cd-su-body">
              <div className="cd-su-t">Create your account</div>
            </div>
          </div>
          {hasProduct ? (
            <div className="cd-su-row cd-su-done">
              <span className="cd-su-ic cd-su-ic-done">
                <CDIcon name="check" size={17} strokeWidth={2.2} />
              </span>
              <div className="cd-su-body">
                <div className="cd-su-t">Add your first product</div>
              </div>
            </div>
          ) : (
            <div className="cd-su-row">
              <span className="cd-su-ic cd-su-ic-live">
                <CDIcon name="sparkle" size={17} strokeWidth={1.8} />
              </span>
              <div className="cd-su-body">
                <div className="cd-su-t">Describe your first product</div>
                <div className="cd-su-s">One sentence. Calderyn drafts the listing, price and page.</div>
              </div>
              <Btn kind="primary" small onClick={() => app.navigate("product-editor", "new")}>
                Create
              </Btn>
            </div>
          )}
          <div className="cd-su-row">
            <span className="cd-su-ic cd-su-ic-shopify">
              {/* Shopify brand mark — labels the real import integration. */}
              <svg width="17" height="19" viewBox="-0.1 308.7 150.4 170.7" aria-hidden="true">
                <path
                  fill="#95BF47"
                  d="M131.5 341.9c-.1-.9-.9-1.3-1.5-1.3s-13.7-1-13.7-1-9.1-9.1-10.2-10c-1-1-2.9-.7-3.7-.5-.1 0-2 .6-5.1 1.6-3.1-8.9-8.4-17-17.9-17h-.9c-2.6-3.4-6-5-8.8-5-22 0-32.6 27.5-35.9 41.5-8.6 2.7-14.7 4.5-15.4 4.8-4.8 1.5-4.9 1.6-5.5 6.1-.5 3.4-13 100.1-13 100.1l97.3 18.2L150 468c.1-.2-18.4-125.2-18.5-126.1zm-39.6-9.8c-2.4.7-5.3 1.6-8.2 2.6v-1.8c0-5.4-.7-9.8-2-13.3 5 .6 8.1 6.1 10.2 12.5zm-16.3-11.4c1.3 3.4 2.2 8.2 2.2 14.8v1c-5.4 1.7-11.1 3.4-17 5.3 3.3-12.6 9.6-18.8 14.8-21.1zm-6.4-6.2c1 0 2 .4 2.8 1-7.1 3.3-14.6 11.6-17.7 28.4-4.7 1.5-9.2 2.8-13.5 4.2 3.6-12.8 12.6-33.6 28.4-33.6z"
                />
                <path
                  fill="#5E8E3E"
                  d="M130 340.4c-.6 0-13.7-1-13.7-1s-9.1-9.1-10.2-10c-.4-.4-.9-.6-1.3-.6l-7.3 150.6 52.8-11.4s-18.5-125.2-18.6-126.1c-.4-.9-1.1-1.3-1.7-1.5z"
                />
                <path
                  fill="#FFF"
                  d="M79.4 369.6L73 388.9s-5.8-3.1-12.7-3.1c-10.3 0-10.8 6.5-10.8 8.1 0 8.8 23 12.2 23 32.9 0 16.3-10.3 26.8-24.2 26.8-16.8 0-25.2-10.4-25.2-10.4l4.5-14.8s8.8 7.6 16.2 7.6c4.9 0 6.9-3.8 6.9-6.6 0-11.5-18.8-12-18.8-31 0-15.9 11.4-31.3 34.5-31.3 8.6-.1 13 2.5 13 2.5z"
                />
              </svg>
            </span>
            <div className="cd-su-body">
              <div className="cd-su-t">Import from Shopify</div>
              <div className="cd-su-s">Products, orders, 12 months of history.</div>
            </div>
            <Btn small onClick={() => app.navigate("import-shopify")}>
              Import
            </Btn>
          </div>
          {payoutsActive ? (
            <div className="cd-su-row cd-su-done">
              <span className="cd-su-ic cd-su-ic-done">
                <CDIcon name="check" size={17} strokeWidth={2.2} />
              </span>
              <div className="cd-su-body">
                <div className="cd-su-t">Connect payouts</div>
              </div>
            </div>
          ) : (
            <div className="cd-su-row">
              <span className="cd-su-3dcard" aria-hidden="true" />
              <div className="cd-su-body">
                <div className="cd-su-t">Connect payouts</div>
                <div className="cd-su-s">Stripe, about two minutes.</div>
              </div>
              <Btn small onClick={() => app.navigate("payments")}>
                Connect
              </Btn>
            </div>
          )}
          <div className="cd-su-row">
            <span className="cd-su-ic cd-su-ic-muted">
              <CDIcon name="store" size={17} strokeWidth={1.8} />
            </span>
            <div className="cd-su-body">
              <div className="cd-su-t">Build your storefront</div>
              <div className="cd-su-s">Describe your brand; publish when there's something to sell.</div>
            </div>
            <Btn small onClick={() => app.navigate("storefront")}>
              Open
            </Btn>
          </div>
        </Card>
      )}

      {!freshStore && (
        <div className="cd-deck" ref={deckRef}>
          {deckLoading ? (
            // No complete load yet and no ask landed — hold the deck's shape
            // with a shimmer card instead of claiming "All clear" before we know.
            <div className="cd-deck-card" aria-hidden="true">
              <div className="cd-deck-top">
                <SkelBar width={110} />
              </div>
              <div className="cd-deck-title">
                <SkelBar width="52%" height={16} />
              </div>
              <div className="cd-deck-sub">
                <SkelBar width="78%" />
              </div>
              <div className="cd-deck-foot">
                <SkelBar width={96} height={30} radius={15} />
              </div>
            </div>
          ) : current ? (
            <>
              {stacked > 2 && <div className="cd-deck-sh s2" />}
              {stacked > 1 && <div className="cd-deck-sh s1" />}
              <div className="cd-deck-card" key={current.alertId}>
                <div className="cd-deck-top">
                  <span>
                    Needs you · <b className="tabular-nums">{position}</b> of{" "}
                    <span className="tabular-nums">{deckTotal}</span>
                  </span>
                  {atStake > 0 && <span className="tabular-nums">{money(atStake)} at stake</span>}
                </div>
                <div className="cd-deck-title">{current.title}</div>
                <div className="cd-deck-sub">{current.reasoning}</div>
                <div className="cd-deck-foot">
                  {current.dollar_impact > 0 && (
                    <span className="cd-deck-money tabular-nums">{money(current.dollar_impact)}</span>
                  )}
                  {currentOneClick ? (
                    <Btn kind="primary" disabled={approving === current.alertId} onClick={() => void approveCurrent()}>
                      {approving === current.alertId ? "Approving…" : "Approve"}
                    </Btn>
                  ) : (
                    <Btn kind="primary" onClick={() => app.navigate("alerts", current.alertId)}>
                      Review
                    </Btn>
                  )}
                  <Btn onClick={skipCurrent}>Later</Btn>
                </div>
              </div>
            </>
          ) : showBatch ? (
            <div className="cd-deck-card">
              <div className="cd-deck-top">
                <span>Routine</span>
                {atStake > 0 && <span className="tabular-nums">{money(atStake)} at stake</span>}
              </div>
              <div className="cd-deck-title">
                {batch.length} routine {batch.length === 1 ? "one" : "ones"} I'd approve myself
              </div>
              <div className="cd-deck-sub">
                Small, reversible moves — pauses, budget trims, region exclusions — run one at a
                time under your guardrails. Every one is logged in History and can be undone.
              </div>
              <div className="cd-deck-foot">
                <span className="cd-deck-money tabular-nums">
                  {money(batch.reduce((a, p) => a + (p.dollar_impact || 0), 0))}
                </span>
                <Btn kind="primary" disabled={batchLeft !== null} onClick={() => void approveBatch()}>
                  {batchLeft !== null ? `Approving… ${batchLeft} left` : `Approve all ${batch.length}`}
                </Btn>
                <Btn disabled={batchLeft !== null} onClick={() => setBatchDismissed(true)}>
                  Later
                </Btn>
              </div>
            </div>
          ) : (
            <div className="cd-deck-card cd-deck-done">
              <span className="cd-deck-check">
                <CDIcon name="check" size={15} strokeWidth={2.2} />
              </span>
              <div className="cd-su-body">
                <div className="cd-su-t">{totalAsks === 0 ? "All clear." : "All caught up."}</div>
                <div className="cd-caption">
                  {remaining.length > 0
                    ? `${remaining.length} ${remaining.length === 1 ? "one is" : "ones are"} waiting in Autopilot.`
                    : "Anything worth a decision lands here."}
                </div>
              </div>
              <Btn small onClick={() => app.navigate("autopilot")}>
                Open Autopilot
              </Btn>
            </div>
          )}
        </div>
      )}

      <Card className="cd-hm-engine" pad={false} onClick={() => app.navigate("autopilot")}>
        <div className="cd-hm-engine-in">
          {/* A dormant engine shows an empty dial even when a stale calibration
              row exists — "standing by" and a lit gauge contradict each other.
              While the boot hasn't answered yet, the readout is a dash: a lit
              "0%" before data reads as a real (alarming) score. */}
          <TickGauge
            pct={dormant ? 0 : (pct ?? 0)}
            size={108}
            sweepFrom0
            pending={!app.booted && pct === null}
          />
          <div className="cd-hm-engine-body">
            <div className="cd-hm-engine-head">
              <LiveMark on={engineOn} />
              <span className="cd-hm-engine-t">
                {dormant
                  ? "Autopilot · standing by"
                  : graduated
                    ? "Autopilot · running hands-off"
                    : pct !== null
                      ? `Autopilot · calibration ${Math.round(pct)}%`
                      : "Autopilot"}
              </span>
              <span className="cd-hm-engine-r tabular-nums">
                {dormant
                  ? "trains on your first orders"
                  : engine
                    ? `${money(engine.moneyProtectedWeekCents)} saved · 7d`
                    : ""}
              </span>
            </div>
            <div className="cd-hm-engine-feed" ref={feedRef}>
              {dormant ? (
                <>
                  <div className="cd-hm-scanline">I'll reorder stock before you sell out</div>
                  <div className="cd-hm-scanline">I'll pause ads that waste money</div>
                </>
              ) : trace.length > 0 ? (
                trace.map((t) => (
                  <div key={t.id} data-tid={t.id} className="cd-hm-scanline">
                    <span
                      className="cd-hm-scan-text"
                      style={t.tag === "BLOCKED" ? { color: "var(--orange)" } : undefined}
                    >
                      {t.text}
                    </span>
                    {t.moneyCents !== 0 && (
                      <span
                        className="cd-hm-scan-money tabular-nums"
                        style={{ color: t.moneyCents > 0 ? "var(--green)" : "var(--orange)" }}
                      >
                        {money(t.moneyCents)}
                      </span>
                    )}
                    <span className="cd-hm-scan-time">{t.rel}</span>
                  </div>
                ))
              ) : (
                <div className="cd-hm-scanline">
                  {app.booted ? "Recent scans and actions land here." : "Connecting to the engine"}
                </div>
              )}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
