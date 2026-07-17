import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useNavigationType } from "@remix-run/react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { applyWeatherSuggestion, type CustomersPage } from "~/lib/dashboard/customers-client";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import { bootDashboardData } from "~/lib/dashboard/boot";
import { warmScreenCaches } from "~/lib/dashboard/prefetch";
import { presentActionOutcome } from "~/lib/action-outcome";
import { useRefreshOnFocus } from "~/lib/use-refresh-on-focus";
import { diffNewlyDone } from "~/lib/dashboard/journey-watcher";
import { JOURNEY_STEPS, journeyToastText, journeyView, type MilestoneKey } from "~/lib/dashboard/journey-model";

import { CDIcon } from "./icons";
import { ToastHost, Toggle } from "./ui";
import { ACTION_LABELS } from "./format";
import { autopilotToasts, autopilotFailureLines } from "~/lib/autopilot-banner";
import { connectionNotice, shouldOpenConnectorsAfterOAuth } from "~/lib/integrations";
import { useLiveFeed } from "./live";
import { applyUndo } from "./undo";
import type { ApproveReceipt } from "~/lib/calibration/delta";
import type {
  ActionKind,
  DashboardCtx,
  DashboardTheme,
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
  QueueProposalVM,
  Toast,
} from "./view-models";

import AssistantPanel from "./AssistantPanel";
import BugReportButton from "./BugReportButton";
import ContactButton from "./ContactButton";
import { OnboardingTour } from "./OnboardingTour";
import type { ProductTourOutcome } from "~/lib/dashboard/product-tour";
import { parsePath, pathFor, DASHBOARD_BASE } from "./routes";
import {
  DASHBOARD_SIDEBAR_WIDTH,
  STORE_SIDEBAR_COMPACT_WIDTH,
  shouldCompactStoreSidebar,
} from "./store-sidebar-focus";
import ScreenDashboard from "./screens/Dashboard";
import type { JourneyProgress } from "./screens/HomeJourney";
import ScreenAlerts from "./screens/Alerts";
import ScreenCampaigns from "./screens/Campaigns";
import ScreenAnalytics from "./screens/Analytics";
import ScreenInventory from "./screens/Inventory";
import ScreenAudit from "./screens/Audit";
import ScreenSettings from "./screens/Settings";
import ScreenLocations from "./screens/Locations";
import ScreenLabs from "./screens/Labs";
import { AgenticChannel } from "./screens/AgenticChannel";
import ScreenCatalog from "./screens/Catalog";
import ScreenProductEditor from "./screens/ProductEditor";
import ScreenCollections from "./screens/Collections";
import ScreenImportShopify from "./screens/ImportShopify";
import ScreenCutover from "./screens/Cutover";
import ScreenAutopilot from "./screens/Autopilot";
import ScreenOrders from "./screens/Orders";
import ScreenCustomers from "./screens/Customers";
import ScreenShipping from "./screens/Shipping";
import ScreenPayments from "./screens/Payments";
import ScreenStore from "./screens/Store";
import ScreenDiscover from "./screens/Discover";
import ScreenSearch from "./screens/Search";
import ScreenPurchaseOrders from "./screens/PurchaseOrders";
import ScreenTransfers from "./screens/Transfers";
import { canViewOperatingPnl } from "~/lib/dashboard/analytics-access";

interface NavChild {
  /** Stable key for React + active-child matching. */
  key: string;
  label: string;
  /** Screen this child opens (may equal the parent's id, or a sibling screen). */
  screen: ScreenId;
  /** Subtab within `screen`; null when the child is its own screen. */
  sub?: string | null;
}

interface NavItem {
  id: ScreenId;
  label: string;
  icon: string;
  /** When present, the item is expandable: clicking it opens its first child's
   *  view and discloses the children indented beneath it in the rail. */
  children?: NavChild[];
}

// Grouped IA: the growth brain on top (Calderyn's wedge), owned commerce under
// RUN, the storefront under BUILD. Alerts / History / Settings ride the foot.
// Sections with sub-views carry `children`; the rail discloses them indented
// beneath the active section, so navigation lives in the rail (not an in-page
// sub-tab bar).
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Grow",
    items: [
      { id: "dashboard", label: "Home", icon: "home" },
      { id: "autopilot", label: "Autopilot", icon: "bolt" },
      { id: "campaigns", label: "Campaigns", icon: "megaphone" },
      {
        id: "analytics",
        label: "Analytics",
        icon: "chart",
        children: [
          { key: "perf", label: "Performance", screen: "analytics", sub: "perf" },
          { key: "live", label: "Live", screen: "analytics", sub: "live" },
          { key: "pnl", label: "Profit & loss", screen: "analytics", sub: "pnl" },
        ],
      },
    ],
  },
  {
    label: "Run",
    items: [
      {
        id: "orders",
        label: "Orders",
        icon: "doc",
        children: [
          { key: "labels", label: "Shipping charges", screen: "orders", sub: "labels" },
          { key: "drafts", label: "Draft carts", screen: "orders", sub: "drafts" },
          { key: "abandoned", label: "Abandoned", screen: "orders", sub: "abandoned" },
        ],
      },
      {
        id: "catalog",
        label: "Products",
        icon: "tag",
        children: [
          { key: "inventory", label: "Inventory", screen: "inventory" },
          { key: "po", label: "Purchase orders", screen: "products-po" },
          { key: "transfers", label: "Transfers", screen: "products-transfers" },
          { key: "collections", label: "Collections", screen: "collections" },
          { key: "locations", label: "Locations", screen: "locations-settings" },
        ],
      },
      {
        id: "customers",
        label: "Customers",
        icon: "user",
        children: [
          { key: "directory", label: "Directory", screen: "customers", sub: "directory" },
          { key: "segments", label: "Segments", screen: "customers", sub: "segments" },
          { key: "weather", label: "Weather", screen: "customers", sub: "weather" },
        ],
      },
      { id: "shipping", label: "Shipping", icon: "truck" },
      { id: "payments", label: "Payments", icon: "card" },
    ],
  },
  {
    label: "Build",
    items: [
      {
        id: "storefront",
        label: "Store",
        icon: "store",
        children: [
          { key: "storefront", label: "Storefront", screen: "storefront" },
          { key: "discover", label: "Discover", screen: "discover" },
          { key: "preferences", label: "Preferences", screen: "search" },
        ],
      },
    ],
  },
];

const FOOT_NAV: NavItem[] = [
  { id: "alerts", label: "Alerts", icon: "bell" },
  { id: "audit", label: "History", icon: "clock" },
  {
    id: "settings",
    label: "Settings",
    icon: "gear",
    children: [
      { key: "general", label: "General", screen: "settings", sub: "general" },
      { key: "connectors", label: "Connectors", screen: "settings", sub: "connectors" },
      { key: "mcp", label: "MCP & CLI", screen: "settings", sub: "mcp" },
      { key: "import", label: "Import from Shopify", screen: "import-shopify" },
      { key: "golive", label: "Go live", screen: "cutover" },
    ],
  },
];

