// Calderyn DashV2 — app shell: sidebar nav, live data engine, tweaks, router.
// Ported from the prototype's app.jsx, rewired to the real /dashboard/api/*
// data layer (app/lib/dashboard/client.ts) instead of the static CD.* fixtures.
import { useCallback, useEffect, useMemo, useState } from "react";

import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";

import { CDIcon } from "./icons";
import { ToastHost, Toggle } from "./ui";
import { ACTION_LABELS } from "./format";
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
  OverviewVM,
  Toast,
} from "./view-models";

import AssistantPanel from "./AssistantPanel";
import ScreenDashboard from "./screens/Dashboard";
import ScreenAlerts from "./screens/Alerts";
import ScreenCampaigns from "./screens/Campaigns";
import ScreenPredictor from "./screens/Predictor";
import ScreenGenerator from "./screens/Generator";
import ScreenAnalytics from "./screens/Analytics";
import ScreenInventory from "./screens/Inventory";
import ScreenAudit from "./screens/Audit";
import ScreenSettings from "./screens/Settings";

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
  { id: "settings", label: "Settings", icon: "gear" },
];

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
  settings: ScreenSettings,
};

const ACTION_VERBS: Record<string, string> = {
  pause_campaign: "Paused campaign",
  reduce_campaign_budget: "Reduced budget",
  exclude_geo: "Excluded geo",
  reallocate_inventory: "Reallocated inventory",
  create_po_draft: "Created PO draft",
  snooze_alert: "Snoozed alert",
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

  const navigate = useCallback((screen: ScreenId, param: string | null = null) => {
    setNav({ screen, param });
    document.getElementById("cd-main")?.scrollTo({ top: 0 });
  }, []);

  // ----- data state (fetched on mount; client.ts hits /dashboard/api/*) -----
  const [alerts, setAlerts] = useState<AlertVM[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignVM[]>([]);
  const [audit, setAudit] = useState<AuditVM[]>([]);
  const [guardrails, setGuardrails] = useState<GuardrailVM | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationVM[]>([]);
  const [overview, setOverview] = useState<OverviewVM | null>(null);
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
    const [ov, al, au, gr, integ] = await Promise.all([
      client.fetchOverview(),
      client.fetchAlerts(undefined, camps),
      client.fetchAudit(),
      client.fetchGuardrails(),
      client.fetchIntegrations(),
    ]);
    setCampaigns(camps);
    setOverview(ov);
    setAlerts(al);
    setAudit(au);
    setGuardrails(gr);
    setIntegrations(integ);
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

      const logAudit = (impact: number) => {
        const entry: AuditVM = {
          id: "au-live-" + Date.now(),
          action_kind: kind,
          verb: ACTION_VERBS[kind] ?? kind,
          target: alert.campaign ?? alert.sku ?? alert.title,
          detail: alert.rec_detail || alert.title,
          dollar_impact_at_exec: impact,
          outcome: "succeeded",
          actor: "You",
          when: new Date().toISOString(),
          created_at: new Date().toISOString(),
          undo_eligible: kind !== "snooze_alert",
          undo_of: null,
          pre: "—",
          post: "—",
        };
        setAudit((au) => [entry, ...au]);
        pushFeed({
          kind: "action",
          icon: kind === "snooze_alert" ? "snooze" : "bolt",
          text: `${entry.verb} — ${entry.target}`,
          sub: "Triggered from dashboard",
          tone: "accent",
          cents: impact,
        });
      };

      const markResolved = () => {
        setAlerts((as) =>
          as.map((a) => (a.id === alert.id ? { ...a, status: "resolved" } : a)),
        );
      };

      // snooze: local-only, no API call.
      if (kind === "snooze_alert") {
        markResolved();
        logAudit(0);
        toast(`${label} — alert snoozed for 7 days.`, "snooze");
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
          await client.executeCampaignAction(alert.campaign_id, {
            type: kind,
            dailyBudgetCents: reducedBudget,
            alertId: alert.id,
          });
          markResolved();
          setCampaigns((cs) =>
            cs.map((c) => {
              if (c.id !== alert.campaign_id) return c;
              if (kind === "pause_campaign") return { ...c, status: "paused" };
              return { ...c, daily_budget_cents: reducedBudget ?? c.daily_budget_cents };
            }),
          );
          // Re-fetch audit so the server's authoritative row replaces our optimistic one.
          client
            .fetchAudit()
            .then((au) => setAudit(au))
            .catch(() => {});
          toast(`${label} — done. Logged to action history.`, "check");
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
          const { acknowledged } = await client.executeAlertAction(alert.id, { type: kind });
          markResolved();
          // Re-fetch audit so the server's authoritative row replaces our optimistic one.
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

      // exclude_geo / create_po_draft: no live endpoint yet.
      // TODO(api): wire these to real mutations once the endpoints exist.
      markResolved();
      logAudit(alert.dollar_impact);
      toast(`${label} — logged.`, "check");
    },
    [campaigns, pushFeed, toast],
  );

  const undoAction = useCallback(
    async (entry: AuditVM) => {
      try {
        await client.undoAudit(entry.id);
        setAudit((au) =>
          au.map((a) =>
            a.id === entry.id ? { ...a, undo_eligible: false, post: "Reverted" } : a,
          ),
        );
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
    overview,
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

  return (
    <div className={"cd-root" + (t.dark ? " cd-dark" : "")} style={vars}>
      {/* Sidebar */}
      <aside className="cd-sidebar" data-screen-label="Sidebar">
        <div className="cd-side-brand" onClick={() => navigate("dashboard")}>
          <div className="cd-logo cd-logo-mark" aria-hidden="true">
            C
          </div>
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
              data-active={nav.screen === item.id ? "1" : "0"}
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

      <AssistantPanel app={app} />

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
