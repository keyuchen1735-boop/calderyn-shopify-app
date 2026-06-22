// Calderyn DashV2 — app shell: sidebar nav, live data engine, tweaks, router.
// Ported from the prototype's app.jsx, rewired to the real /dashboard/api/*
// data layer (app/lib/dashboard/client.ts) instead of the static CD.* fixtures.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { presentActionOutcome } from "~/lib/action-outcome";
import { useRefreshOnFocus } from "~/lib/use-refresh-on-focus";

import { CDIcon } from "./icons";
import { ToastHost, Toggle } from "./ui";
import { ACTION_LABELS } from "./format";
import { autopilotToasts, autopilotFailureLines } from "~/lib/autopilot-banner";
import {
  TweaksPanel,
  TweakSection,
  TweakToggle,
  TweakColor,
  TweakRadio,
  TweakSlider,
  useTweaks,
} from "./tweaks-panel";
import { useLiveFeed } from "./live";
import { applyUndo } from "./undo";
import type {
  ActionKind,
  DashboardCtx,
  NavState,
  Screen as ScreenId,
} from "./context";
import type {
  AlertVM,
  AuditVM,
  CampaignVM,
  FeedEvent,
  GuardrailVM,
  IntegrationVM,
  LearnedRuleVM,
  OverviewVM,
  QueueProposalVM,
  Toast,
} from "./view-models";

import AssistantPanel from "./AssistantPanel";
import BugReportButton from "./BugReportButton";
import ScreenDashboard from "./screens/Dashboard";
import ScreenAlerts from "./screens/Alerts";
import ScreenCampaigns from "./screens/Campaigns";
import ScreenPredictor from "./screens/Predictor";
import ScreenGenerator from "./screens/Generator";
import ScreenAnalytics from "./screens/Analytics";
import ScreenInventory from "./screens/Inventory";
import ScreenAudit from "./screens/Audit";
import ScreenActionQueue from "./screens/ActionQueue";
import ScreenSettings from "./screens/Settings";
import ScreenLabs from "./screens/Labs";

// `generator` is reachable via navigate() but intentionally absent from the rail
// (same as the prototype — it's an inner flow off the predictor).
const NAV_ITEMS: { id: ScreenId; label: string; icon: string }[] = [
  { id: "dashboard", label: "Overview", icon: "gauge" },
  { id: "alerts", label: "Alerts", icon: "bell" },
  { id: "campaigns", label: "Campaigns", icon: "megaphone" },
  { id: "predictor", label: "Creative Predictor", icon: "sparkle" },
  { id: "analytics", label: "Analytics", icon: "chart" },
  { id: "inventory", label: "Inventory", icon: "box" },
  { id: "audit", label: "Action history", icon: "clock" },
  { id: "action-queue", label: "Action Queue", icon: "target" },
  { id: "settings", label: "Settings", icon: "gear" },
];

// On phones the sidebar collapses to a bottom tab bar. These four ride the bar
// (matching the mobile design); everything else in NAV_ITEMS lives behind "More".
const PRIMARY_TABS: ScreenId[] = ["dashboard", "alerts", "campaigns", "inventory"];

const TWEAK_DEFAULTS = {
  dark: false,
  accent: "#24556E",
  density: "balanced",
  radius: 14,
  glass: 0.72,
  typeScale: 1,
};

const SCREENS: Record<ScreenId, (props: { app: DashboardCtx }) => JSX.Element> = {
  dashboard: ScreenDashboard,
  alerts: ScreenAlerts,
  campaigns: ScreenCampaigns,
  predictor: ScreenPredictor,
  generator: ScreenGenerator,
  analytics: ScreenAnalytics,
  inventory: ScreenInventory,
  audit: ScreenAudit,
  "action-queue": ScreenActionQueue,
  settings: ScreenSettings,
  // Hidden (not in NAV_ITEMS) — reached via the secret dot in Settings.
  labs: ScreenLabs,
};

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 8) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  return Math.floor(m / 60) + "h ago";
}

let feedSeq = 100;
function nextFeedId(): string {
  return "f" + feedSeq++;
}