const ALL_NAV_ITEMS: NavItem[] = [...NAV_GROUPS.flatMap((g) => g.items), ...FOOT_NAV];

// Screens that live under a nav item's umbrella keep that item highlighted and
// its section expanded (subtab families, inner flows, the Labs mask, and the
// Preferences surface now nested under Store).
const NAV_HIGHLIGHT: Partial<Record<ScreenId, ScreenId>> = {
  labs: "campaigns",
  "product-editor": "catalog",
  inventory: "catalog",
  "products-po": "catalog",
  "products-transfers": "catalog",
  collections: "catalog",
  "locations-settings": "catalog",
  "import-shopify": "settings",
  cutover: "settings",
  agentic: "analytics",
  discover: "storefront",
  search: "storefront",
};

// Default subtab per screen — resolves which child reads active when the URL
// carries no explicit sub (e.g. /dashboard/orders lights the "orders" child).
const NAV_DEFAULT_SUB: Partial<Record<ScreenId, string>> = {
  orders: "orders",
  analytics: "perf",
  customers: "directory",
  settings: "general",
};

// Inner-flow screens that are not themselves a child map to the child that
// should stay lit (the product editor lives under the Products list).
const CHILD_SCREEN_ALIAS: Partial<Record<ScreenId, ScreenId>> = {
  "product-editor": "catalog",
};

// Does `child` correspond to the current nav state? Sub-children match on
// screen + resolved sub; screen-children match on the (alias-resolved) screen.
function childIsActive(child: NavChild, nav: NavState): boolean {
  if (child.sub != null) {
    const activeSub = nav.sub ?? NAV_DEFAULT_SUB[child.screen] ?? null;
    return nav.screen === child.screen && activeSub === child.sub;
  }
  const eff = CHILD_SCREEN_ALIAS[nav.screen] ?? nav.screen;
  return eff === child.screen;
}

// Where a parent row navigates: its own landing view. The parent row itself
// represents the section's default screen, so the child list only carries the
// section's other sub-views (no child duplicates the parent).
function parentTarget(item: NavItem): { screen: ScreenId; sub: string | null } {
  return { screen: item.id, sub: NAV_DEFAULT_SUB[item.id] ?? null };
}

// On phones the sidebar collapses to a bottom tab bar. These four ride the bar;
// everything else lives behind "More".
const PRIMARY_TABS: ScreenId[] = ["dashboard", "campaigns", "orders", "alerts"];

const DASHBOARD_THEME = {
  dark: true,
  // Design tokens. type scale multiplies every --type-scale font size; density
  // multiplies spacing. Both are dialed below the 1.0 base for a tighter,
  // more information-dense layout. Accent lives in the CSS token blocks per theme.
  density: "compact",
  radius: 14,
  glass: 0.72,
  typeScale: 0.9,
};

// Persisted night-mode preference (per browser). Dark is the default.
const NIGHT_MODE_KEY = "cd-night-mode";

const SCREENS: Record<ScreenId, (props: { app: DashboardCtx }) => JSX.Element> = {
  dashboard: ScreenDashboard,
  alerts: ScreenAlerts,
  campaigns: ScreenCampaigns,
  analytics: ScreenAnalytics,
  search: ScreenSearch,
  inventory: ScreenInventory,
  catalog: ScreenCatalog,
  collections: ScreenCollections,
  // Inner flow off the product list — reached via navigate("product-editor",
  // id|"new"), not from NAV_ITEMS (like Campaigns' detail view).
  "product-editor": ScreenProductEditor,
  "locations-settings": ScreenLocations,
  "import-shopify": ScreenImportShopify,
  cutover: ScreenCutover,
  audit: ScreenAudit,
  agentic: () => <AgenticChannel />,
  settings: ScreenSettings,
  // Hidden (not in the nav rail) — reached via the secret dot in Settings.
  labs: ScreenLabs,
  autopilot: ScreenAutopilot,
  orders: ScreenOrders,
  customers: ScreenCustomers,
  shipping: ScreenShipping,
  payments: ScreenPayments,
  storefront: ScreenStore,
  discover: ScreenDiscover,
  "products-po": ScreenPurchaseOrders,
  "products-transfers": ScreenTransfers,
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

export default function DashboardApp({
  authBase = "",
  shopDomain,
  storeLabel,
  orgSlug = null,
  demoMode = false,
  hasCatalog,
  canDeleteAccount = false,
  productTourPending = false,
  productTourAvailable = false,
}: {
  authBase?: string;
  shopDomain: string | null;
  storeLabel: string;
  /** Real tenant slug for storefront links (null for legacy Shopify sessions). */
  orgSlug?: string | null;
  demoMode?: boolean;
  /** Loader-side product-existence hint — seeds Home's first paint (see
   *  DashboardCtx.hasCatalog). Required so the loader stays the single owner
   *  of the fallback policy (its probe-error default). */
  hasCatalog: boolean;
  /** First-party account → Settings shows the self-delete Danger zone. Legacy
   *  Shopify (shop-based) sessions have no users row and are exempt. */
  canDeleteAccount?: boolean;
  /** New first-party accounts receive one automatic orientation on Home. */
  productTourPending?: boolean;
  /** Controls whether the account menu offers a replay entry point. */
  productTourAvailable?: boolean;
}) {
  // Night mode (dark theme). Defaults to dark; the merchant's choice persists in
  // localStorage. Initialised to true so the server render and first client render
  // agree (no hydration mismatch); a merchant who explicitly chose light ("0") is
  // applied post-mount.
  const [dark, setDark] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(NIGHT_MODE_KEY) === "0") setDark(false);
    } catch {
      /* localStorage unavailable — stay on the dark default */
    }
  }, []);
  const setNightMode = useCallback((next: boolean) => {
    // The design animates the theme flip: .cd-theming turns on color/background
    // transitions for the duration of the swap, then comes off.
    const root = document.querySelector(".cd-root");
    if (root) {
      root.classList.add("cd-theming");
      window.setTimeout(() => root.classList.remove("cd-theming"), 480);
    }
    setDark(next);
    try {
      window.localStorage.setItem(NIGHT_MODE_KEY, next ? "1" : "0");
    } catch {
      /* ignore persistence failure — the toggle still applies for this session */
    }
  }, []);
  const t = useMemo<DashboardTheme>(() => ({ ...DASHBOARD_THEME, dark }), [dark]);

  // Screen state is the URL: seeded from the SSR location (deep links) and
  // kept in sync with Remix navigation so browser back/forward works.
  const location = useLocation();
  const routerNavigate = useNavigate();
  const navigationType = useNavigationType();
  const [nav, setNav] = useState<NavState>(
    () => parsePath(location.pathname) ?? { screen: "dashboard", param: null, sub: null },
  );
  // Mobile "More" bottom sheet (only rendered/visible under the tab-bar breakpoint).
  const [moreOpen, setMoreOpen] = useState(false);
  // Bumped by the More-sheet items to open the assistant / bug-report overlays
  // (their floating launchers are hidden at phone width).
  const [assistantSignal, setAssistantSignal] = useState(0);
  // Home's prompt bar hands its typed text off to the panel through this
  // (sequence number so re-sending the same text still fires).
  const [assistantPrompt, setAssistantPrompt] = useState<{ n: number; text: string } | null>(null);
  const assistantPromptSeq = useRef(0);
  const [bugSignal, setBugSignal] = useState(0);
  // Account chip menu (sidebar foot).
  const [acctOpen, setAcctOpen] = useState(false);
  // The builder gets a focused canvas by default, with an explicit way to
  // restore the full rail when the merchant needs navigation context.
  const [storeSidebarExpanded, setStoreSidebarExpanded] = useState(false);
  const storeFocus = nav.screen === "storefront";
  const sidebarCompact = shouldCompactStoreSidebar(nav.screen, storeSidebarExpanded);
  const [tourPending, setTourPending] = useState(productTourPending);
  const [tourOpen, setTourOpen] = useState(false);
  const [assistantTourDemo, setAssistantTourDemo] = useState<{ n: number } | null>(null);
  const assistantTourDemoSeq = useRef(0);

  // The automatic tour waits until the merchant reaches Home. Deep links still
  // land where intended; the orientation appears the first time they return.
  useEffect(() => {
    if (tourPending && nav.screen === "dashboard") setTourOpen(true);
  }, [nav.screen, tourPending]);

  const navigate = useCallback(
    (
      screen: ScreenId,
      param: string | null = null,
      sub: string | null = null,
      opts?: { preserveScroll?: boolean },
    ) => {
      const next: NavState = { screen, param, sub };
      setNav(next);
      setMoreOpen(false);
      setAcctOpen(false);
      const path = pathFor(next);
      // Labs is deliberately unaddressed (routes.ts maps it to the home URL).
      // Skipping the router entirely keeps it out of history AND stops the
      // location-sync effect below from re-deriving Home and stomping it.
      if (screen !== "labs" && window.location.pathname !== path) {
        // Deliberately drop the query string: dashboard queries are one-shot
        // (OAuth return notices) and must not ride along to every screen.
        routerNavigate(path);
      }
      // In-place expansions (an alert row opening) keep the pane where it is.
      if (!opts?.preserveScroll) {
        document.getElementById("cd-main")?.scrollTo({ top: 0 });
      }
    },
    [routerNavigate],
  );

  // Back/forward re-derive the screen from Remix's location; an unknown deep
  // link canonicalizes to Mission Control.
  useEffect(() => {
    const next = parsePath(location.pathname);
    if (!next) {
      routerNavigate(DASHBOARD_BASE + location.search, { replace: true });
      setNav({ screen: "dashboard", param: null, sub: null });
      return;
    }
    setNav(next);
    if (navigationType === "POP") {
      document.getElementById("cd-main")?.scrollTo({ top: 0 });
    }
  }, [location.pathname, location.search, navigationType, routerNavigate]);

  // Escape closes the More sheet (backdrop click handles pointer dismissal).
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  // Cmd/Ctrl+K opens the assistant from anywhere (Home's prompt bar advertises
  // it). Bare chord only — Shift/Alt variants stay with the browser (Ctrl+
  // Shift+K is Firefox's console), and typing contexts keep their keystrokes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "k") return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      setAssistantSignal((n) => n + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The account menu dismisses on Escape or any pointer press outside its wrap
  // (there's no backdrop element — it floats over the sidebar foot).
  useEffect(() => {
    if (!acctOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAcctOpen(false);
    };
    const onPress = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest(".cd-acct-wrap")) {
        setAcctOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPress);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPress);
    };
  }, [acctOpen]);

  useEffect(() => {
    if (!storeFocus) setStoreSidebarExpanded(false);
  }, [storeFocus]);

  useEffect(() => {
    if (sidebarCompact) setAcctOpen(false);
  }, [sidebarCompact]);

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
  const [liveEngine, setLiveEngine] = useState<DashboardCtx["liveEngine"]>(null);
  const [loading, setLoading] = useState(true);

  // ----- live engine state -----
  const [liveOn, setLiveOn] = useState(true);
  const [feed, setFeed] = useState<FeedEvent[]>([]);

  // ----- toasts -----
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback(
    (text: string, icon?: string, tone?: string, action?: Toast["action"]) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((ts) => [...ts, { id, text, icon, tone, action }]);
      // Action-bearing toasts ("Go" buttons) get longer on-screen time — 3.4s isn't
      // enough to notice, read, and click a button. Plain toasts stay at 3.4s.
      const lifespan = action ? 7000 : 3400;
      setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), lifespan);
    },
    [],
  );

  const pushFeed = useCallback((ev: Omit<FeedEvent, "id">) => {
    setFeed((f) => [{ id: nextFeedId(), ts: ev.ts ?? Date.now(), ...ev }, ...f].slice(0, 30));
  }, []);

  // Journey completion toasts: fire anywhere in the app, not just on Home.
  // On every screen change, re-poll setup progress (throttled to one fetch
  // per 5s) and diff against the last-seen done-keys. The FIRST payload after
  // mount is the baseline (diffNewlyDone(null, ...) => []) so completions
  // from a prior session never toast; only transitions observed live do.
  // Short-circuits once the journey is retired (first_order landed) so it
  // stops polling forever after setup is done.
  const journeySeen = useRef<Set<string> | null>(null);
  const journeyLastFetch = useRef(0);
  useEffect(() => {
    const cached = cachedScreenData<JourneyProgress>(SCREEN_CACHE_KEYS.setupProgress);
    if (cached?.completed?.first_order) return;
    const now = Date.now();
    if (now - journeyLastFetch.current < 5000) return;
    journeyLastFetch.current = now;
    client
      .apiGet<JourneyProgress>("/dashboard/api/setup-progress")
      .then((p) => {
        cacheScreenData(SCREEN_CACHE_KEYS.setupProgress, p);
        const keys = Object.keys(p.completed);
        const fresh = diffNewlyDone(journeySeen.current, keys);
        journeySeen.current = new Set(keys);
        if (!fresh.length) return;
        const view = journeyView({
          completed: p.completed,
          liveCardDismissed: p.liveCardDismissed,
          recapDismissed: p.recapDismissed,
        });
        for (const key of fresh) {
          const nextDef = JOURNEY_STEPS.find((s) => s.key === view.next);
          const action =
            view.next && nextDef?.screen && !nextDef.screen.startsWith("__")
              ? { label: "Go", run: () => navigate(nextDef.screen as ScreenId) }
              : undefined;
          toast(journeyToastText(key as MilestoneKey, view.next), "check", undefined, action);
        }
      })
      .catch(() => {});
  }, [nav.screen, navigate, toast]);

  // One-shot post-OAuth connect notice: provider callbacks land the browser on
  // /dashboard/<originating-screen>?<provider>=connected|error. Surface the
  // result in place and strip the params so a reload doesn't re-announce it.
  // Legacy callbacks that only know /dashboard still open Settings.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const notice = connectionNotice(params);
    if (!notice) return;
    // Strip the consumed one-shot params from the LANDING entry first
    // (unrelated params + hash survive), THEN navigate — otherwise the pushed
    // settings entry inherits the params and the original ?provider=connected
    // URL stays behind the Back button, re-announcing on every pop.
    params.delete(notice.key);
    params.delete("reason");
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
    if (shouldOpenConnectorsAfterOAuth(window.location.pathname)) {
      navigate("settings", null, "connectors");
    }
    if (notice.ok) {
      toast(`${notice.provider} connected`, "check");
    } else {
      toast(
        notice.reason
          ? `Couldn't connect ${notice.provider} (${notice.reason})`
          : `Couldn't connect ${notice.provider}`,
        "x",
        "critical",
      );
    }
  }, [navigate, toast]);

  // Opening an alert detail: fetch the ENRICHED single alert and merge it into
  // shared state. The list (fetchAlerts) carries only the BASE remediation plan,
  // where the product-economics fixes (reallocate_spend_sku, cut_ads,
  // adjust_price) still have a null executor and render as advisory text — not
  // buttons. /dashboard/api/alerts/:id resolves those executors server-side
  // (enrichRemediation), exactly as the embedded app enriches in its loader.
  // Merging here fixes every surface that reads app.alerts (Alerts detail, etc.)
  // so the new actions show as one-click buttons, at parity with the extension.
  useEffect(() => {
    const id = nav.screen === "alerts" ? nav.param : null;
    if (!id) return;
    let cancelled = false;
    client
      .fetchAlert(id, campaigns)
      .then((enriched) => {
        if (cancelled) return;
        setAlerts((as) =>
          as.map((a) =>
            // Never resurrect an alert the user just resolved optimistically.
            a.id === enriched.id && a.status === "open" ? enriched : a,
          ),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [nav.screen, nav.param, campaigns]);

  // ----- initial load + refresh -----
  // Progressive: every endpoint runs concurrently and each state slice applies
  // the moment its own fetch resolves (boot.ts), so the Home's deck, gauge and
  // strip fill in as their data lands instead of the whole screen waiting for
  // the slowest call. `booted` flips only after a load completes with every
  // slice applied — the honest empty-states ("All clear", "standing by") and
  // the autopilot kickoff key off it, because a partially failed boot must
  // never be presented (or acted on) as a complete picture.
  const [booted, setBooted] = useState(false);
  // Overlapping runs (a focus-refresh landing mid-boot) must not interleave:
  // per-slice applies from a superseded run are dropped so state can't mix
  // generations (old alerts beside new queue).
  const loadGen = useRef(0);
  const load = useCallback(async () => {
    const gen = ++loadGen.current;
    const fresh =
      <T,>(set: (v: T) => void) =>
      (v: T) => {
        if (loadGen.current === gen) set(v);
      };
    await bootDashboardData({
      campaigns: fresh(setCampaigns),
      overview: fresh(setOverview),
      alerts: fresh(setAlerts),
      audit: fresh(setAudit),
      guardrails: fresh(setGuardrails),
      integrations: fresh(setIntegrations),
      consent: fresh(setConsent),
      calibration: fresh(setCalibration),
      actionQueue: fresh(setActionQueue),
      liveEngine: fresh(setLiveEngine),
    });
    if (loadGen.current === gen) setBooted(true);
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    load()
      .then(() => {
        // Warm every screen's cache in the background once the shared load
        // SUCCEEDS, so the first visit to any tab paints instantly instead of
        // a skeleton. Success-gated: a failing backend shouldn't get 17 more
        // background reads piled on. Idle-scheduled and sequential; the cache
        // is module-level, so a late warm-up still helps the next mount.
        const idle: (cb: () => void) => void =
          typeof window.requestIdleCallback === "function"
            ? (cb) => window.requestIdleCallback(cb, { timeout: 2000 })
            : (cb) => void window.setTimeout(cb, 350);
        idle(() => void warmScreenCaches());
      })
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

  // Lighter than refresh(): only re-pulls /dashboard/api/live-engine. Used by the
  // Live Engine's gentle poll and to reconcile a single autonomy toggle.
  const refreshLiveEngine = useCallback(() => {
    client.fetchLiveEngine().then(setLiveEngine).catch(() => {});
  }, []);

  const refreshCalibration = useCallback(() => {
    client.fetchCalibration().then(setCalibration).catch(() => {});
  }, []);

  // Nav-rail autopilot switch: same guardrail mutation Settings uses. The switch
  // flips optimistically so it reacts instantly; if the PUT fails we revert to
  // the prior state and surface the error, so the UI never lies about autopilot.
  const [apSaving, setApSaving] = useState(false);
  const toggleAutopilot = useCallback(async () => {
    if (!guardrails || apSaving) return;
    const prev = guardrails;
    const next = !guardrails.autopilot_enabled;
    setGuardrails({ ...guardrails, autopilot_enabled: next }); // optimistic flip
    setApSaving(true);
    try {
      const updated = await client.putGuardrails({ autopilot_enabled: next });
      setGuardrails(updated);
      toast(next ? "Autopilot on" : "Autopilot paused", next ? "bolt" : "pause");
    } catch (err) {
      setGuardrails(prev); // revert — the server never accepted the change
      const msg = err instanceof DashboardApiError ? err.message : "Couldn't update autopilot.";
      toast(msg, "warn", "critical");
    } finally {
      setApSaving(false);
    }
  }, [guardrails, apSaving, toast]);

  const signOut = useCallback(async () => {
    try {
      await client.logout();
    } catch {
      // Session may already be gone; the login page sorts it out either way.
    }
    window.location.assign("/login?notice=signed_out");
  }, []);

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
  // and the live poller already streams any later cron actions. Gated on
  // `booted` (a fully-successful load), not `loading` — with the progressive
  // boot, guardrails can be set by a PARTIALLY failed load, and a broken boot
  // must never trigger real actions.
  const autopilotRan = useRef(false);
  useEffect(() => {
    if (autopilotRan.current || !booted || !guardrails) return;
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
  }, [booted, guardrails, campaigns, toast]);

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
    async (
      alert: AlertVM,
      kind: ActionKind,
      opts?: {
        newPriceCents?: number;
        campaignId?: string;
        loserBudgetCents?: number;
        poQuantity?: string;
        poUnitCost?: string;
      },
    ) => {
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
          return { ok: true, receipt: null };
        } catch (err) {
          const msg = err instanceof DashboardApiError ? err.message : "Action failed.";
          toast(msg, "warn", "critical");
          return { ok: false, receipt: null };
        }
      }

      // pause / reduce-budget: live endpoint. The campaign is either the alert's
      // own (campaign-level alerts) or the remediation move's loser campaign
      // (cut_ads on a SKU-level alert, passed via opts.campaignId).
      const campId = opts?.campaignId ?? alert.campaign_id;
      if (
        (kind === "pause_campaign" ||
          kind === "resume_campaign" ||
          kind === "reduce_campaign_budget" ||
          kind === "increase_campaign_budget") &&
        campId
      ) {
        // Target budget: reduce → 70% of current; increase → scale up by the
        // engine's suggested percent (alert evidence increase_pct, default +20%);
        // pause → none. Prefer a POSITIVE live campaigns-list budget; else the
        // move's carried budget (cut_ads SKU alert); else the alert evidence
        // daily_budget_usd (scaling alert whose campaign has a null/ad-set-level
        // budget that v_campaigns_flat coerces to 0). Mirrors the embedded route —
        // without the evidence fallback the Scale button 422s on those campaigns.
        const listBudget = campaigns.find((c) => c.id === campId)?.daily_budget_cents;
        const evBudgetCents =
          Number(alert.evidence?.daily_budget_usd) > 0
            ? Math.round(Number(alert.evidence.daily_budget_usd) * 100)
            : undefined;
        const currentBudgetCents =
          (listBudget && listBudget > 0 ? listBudget : undefined) ??
          opts?.loserBudgetCents ??
          evBudgetCents;
        let targetBudget: number | undefined;
        if (kind === "reduce_campaign_budget" && currentBudgetCents) {
          targetBudget = Math.round(currentBudgetCents * 0.7);
        } else if (kind === "increase_campaign_budget" && currentBudgetCents) {
          const pct = Number(alert.evidence?.increase_pct) || 20;
          targetBudget = Math.round(currentBudgetCents * (1 + pct / 100));
        }
        let receipt: ApproveReceipt | null = null;
        let ok = false;
        try {
          const { outcome, calibration } = await client.executeCampaignAction(campId, {
            type: kind,
            dailyBudgetCents: targetBudget,
            alertId: alert.id,
          });
          const view = presentActionOutcome(outcome, label);
          if (view.succeeded) {
            ok = true;
            receipt = calibration ?? null;
            if (receipt) refreshCalibration();
          }
          // A non-succeeded outcome (retrying / failed) must NOT resolve the
          // alert or apply the optimistic paused/budget state — only a real
          // platform success does (P0-1). The terminal `failed` outcome arrives
          // as an HTTP 502 → DashboardApiError (caught below); a `retrying`
          // arrives here as a 200 and is queued, not a success.
          if (view.succeeded) {
            markResolved();
            setCampaigns((cs) =>
              cs.map((c) => {
                if (c.id !== campId) return c;
                if (kind === "pause_campaign") return { ...c, status: "paused" };
                if (kind === "resume_campaign") return { ...c, status: "active" };
                return { ...c, daily_budget_cents: targetBudget ?? c.daily_budget_cents };
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
        return { ok, receipt };
      }

      // exclude_geo: live endpoint — drops the alert's region bucket from the
      // campaign's targeting (Meta real, Google real, TikTok fail-visible). The
      // region was resolved + validated in adaptAlert; only a real platform
      // success resolves the alert (P0-1), a 502 surfaces as an error toast.
      if (kind === "exclude_geo" && campId && alert.region) {
        let receipt: ApproveReceipt | null = null;
        let ok = false;
        try {
          const { outcome, calibration } = await client.executeCampaignAction(campId, {
            type: kind,
            region: alert.region,
            alertId: alert.id,
          });
          const view = presentActionOutcome(outcome, label);
          if (view.succeeded) {
            ok = true;
            receipt = calibration ?? null;
            if (receipt) refreshCalibration();
            markResolved();
          }
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
        return { ok, receipt };
      }

      // discontinue_sku: live endpoint — archives the product on Shopify and
      // sets the internal Do-Not-Reorder flag, both derived server-side from the
      // alert. A failure (e.g. SKU with no Shopify product) surfaces as an error
      // toast, never a fake resolution.
      if (kind === "discontinue_sku") {
        let ok = false;
        let receipt: ApproveReceipt | null = null;
        try {
          const { acknowledged, calibration } = await client.executeAlertAction(alert.id, { type: kind });
          ok = true;
          receipt = calibration ?? null;
          if (receipt) refreshCalibration();
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
        return { ok, receipt };
      }

      // reallocate_inventory: live endpoint — the transfer plan is derived
      // server-side from the alert's evidence, so failures (e.g. evidence
      // without a concrete move) surface as an error toast, never a fake
      // resolution.
      if (kind === "reallocate_inventory") {
        let receipt: ApproveReceipt | null = null;
        let ok = false;
        try {
          const { outcome, acknowledged, calibration } = await client.executeAlertAction(alert.id, { type: kind });
          const view = presentActionOutcome(outcome, label);
          // Only a real success resolves the alert (P0-1); a Shopify failure
          // arrives as an HTTP 502 → DashboardApiError (caught below).
          if (view.succeeded) {
            ok = true;
            markResolved();
            receipt = calibration ?? null;
            if (receipt) refreshCalibration();
          }
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
        return { ok, receipt };
      }

      // reallocate_spend_sku: live endpoint — the campaign pair and shift amount
      // are derived server-side by enrichRemediation (Task 7 route + Task 6
      // gateway). The client sends only the action kind; no campaign ids.
      if (kind === "reallocate_spend_sku") {
        let ok = false;
        let receipt: ApproveReceipt | null = null;
        try {
          const { acknowledged, calibration } = await client.executeAlertAction(alert.id, { type: kind });
          ok = true;
          receipt = calibration ?? null;
          if (receipt) refreshCalibration();
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
        return { ok, receipt };
      }

      // create_po_draft: live endpoint — builds a PO draft from the alert + the
      // merchant's quantity/cost and records it (the PDF is downloadable from the
      // action history). A local document; no external mutation.
      if (kind === "create_po_draft") {
        try {
          const { acknowledged, calibration } = await client.executeAlertAction(alert.id, {
            type: kind,
            poQuantity: opts?.poQuantity,
            poUnitCost: opts?.poUnitCost,
          });
          const receipt = calibration ?? null;
          if (receipt) refreshCalibration();
          markResolved();
          client
            .fetchAudit()
            .then((au) => setAudit(au))
            .catch(() => {});
          toast(
            `${label} — drafted. Download the PDF from your action history.` +
              (acknowledged ? "" : " Alert couldn't be acknowledged."),
            "check",
          );
          return { ok: true, receipt };
        } catch (err) {
          const msg = err instanceof DashboardApiError ? err.message : "Action failed.";
          toast(msg, "warn", "critical");
          return { ok: false, receipt: null };
        }
      }

      // adjust_price: live endpoint — raises the SKU's selling price to restore
      // its pre-erosion margin. The new price is the engine suggestion unless the
      // merchant typed an override (opts.newPriceCents); the executor bounds it to
      // the price cap and reads the authoritative live price. Reversible from
      // history. A failure (no variant, out-of-cap, Shopify error) surfaces as an
      // error toast, never a fake resolution.
      if (kind === "adjust_price") {
        try {
          const { acknowledged, calibration } = await client.executeAlertAction(alert.id, {
            type: kind,
            newPriceCents: opts?.newPriceCents,
          });
          const receipt = calibration ?? null;
          if (receipt) refreshCalibration();
          markResolved();
          client
            .fetchAudit()
            .then((au) => setAudit(au))
            .catch(() => {});
          toast(
            `${label} — price updated on Shopify. Logged to action history; reversible there.` +
              (acknowledged ? "" : " Alert couldn't be acknowledged."),
            "check",
          );
          return { ok: true, receipt };
        } catch (err) {
          const msg = err instanceof DashboardApiError ? err.message : "Action failed.";
          toast(msg, "warn", "critical");
          return { ok: false, receipt: null };
        }
      }

      // No live dashboard endpoint for this kind (or a precondition was missing).
      // Ways to land here:
      //   (1) create_po_draft routed without its quantity/cost dialog (handled
      //       above), or another non-inline kind reached by a direct caller.
      //   (2) pause_campaign / reduce_campaign_budget / exclude_geo on a
      //       (malformed) alert with no campaign_id — or exclude_geo with no
      //       resolved region bucket — so the live branch above is skipped.
      // Either way NEVER fake a success (rule 12): leave the alert unresolved
      // and surface a visible toast, no phantom audit row.
      toast(
        `${label} isn't available on the dashboard yet. Open it on the alert to review.`,
        "warn",
        "critical",
      );
      return { ok: false, receipt: null };
    },
    [campaigns, refreshCalibration, toast],
  );

  const undoAction = useCallback(
    async (entry: AuditVM) => {
      try {
        const { auditId } = await client.undoAudit(entry.id);
        // Insert the undo row (with the server's id) so the "Recovered" total
        // claws this action's dollars back immediately, not 15s later.
        setAudit((au) => applyUndo(au, entry, auditId));
        toast("Action undone. Previous state restored.", "undo");
      } catch (err) {
        const msg = err instanceof DashboardApiError ? err.message : "Undo failed.";
        toast(msg, "warn", "critical");
      }
    },
    [toast],
  );

  // ----- act on a weather prediction (Weather tab or its mirrored alert) -----
  const weatherIntent = useCallback(
    async (suggestionId: string, intent: "apply" | "arm" | "dismiss") => {
      try {
        await applyWeatherSuggestion(suggestionId, intent);
      } catch {
        toast("Could not update the suggestion", "x", "critical");
        return false;
      }
      // The server resolves the mirrored alert on every intent (an armed move
      // lives on the Weather tab, with Disarm, until the trigger fires) —
      // mirror that locally so both surfaces agree without a refetch.
      setAlerts((as) =>
        as.map((a) =>
          a.evidence?.suggestion_id === suggestionId && a.status === "open"
            ? { ...a, status: "resolved" }
            : a,
        ),
      );
      // Write through the Customers session cache so a tab-switch doesn't
      // reseed the stale pre-action suggestion list.
      const cached = cachedScreenData<CustomersPage>(SCREEN_CACHE_KEYS.customers);
      if (cached?.weatherSuggestions) {
        cacheScreenData(SCREEN_CACHE_KEYS.customers, {
          ...cached,
          weatherSuggestions:
            intent === "arm"
              ? cached.weatherSuggestions.map((s) =>
                  s.id === suggestionId ? { ...s, status: "armed" as const } : s,
                )
              : cached.weatherSuggestions.filter((s) => s.id !== suggestionId),
        });
      }
      if (intent === "apply") {
        // Budget moved — pull the authoritative audit row in.
        client
          .fetchAudit()
          .then((au) => setAudit(au))
          .catch(() => {});
      }
      toast(
        intent === "apply"
          ? "Budget shifted"
          : intent === "arm"
            ? "Scheduled — runs when the forecast confirms"
            : "Move rejected",
        "check",
      );
      return true;
    },
    [toast],
  );

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
        why: "Manual (dashboard)",
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
      toast("Draft pushed to Meta, created paused for your review.", "check");
    },
    [pushFeed, toast],
  );

  const openAssistant = useCallback((prompt?: string) => {
    const text = prompt?.trim();
    if (text) setAssistantPrompt({ n: ++assistantPromptSeq.current, text });
    setAssistantSignal((n) => n + 1);
  }, []);

  const handleTourOutcome = useCallback(
    (outcome: ProductTourOutcome) => {
      // Preview steps intentionally keep the browser URL on Home. Reconcile
      // the visible screen before closing so Skip, Escape, and Finish never
      // leave history and the dashboard UI describing different locations.
      navigate("dashboard");
      setTourOpen(false);
      setTourPending(false);
      client
        .apiSend("POST", "/dashboard/api/product-tour", { intent: outcome })
        .catch((error: unknown) =>
          toast(
            error instanceof client.DashboardApiError
              ? error.message
              : "We couldn't save that choice. The tour may appear again next time.",
            "warn",
            "critical",
          ),
        );
    },
    [navigate, toast],
  );

  const replayProductTour = useCallback(() => {
    setAcctOpen(false);
    navigate("dashboard");
    setTourOpen(true);
  }, [navigate]);

  // Tour navigation swaps the real dashboard screen in place. Using Remix
  // navigation here would reload the route loader and remount DashboardApp,
  // which would discard the active tour before the next step can render.
  const previewTourDestination = useCallback((screen: ScreenId) => {
    setNav({ screen, param: null, sub: null });
    setMoreOpen(false);
    setAcctOpen(false);
    document.getElementById("cd-main")?.scrollTo({ top: 0 });
  }, []);

  const handleAssistantTourDemo = useCallback((active: boolean) => {
    setAssistantTourDemo(active ? { n: ++assistantTourDemoSeq.current } : null);
  }, []);

  const app: DashboardCtx = {
    t,
    authBase,
    shopDomain,
    storeLabel,
    orgSlug,
    demoMode,
    hasCatalog,
    canDeleteAccount,
    nav,
    navigate,
    setNightMode,
    alerts,
    campaigns,
    audit,
    guardrails,
    integrations,
    setIntegrations,
    consent,
    overview,
    calibration,
    refreshCalibration,
    actionQueue,
    liveEngine,
    feed,
    liveOn,
    setLiveOn,
    executeAction,
    undoAction,
    weatherIntent,
    pushAdDraft,
    toast,
    relTime,
    openAssistant,
    refresh,
    refreshLiveEngine,
    loading,
    booted,
  };

  // CSS tokens applied on .cd-root. --accent is deliberately NOT set here: an
  // inline custom property would override the .cd-dark token block and lock
  // night mode to the light accent (invisible icons/buttons).
  const vars = useMemo(() => {
    const density =
      ({ compact: 0.82, balanced: 1, comfy: 1.18 } as Record<string, number>)[
        String(t.density)
      ] ?? 1;
    return {
      "--radius": t.radius + "px",
      "--glass": t.glass,
      "--density": density,
      "--type-scale": t.typeScale,
    } as React.CSSProperties;
  }, [t.radius, t.glass, t.density, t.typeScale]);

  const Screen = SCREENS[nav.screen] ?? ScreenDashboard;

  // Screen-swap feedback: the incoming screen rises in over ~200ms. Skipped on
  // the very first paint (loading into a task shouldn't choreograph) and under
  // prefers-reduced-motion. clearProps drops the transform afterwards so no
  // containing block lingers for fixed/absolute descendants.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const firstScreenPaint = useRef(true);
  useGSAP(
    () => {
      if (firstScreenPaint.current) {
        firstScreenPaint.current = false;
        return;
      }
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      gsap.fromTo(
        ".cd-screen",
        { opacity: 0, y: 10 },
        { opacity: 1, y: 0, duration: 0.22, ease: "power3.out", clearProps: "opacity,transform" },
      );
    },
    { dependencies: [nav.screen], scope: mainRef },
  );

  // Storefront focus mode trades the full navigation rail for a quiet icon
  // strip. GSAP owns the geometry so the canvas grows continuously instead of
  // jumping; autoAlpha also removes hidden labels from pointer interaction.
  useGSAP(
    () => {
      const sidebar = sidebarRef.current;
      if (!sidebar) return;

      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const duration = reducedMotion ? 0 : 0.36;
      const copy = sidebar.querySelectorAll<HTMLElement>(
        ".cd-sidebar-copy, .cd-nav-group, .cd-subnav, .cd-apswitch, .cd-live-row, .cd-acct-body, .cd-acct-chev, .cd-nav-caret",
      );

      gsap.to(sidebar, {
        width: sidebarCompact ? STORE_SIDEBAR_COMPACT_WIDTH : DASHBOARD_SIDEBAR_WIDTH,
        paddingLeft: sidebarCompact ? 8 : 12,
        paddingRight: sidebarCompact ? 8 : 12,
        duration,
        ease: "power3.out",
        overwrite: "auto",
      });
      gsap.to(copy, {
        autoAlpha: sidebarCompact ? 0 : 1,
        x: sidebarCompact ? -8 : 0,
        duration: reducedMotion ? 0 : 0.18,
        ease: "power2.out",
        overwrite: "auto",
      });

      if (sidebarToggleRef.current) {
        gsap.to(sidebarToggleRef.current, {
          x: sidebarCompact
            ? -(DASHBOARD_SIDEBAR_WIDTH - STORE_SIDEBAR_COMPACT_WIDTH)
            : 0,
          duration,
          ease: "power3.out",
          overwrite: "auto",
        });
      }
    },
    { dependencies: [sidebarCompact, storeFocus], scope: rootRef },
  );

  const openCount = alerts.filter((a) => a.status === "open").length;
  // Umbrella screens (subtab families, inner flows, the Labs mask) keep their
  // nav item lit (sidebar, tab bar, and the "More" active state read off this).
  const activeNav: ScreenId = NAV_HIGHLIGHT[nav.screen] ?? nav.screen;

  // Store label initials for the account chip (first letters of two words).
  const acctInitials = storeLabel
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // Bottom-tab-bar partition: the four primary tabs (in design order) + the rest
  // behind "More". "More" reads active whenever a non-primary screen is open. A
  // primary tab that owns sub-views (Orders) also rides the More sheet so those
  // sub-views stay reachable on phones (the rail is hidden there).
  const primaryTabs = PRIMARY_TABS.map(
    (id) => ALL_NAV_ITEMS.find((n) => n.id === id)!,
  );
  const moreItems = ALL_NAV_ITEMS.filter(
    (n) => !PRIMARY_TABS.includes(n.id) || (n.children?.length ?? 0) > 0,
  );
  const onMoreScreen = !PRIMARY_TABS.includes(activeNav);

  // One rail row. Autopilot keeps its sibling kill-switch; sections with
  // children become expandable (parent opens the default view + discloses the
  // children indented beneath, accordion by active section); everything else is
  // a single link, unchanged.
  const renderNavItem = (item: NavItem) => {
    if (item.id === "autopilot" && guardrails) {
      return (
        <div key={item.id} style={{ position: "relative" }}>
          <button
            className="cd-nav-item"
            data-active={activeNav === item.id ? "1" : "0"}
            data-tour-anchor={item.id}
            style={{ width: "100%", paddingRight: 52 }}
            title={sidebarCompact ? item.label : undefined}
            onClick={() => navigate(item.id)}
          >
            <CDIcon name={item.icon} size={18} strokeWidth={1.8} />
            <span className="cd-sidebar-copy">{item.label}</span>
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={guardrails.autopilot_enabled}
            aria-label="Autopilot on/off"
            title={guardrails.autopilot_enabled ? "Autopilot on" : "Autopilot off"}
            className="cd-apswitch"
            data-on={guardrails.autopilot_enabled ? "1" : "0"}
            disabled={apSaving}
            onClick={toggleAutopilot}
            style={{
              position: "absolute",
              right: 10,
              top: "50%",
              transform: "translateY(-50%)",
              border: 0,
              padding: 0,
              cursor: "pointer",
            }}
          >
            <i />
          </button>
        </div>
      );
    }

    const kids = item.children?.filter((child) => child.key !== "pnl" || canViewOperatingPnl(integrations));
    if (kids && kids.length > 0) {
      const expanded = activeNav === item.id;
      const target = parentTarget(item);
      return (
        <div key={item.id} className="cd-nav-sec" data-expanded={expanded ? "1" : "0"}>
          <button
            type="button"
            className="cd-nav-item cd-nav-parent"
            data-active={activeNav === item.id ? "1" : "0"}
            data-tour-anchor={item.id}
            data-expanded={expanded ? "1" : "0"}
            aria-expanded={expanded}
            title={sidebarCompact ? item.label : undefined}
            onClick={() => navigate(target.screen, null, target.sub)}
          >
            <CDIcon name={item.icon} size={18} strokeWidth={1.8} />
            <span className="cd-sidebar-copy">{item.label}</span>
            <CDIcon name="chevronDown" size={15} strokeWidth={2} className="cd-nav-caret" />
          </button>
          {expanded && (
            <div className="cd-subnav" role="group" aria-label={item.label}>
              {kids.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className="cd-subnav-item"
                  data-active={childIsActive(c, nav) ? "1" : "0"}
                  onClick={() => navigate(c.screen, null, c.sub ?? null)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }

    return (
      <button
        key={item.id}
        type="button"
        className="cd-nav-item"
        data-active={activeNav === item.id ? "1" : "0"}
        title={sidebarCompact ? item.label : undefined}
        data-tour-anchor={item.id}
        onClick={() => navigate(item.id)}
      >
        <CDIcon name={item.icon} size={18} strokeWidth={1.8} />
        <span className="cd-sidebar-copy">{item.label}</span>
        {item.id === "alerts" && openCount > 0 && (
          <span className="cd-nav-count">{openCount}</span>
        )}
      </button>
    );
  };

  return (
    <div
      ref={rootRef}
      className={"cd-root" + (t.dark ? " cd-dark" : "")}
      data-store-focus={storeFocus ? "1" : "0"}
      style={vars}
    >
      {/* Sidebar */}
      <aside
        id="cd-dashboard-sidebar"
        ref={sidebarRef}
        className="cd-sidebar"
        data-compact={sidebarCompact ? "1" : "0"}
        data-screen-label="Sidebar"
      >
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
              fill="var(--accent)"
            />
            <path
              d="M24.4 11.15 L16 6.3 L7.6 11.15 L7.6 20.85 L16 25.7 L24.4 20.85"
              stroke="var(--on-accent)"
              strokeWidth="3.6"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
          <div className="cd-sidebar-copy">
            <div className="cd-brand-name">Calderyn</div>
            <div className="cd-brand-sub">{storeLabel}</div>
          </div>
        </div>
        <nav className="cd-side-nav cd-nav-scroll">
          <button
            type="button"
            className="cd-ask-btn"
            title={sidebarCompact ? "Ask Calderyn" : undefined}
            data-tour-anchor="assistant"
            onClick={() => setAssistantSignal((n) => n + 1)}
          >
            <CDIcon name="assist" size={18} strokeWidth={1.8} />
            <span className="cd-sidebar-copy">Ask Calderyn</span>
          </button>
          {NAV_GROUPS.map((group) => (
            <div key={group.label} style={{ display: "contents" }}>
              <div className="cd-nav-group">{group.label}</div>
              {group.items.map((item) => renderNavItem(item))}
            </div>
          ))}
        </nav>
        <div className="cd-side-foot">
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {FOOT_NAV.map((item) => renderNavItem(item))}
            <div className="cd-live-row">
              <CDIcon name="moon" size={15} strokeWidth={1.9} />
              <span className="flex-1">Night mode</span>
              <Toggle value={dark} onChange={setNightMode} ariaLabel="Night mode" />
            </div>
          </div>
          <div className="cd-acct-wrap">
            <div className="cd-acct-menu" data-open={acctOpen ? "1" : "0"}>
              <button type="button" className="cd-acct-mi" onClick={() => navigate("settings")}>
                <CDIcon name="gear" size={16} strokeWidth={1.8} />
                Account settings
              </button>
              <button type="button" className="cd-acct-mi" onClick={() => navigate("payments")}>
                <CDIcon name="card" size={16} strokeWidth={1.8} />
                Billing & payouts
              </button>
              {productTourAvailable && (
                <button type="button" className="cd-acct-mi" onClick={replayProductTour}>
                  <CDIcon name="play" size={16} strokeWidth={1.8} />
                  Take the quick tour
                </button>
              )}
              <div className="cd-acct-sep" />
              <button type="button" className="cd-acct-mi" data-danger="1" onClick={signOut}>
                <CDIcon name="logout" size={16} strokeWidth={1.8} />
                Sign out
              </button>
            </div>
            <button
              type="button"
              className="cd-acct"
              data-open={acctOpen ? "1" : "0"}
              aria-expanded={sidebarCompact ? undefined : acctOpen}
              aria-haspopup={sidebarCompact ? undefined : "menu"}
              aria-label={sidebarCompact ? "Account settings" : undefined}
              title={sidebarCompact ? "Account settings" : undefined}
              onClick={() => {
                if (sidebarCompact) navigate("settings");
                else setAcctOpen((v) => !v);
              }}
            >
              <span className="cd-acct-av">{acctInitials || "C"}</span>
              <span className="cd-acct-body">
                <span className="cd-acct-name">{storeLabel}</span>
                <span className="cd-acct-mail">{shopDomain ?? "Calderyn store"}</span>
              </span>
              <span className="cd-acct-chev">
                <CDIcon name="chevronDown" size={15} strokeWidth={1.9} />
              </span>
            </button>
          </div>
        </div>
      </aside>

      {storeFocus && (
        <button
          ref={sidebarToggleRef}
          type="button"
          className="cd-store-focus-toggle"
          aria-controls="cd-dashboard-sidebar"
          aria-expanded={!sidebarCompact}
          aria-label={sidebarCompact ? "Expand dashboard sidebar" : "Minimize dashboard sidebar"}
          title={sidebarCompact ? "Expand sidebar" : "Minimize sidebar"}
          onClick={() => setStoreSidebarExpanded((expanded) => !expanded)}
        >
          <CDIcon
            name={sidebarCompact ? "chevronRight" : "chevronLeft"}
            size={15}
            strokeWidth={2.2}
          />
        </button>
      )}

      {/* Main */}
      <main id="cd-main" className="cd-main" ref={mainRef} data-tour-anchor="screen">
        <Screen app={app} />
      </main>

      <OnboardingTour
        open={tourOpen}
        onOutcome={handleTourOutcome}
        onDemoNavigate={previewTourDestination}
        onAssistantDemo={handleAssistantTourDemo}
      />

      <AssistantPanel
        app={app}
        openSignal={assistantSignal}
        prompt={assistantPrompt}
        tourDemo={assistantTourDemo}
      />
      <BugReportButton app={app} openSignal={bugSignal} />
      <ContactButton app={app} />

      {/* Mobile bottom tab bar — hidden above the phone breakpoint via CSS. */}
      <nav className="cd-tabbar" aria-label="Primary">
        {primaryTabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className="cd-tab"
            data-active={activeNav === item.id ? "1" : "0"}
            data-tour-anchor={item.id}
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
          data-tour-anchor="more"
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
              {moreItems.map((item) => {
                const target = parentTarget(item);
                return (
                  <div key={item.id} className="cd-more-sec">
                    <button
                      type="button"
                      className="cd-more-item"
                      data-active={activeNav === item.id ? "1" : "0"}
                      onClick={() => navigate(target.screen, null, target.sub)}
                    >
                      <CDIcon name={item.icon} size={18} strokeWidth={1.8} />
                      <span>{item.label}</span>
                    </button>
                    {item.children && (
                      <div className="cd-more-subnav">
                        {item.children.filter((child) => child.key !== "pnl" || canViewOperatingPnl(integrations)).map((c) => (
                          <button
                            key={c.key}
                            type="button"
                            className="cd-more-subitem"
                            data-active={childIsActive(c, nav) ? "1" : "0"}
                            onClick={() => navigate(c.screen, null, c.sub ?? null)}
                          >
                            {c.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
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
              <button
                type="button"
                className="cd-more-item"
                data-danger="1"
                onClick={() => {
                  setMoreOpen(false);
                  void signOut();
                }}
              >
                <CDIcon name="logout" size={18} strokeWidth={1.8} />
                <span>Sign out</span>
              </button>
            </div>
            <div className="cd-more-foot">
              <div className="cd-live-row">
                <CDIcon name="moon" size={15} strokeWidth={1.9} />
                <span className="flex-1">Night mode</span>
                <Toggle value={dark} onChange={setNightMode} ariaLabel="Night mode" />
              </div>
              <div className="cd-caption" style={{ paddingLeft: 2 }}>
                Shopify · Meta · Google · TikTok · QuickBooks
              </div>
            </div>
          </div>
        </div>
      )}

      <ToastHost toasts={toasts} />
    </div>
  );
}