export default function DashboardApp({ shopDomain }: { shopDomain: string }) {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [nav, setNav] = useState<NavState>({ screen: "dashboard", param: null });
  // Mobile "More" bottom sheet (only rendered/visible under the tab-bar breakpoint).
  const [moreOpen, setMoreOpen] = useState(false);
  // Bumped by the More-sheet items to open the assistant / bug-report overlays
  // (their floating launchers are hidden at phone width).
  const [assistantSignal, setAssistantSignal] = useState(0);
  const [bugSignal, setBugSignal] = useState(0);

  const navigate = useCallback((screen: ScreenId, param: string | null = null) => {
    setNav({ screen, param });
    setMoreOpen(false);
    document.getElementById("cd-main")?.scrollTo({ top: 0 });
  }, []);

  // Escape closes the More sheet (backdrop click handles pointer dismissal).
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  // ----- data state (fetched on mount; client.ts hits /dashboard/api/*) -----
  const [alerts, setAlerts] = useState<AlertVM[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignVM[]>([]);
  const [audit, setAudit] = useState<AuditVM[]>([]);
  const [guardrails, setGuardrails] = useState<GuardrailVM | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationVM[]>([]);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [overview, setOverview] = useState<OverviewVM | null>(null);
  const [calibration, setCalibration] = useState<DashboardCtx["calibration"]>(null);
  const [actionQueue, setActionQueue] = useState<QueueProposalVM[]>([]);
  const [learnedRules, setLearnedRules] = useState<LearnedRuleVM[]>([]);
  const [loading, setLoading] = useState(true);

  // ----- live engine state -----
  const [liveOn, setLiveOn] = useState(true);
  const [feed, setFeed] = useState<FeedEvent[]>([]);

  // ----- toasts -----
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((text: string, icon?: string, tone?: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((ts) => [...ts, { id, text, icon, tone }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 3400);
  }, []);

  const pushFeed = useCallback((ev: Omit<FeedEvent, "id">) => {
    setFeed((f) => [{ id: nextFeedId(), ts: ev.ts ?? Date.now(), ...ev }, ...f].slice(0, 30));
  }, []);

  // ----- initial load + refresh -----
  // Campaigns first so fetchAlerts(filters, campaigns) can derive campaign_id.
  const load = useCallback(async () => {
    const camps = await client.fetchCampaigns();
    const [ov, al, au, gr, integ, co, cal, aq, lr] = await Promise.all([
      client.fetchOverview(),
      client.fetchAlerts(undefined, camps),
      client.fetchAudit(),
      client.fetchGuardrails(),
      client.fetchIntegrations(),
      client.fetchConsent(),
      client.fetchCalibration(),
      client.fetchActionQueue(),
      client.fetchLearnedRules(),
    ]);
    setCampaigns(camps);
    setOverview(ov);
    setAlerts(al);
    setAudit(au);
    setGuardrails(gr);
    setIntegrations(integ);
    setConsent(co);
    setCalibration(cal);
    setActionQueue(aq);
    setLearnedRules(lr);
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    load()
      .catch((err) => {
        if (!alive) return;
        const msg = err instanceof DashboardApiError ? err.message : "Could not load dashboard data.";
        toast(msg, "warn", "critical");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [load, toast]);

  const refresh = useCallback(() => {
    load().catch((err) => {
      const msg = err instanceof DashboardApiError ? err.message : "Refresh failed.";
      toast(msg, "warn", "critical");
    });
  }, [load, toast]);

  // Returning to the tab does an immediate refresh instead of waiting up to one
  // poll interval (browsers throttle the timer while hidden). Gated on liveOn so
  // it respects the "Live sync" toggle — off means the screen stays put.
  useRefreshOnFocus(refresh, { enabled: liveOn });

  // ----- autopilot: act immediately on load -----
  // When autopilot is enabled, drain every open actionable alert the moment the
  // dashboard opens (the /cron/autopilot schedule is the same engine for when
  // it's closed). One banner per landed action, then re-pull audit + alerts so
  // Action history shows the new "Autopilot" rows and resolved alerts drop.
  // Fires ONCE per mount (autopilotRan ref): the run is idempotent server-side,
  // and the live poller already streams any later cron actions.
  const autopilotRan = useRef(false);
  useEffect(() => {
    if (autopilotRan.current || loading || !guardrails) return;
    if (!guardrails.autopilot_enabled) return;
    autopilotRan.current = true;
    (async () => {
      try {
        const res = await client.runAutopilot();
        const nameOf = (id: string) => campaigns.find((c) => c.id === id)?.name ?? "";
        for (const b of autopilotToasts(res.decisions, nameOf)) toast(b.text, b.icon, b.tone);
        // Surface failures too (rule 12) — a silent failed run (e.g. a dead Google
        // Ads token) otherwise reads as "autopilot did nothing".
        const failures = autopilotFailureLines(res.decisions, nameOf);
        for (const line of failures) toast(`${line} — see Action history.`, "warn", "critical");
        if (res.acted > 0 || failures.length > 0) {
          const [au, al] = await Promise.all([
            client.fetchAudit(),
            client.fetchAlerts(undefined, campaigns),
          ]);
          setAudit(au);
          setAlerts(al);
        }
      } catch (err) {
        // Fail visibly (rule 12) but never break the dashboard render.
        const msg = err instanceof DashboardApiError ? err.message : "Autopilot run failed.";
        toast(msg, "warn", "critical");
      }
    })();
  }, [loading, guardrails, campaigns, toast]);

  // ----- live engine: poll real endpoints, stream genuine changes -----
  useLiveFeed({
    liveOn,
    onOverview: useCallback((ov: OverviewVM) => {
      setOverview(ov);
    }, []),
    onCampaigns: useCallback((cs: CampaignVM[]) => {
      setCampaigns(cs);
    }, []),
    onGuardrails: useCallback((g: GuardrailVM) => {
      setGuardrails(g);
    }, []),
    onNewAudit: useCallback(
      (entry: AuditVM) => {
        setAudit((au) => (au.some((e) => e.id === entry.id) ? au : [entry, ...au]));
        pushFeed({
          kind: "action",
          icon: "bolt",
          text: `${entry.verb} — ${entry.target}`,
          sub: "Synced from platform",
          tone: "accent",
          cents: entry.dollar_impact_at_exec,
        });
      },
      [pushFeed],
    ),
    onNewAlerts: useCallback(
      (alert: AlertVM) => {
        setAlerts((as) => (as.some((a) => a.id === alert.id) ? as : [alert, ...as]));
        pushFeed({
          kind: "scan",
          icon: "scan",
          text: `New alert — ${alert.title}`,
          sub: alert.campaign ?? alert.sku ?? "Detector sweep",
          tone: "critical",
          cents: alert.dollar_impact,
        });
      },
      [pushFeed],
    ),
  });

  // ----- execute an action against an alert -----
  const executeAction = useCallback(
    async (alert: AlertVM, kind: ActionKind) => {
      const label = ACTION_LABELS[kind] ?? kind;

      const markResolved = () => {
        setAlerts((as) =>
          as.map((a) => (a.id === alert.id ? { ...a, status: "resolved" } : a)),
        );
      };

      // snooze: real deferral. The server flips the alert to 'snoozed' and the
      // alerts view hides it until it lapses (+1 day) or the next login. Drop it
      // from the local list to mirror that — it is hidden, not resolved.
      if (kind === "snooze_alert") {
        try {
          await client.executeAlertAction(alert.id, { type: kind });
          setAlerts((as) => as.filter((a) => a.id !== alert.id));
          // Re-fetch audit so the server's authoritative row replaces our view.
          client
            .fetchAudit()
            .then((au) => setAudit(au))
            .catch(() => {});
          toast(`${label} — back tomorrow or at your next login.`, "snooze");
        } catch (err) {
          const msg = err instanceof DashboardApiError ? err.message : "Action failed.";
          toast(msg, "warn", "critical");
        }
        return;
      }

      // pause / reduce-budget: live endpoint when we have a campaign_id.
      if (
        (kind === "pause_campaign" || kind === "reduce_campaign_budget") &&
        alert.campaign_id
      ) {
        const campaign = campaigns.find((c) => c.id === alert.campaign_id);
        const reducedBudget =
          campaign && kind === "reduce_campaign_budget"
            ? Math.round(campaign.daily_budget_cents * 0.7)
            : undefined;
        try {
          const { outcome } = await client.executeCampaignAction(alert.campaign_id, {
            type: kind,
            dailyBudgetCents: reducedBudget,
            alertId: alert.id,
          });
          const view = presentActionOutcome(outcome, label);
          // A non-succeeded outcome (retrying / failed) must NOT resolve the
          // alert or apply the optimistic paused/budget state — only a real
          // platform success does (P0-1). The terminal `failed` outcome arrives
          // as an HTTP 502 → DashboardApiError (caught below); a `retrying`
          // arrives here as a 200 and is queued, not a success.
          if (view.succeeded) {
            markResolved();
            setCampaigns((cs) =>
              cs.map((c) => {
                if (c.id !== alert.campaign_id) return c;
                if (kind === "pause_campaign") return { ...c, status: "paused" };
                return { ...c, daily_budget_cents: reducedBudget ?? c.daily_budget_cents };
              }),
            );
          }
          // Re-fetch audit so the server's authoritative row replaces our optimistic one.
          client
            .fetchAudit()
            .then((au) => setAudit(au))
            .catch(() => {});
          if (view.succeeded) toast(view.message, "check");
          else if (view.isError) toast(view.message, "warn", "critical");
          else toast(view.message, "clock");
        } catch (err) {
          const msg = err instanceof DashboardApiError ? err.message : "Action failed.";
          toast(msg, "warn", "critical");
        }
        return;
      }

      // discontinue_sku: live endpoint — archives the product on Shopify and
      // sets the internal Do-Not-Reorder flag, both derived server-side from the
      // alert. A failure (e.g. SKU with no Shopify product) surfaces as an error
      // toast, never a fake resolution.
      if (kind === "discontinue_sku") {
        try {
          const { acknowledged } = await client.executeAlertAction(alert.id, { type: kind });
          markResolved();
          client
            .fetchAudit()
            .then((au) => setAudit(au))
            .catch(() => {});
          toast(
            `${label} — product archived and marked Do Not Reorder.` +
              (acknowledged ? "" : " Alert couldn't be acknowledged."),
            "check",
          );
        } catch (err) {
          const msg = err instanceof DashboardApiError ? err.message : "Action failed.";
          toast(msg, "warn", "critical");
        }
        return;
      }

      // reallocate_inventory: live endpoint — the transfer plan is derived
      // server-side from the alert's evidence, so failures (e.g. evidence
      // without a concrete move) surface as an error toast, never a fake
      // resolution.
      if (kind === "reallocate_inventory") {
        try {
          const { outcome, acknowledged } = await client.executeAlertAction(alert.id, { type: kind });
          const view = presentActionOutcome(outcome, label);
          // Only a real success resolves the alert (P0-1); a Shopify failure
          // arrives as an HTTP 502 → DashboardApiError (caught below).
          if (view.succeeded) markResolved();
          // Re-fetch audit so the server's authoritative row replaces our optimistic one.
          client
            .fetchAudit()
            .then((au) => setAudit(au))
            .catch(() => {});
          if (view.succeeded) {
            toast(view.message + (acknowledged ? "" : " Alert couldn't be acknowledged."), "check");
          } else if (view.isError) {
            toast(view.message, "warn", "critical");
          } else {
            toast(view.message, "clock");
          }
        } catch (err) {
          const msg = err instanceof DashboardApiError ? err.message : "Action failed.";
          toast(msg, "warn", "critical");
        }
        return;
      }

      // reallocate_spend_sku: live endpoint — the campaign pair and shift amount
      // are derived server-side by enrichRemediation (Task 7 route + Task 6
      // gateway). The client sends only the action kind; no campaign ids.
      if (kind === "reallocate_spend_sku") {
        try {
          const { acknowledged } = await client.executeAlertAction(alert.id, { type: kind });
          markResolved();
          client
            .fetchAudit()
            .then((au) => setAudit(au))
            .catch(() => {});
          toast(
            `${label} — done. Logged to action history.` +
              (acknowledged ? "" : " Alert couldn't be acknowledged."),
            "check",
          );
        } catch (err) {
          const msg = err instanceof DashboardApiError ? err.message : "Action failed.";
          toast(msg, "warn", "critical");
        }
        return;
      }

      // TODO(phase3-followup): dashboard cut_ads on SKU alerts needs the
      // enriched target.loserCampaignId routed to executeCampaignAction; until
      // then it stays advisory on the dashboard (embedded surface executes it).

      // No live dashboard endpoint for this kind. Two ways to land here:
      //   (1) exclude_geo / create_po_draft — excluded from DASH_INLINE_ACTIONS,
      //       so the assistant renders "Review & confirm" (deep-link), not
      //       "Run now"; only a direct executeAction caller reaches this.
      //   (2) pause_campaign / reduce_campaign_budget on a (malformed) alert
      //       with no campaign_id — the live branch above is skipped.
      // Either way NEVER fake a success (rule 12): leave the alert unresolved
      // and surface a visible toast, no phantom audit row.
      // TODO(api): wire real mutations + acknowledge for (1).
      toast(
        `${label} isn't available on the dashboard yet — open it on the alert to review.`,
        "warn",
        "critical",
      );
    },
    [campaigns, toast],
  );

  const undoAction = useCallback(
    async (entry: AuditVM) => {
      try {
        const { auditId } = await client.undoAudit(entry.id);
        // Insert the undo row (with the server's id) so the "Recovered" total
        // claws this action's dollars back immediately, not 15s later.
        setAudit((au) => applyUndo(au, entry, auditId));
        toast("Action undone — previous state restored.", "undo");
      } catch (err) {
        const msg = err instanceof DashboardApiError ? err.message : "Undo failed.";
        toast(msg, "warn", "critical");
      }
    },
    [toast],
  );

  // Generator is simulated locally (no live endpoint). TODO(other-agent): wire to
  // the real ad-draft push once the generator backend lands.
  const pushAdDraft = useCallback(
    (name: string) => {
      const entry: AuditVM = {
        id: "au-gen-" + Date.now(),
        action_kind: "push_ad_draft",
        verb: "Pushed ad draft",
        target: name,
        detail: "Created paused in Meta for review",
        dollar_impact_at_exec: 0,
        outcome: "succeeded",
        actor: "You",
        when: new Date().toISOString(),
        created_at: new Date().toISOString(),
        undo_eligible: false,
        undo_of: null,
        pre: "—",
        post: "Paused draft",
        mode: "manual",
        actorDisplay: "You",
        marginBasis: "none",
        marginBasisLabel: "No booked margin",
        costLineage: [],
        why: "Manual — dashboard",
        stateDiff: [],
      };
      setAudit((au) => [entry, ...au]);
      pushFeed({
        kind: "action",
        icon: "sparkle",
        text: `Ad draft pushed to Meta — ${name}`,
        sub: "Created paused for review",
        tone: "accent",
        cents: 0,
      });
      toast("Draft pushed to Meta — created paused for your review.", "check");
    },
    [pushFeed, toast],
  );

  const app: DashboardCtx = {
    t,
    nav,
    navigate,
    alerts,
    campaigns,
    audit,
    guardrails,
    integrations,
    consent,
    overview,
    calibration,
    actionQueue,
    learnedRules,
    feed,
    liveOn,
    setLiveOn,
    executeAction,
    undoAction,
    pushAdDraft,
    toast,
    relTime,
    refresh,
    loading,
  };

  // CSS tokens, applied on .cd-root exactly as the prototype does.
  const vars = useMemo(() => {
    const density =
      ({ compact: 0.82, balanced: 1, comfy: 1.18 } as Record<string, number>)[
        String(t.density)
      ] ?? 1;
    return {
      "--accent": String(t.accent),
      "--radius": t.radius + "px",
      "--glass": t.glass,
      "--density": density,
      "--type-scale": t.typeScale,
    } as React.CSSProperties;
  }, [t.accent, t.radius, t.glass, t.density, t.typeScale]);

  const Screen = SCREENS[nav.screen] ?? ScreenDashboard;
  const openCount = alerts.filter((a) => a.status === "open").length;
  // The Labs replay masks as Campaigns, so keep "Campaigns" lit while it's open
  // (sidebar, tab bar, and the "More" active state all read off this).
  const activeNav: ScreenId = nav.screen === "labs" ? "campaigns" : nav.screen;

  // Bottom-tab-bar partition: the four primary tabs (in design order) + the rest
  // behind "More". "More" reads active whenever a non-primary screen is open.
  const primaryTabs = PRIMARY_TABS.map(
    (id) => NAV_ITEMS.find((n) => n.id === id)!,
  );
  const moreItems = NAV_ITEMS.filter((n) => !PRIMARY_TABS.includes(n.id));
  const onMoreScreen = !PRIMARY_TABS.includes(activeNav);

  return (
    <div className={"cd-root" + (t.dark ? " cd-dark" : "")} style={vars}>
      {/* Sidebar */}
      <aside className="cd-sidebar" data-screen-label="Sidebar">
        <div className="cd-side-brand" onClick={() => navigate("dashboard")}>
          <svg
            className="cd-logo cd-logo-mark"
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
          <div>
            <div className="cd-brand-name">Calderyn</div>
            <div className="cd-brand-sub">{shopDomain}</div>
          </div>
        </div>
        <nav className="cd-side-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className="cd-nav-item"
              data-active={activeNav === item.id ? "1" : "0"}
              onClick={() => navigate(item.id)}
            >
              <CDIcon name={item.icon} size={18} strokeWidth={1.8} />
              <span>{item.label}</span>
              {item.id === "alerts" && openCount > 0 && (
                <span className="cd-nav-count">{openCount}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="cd-side-foot">
          <div className="cd-live-row">
            <span className={"cd-live-dot" + (liveOn ? " on" : "")}></span>
            <span className="flex-1">Live sync</span>
            <Toggle value={liveOn} onChange={setLiveOn} />
          </div>
          <div className="cd-caption" style={{ paddingLeft: 2 }}>
            Shopify · Meta · Google · TikTok · QuickBooks
          </div>
        </div>
      </aside>

      {/* Main */}
      <main id="cd-main" className="cd-main">
        <Screen app={app} />
      </main>

      <AssistantPanel app={app} openSignal={assistantSignal} />
      <BugReportButton app={app} openSignal={bugSignal} />

      {/* Mobile bottom tab bar — hidden above the phone breakpoint via CSS. */}
      <nav className="cd-tabbar" aria-label="Primary">
        {primaryTabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className="cd-tab"
            data-active={activeNav === item.id ? "1" : "0"}
            onClick={() => navigate(item.id)}
          >
            <span className="cd-tab-ico">
              <CDIcon name={item.icon} size={22} strokeWidth={1.9} />
              {item.id === "alerts" && openCount > 0 && (
                <span className="cd-tab-count">{openCount}</span>
              )}
            </span>
            <span className="cd-tab-label">{item.label}</span>
          </button>
        ))}
        <button
          type="button"
          className="cd-tab"
          data-active={onMoreScreen ? "1" : "0"}
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          onClick={() => setMoreOpen((v) => !v)}
        >
          <span className="cd-tab-ico">
            <CDIcon name="more" size={22} strokeWidth={2} />
          </span>
          <span className="cd-tab-label">More</span>
        </button>
      </nav>

      {/* "More" bottom sheet — secondary nav + the controls that lived in the
          sidebar foot, so nothing is stranded when the sidebar is hidden. */}
      {moreOpen && (
        <div
          className="cd-more-overlay"
          role="presentation"
          onClick={() => setMoreOpen(false)}
        >
          <div
            className="cd-more-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="More"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="cd-more-grab" aria-hidden="true" />
            <nav className="cd-more-nav" aria-label="More">
              {moreItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="cd-more-item"
                  data-active={nav.screen === item.id ? "1" : "0"}
                  onClick={() => navigate(item.id)}
                >
                  <CDIcon name={item.icon} size={18} strokeWidth={1.8} />
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>
            <div className="cd-more-group">
              <button
                type="button"
                className="cd-more-item"
                onClick={() => {
                  setMoreOpen(false);
                  setAssistantSignal((n) => n + 1);
                }}
              >
                <CDIcon name="assist" size={18} strokeWidth={1.8} />
                <span>Ask Calderyn</span>
              </button>
              <button
                type="button"
                className="cd-more-item"
                onClick={() => {
                  setMoreOpen(false);
                  setBugSignal((n) => n + 1);
                }}
              >
                <CDIcon name="bug" size={18} strokeWidth={1.8} />
                <span>Report a bug</span>
              </button>
            </div>
            <div className="cd-more-foot">
              <div className="cd-live-row">
                <span className={"cd-live-dot" + (liveOn ? " on" : "")}></span>
                <span className="flex-1">Live sync</span>
                <Toggle value={liveOn} onChange={setLiveOn} />
              </div>
              <div className="cd-caption" style={{ paddingLeft: 2 }}>
                Shopify · Meta · Google · TikTok · QuickBooks
              </div>
            </div>
          </div>
        </div>
      )}

      <ToastHost toasts={toasts} />

      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakToggle label="Dark mode" value={!!t.dark} onChange={(v) => setTweak("dark", v)} />
        <TweakColor
          label="Accent"
          value={String(t.accent)}
          options={["#24556E", "#0A84FF", "#1F8A5B", "#5E5CE6"]}
          onChange={(v) => setTweak("accent", v)}
        />
        <TweakSection label="Layout" />
        <TweakRadio
          label="Density"
          value={String(t.density)}
          options={["compact", "balanced", "comfy"]}
          onChange={(v) => setTweak("density", v)}
        />
        <TweakSlider
          label="Corner radius"
          value={Number(t.radius)}
          min={6}
          max={22}
          unit="px"
          onChange={(v) => setTweak("radius", v)}
        />
        <TweakSlider
          label="Glass intensity"
          value={Number(t.glass)}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => setTweak("glass", v)}
        />
        <TweakSection label="Type" />
        <TweakSlider
          label="Type scale"
          value={Number(t.typeScale)}
          min={0.85}
          max={1.2}
          step={0.05}
          onChange={(v) => setTweak("typeScale", v)}
        />
      </TweaksPanel>
    </div>
  );
}
