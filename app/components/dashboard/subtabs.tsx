import type { DashboardCtx, Screen } from "./context";

// Shared subtab row (design: .cd-subtabs). Each tab navigates to a dedicated
// URL — subtab state lives in the address bar, never in component state.

export interface SubTabDef {
  key: string;
  label: string;
  screen: Screen;
  sub?: string | null;
  param?: string | null;
  count?: string | null;
}

export function SubTabs({
  app,
  tabs,
  activeKey,
}: {
  app: DashboardCtx;
  tabs: SubTabDef[];
  activeKey: string;
}) {
  return (
    <div className="cd-subtabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={t.key === activeKey}
          className="cd-subtab"
          data-active={t.key === activeKey ? "1" : "0"}
          onClick={() => app.navigate(t.screen, t.param ?? null, t.sub ?? null)}
        >
          {t.label}
          {t.count != null && <span className="cd-subtab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// The Products surface carries exactly four subtabs. Collections and
// Locations remain reachable at their URLs but no longer sit on this bar
// (their screens render without it).
const PRODUCTS_TABS: SubTabDef[] = [
  { key: "catalog", label: "Catalog", screen: "catalog" },
  { key: "inventory", label: "Inventory", screen: "inventory" },
  { key: "po", label: "Purchase orders", screen: "products-po" },
  { key: "transfers", label: "Transfers", screen: "products-transfers" },
];

const PRODUCTS_ACTIVE: Partial<Record<Screen, string>> = {
  catalog: "catalog",
  "product-editor": "catalog",
  inventory: "inventory",
  "products-po": "po",
  "products-transfers": "transfers",
};

export function ProductsSubTabs({ app }: { app: DashboardCtx }) {
  return (
    <SubTabs
      app={app}
      tabs={PRODUCTS_TABS}
      activeKey={PRODUCTS_ACTIVE[app.nav.screen] ?? "catalog"}
    />
  );
}

const SETTINGS_TABS: SubTabDef[] = [
  { key: "general", label: "General", screen: "settings", sub: "general" },
  { key: "connectors", label: "Connectors", screen: "settings", sub: "connectors" },
  { key: "mcp", label: "MCP & CLI", screen: "settings", sub: "mcp" },
  { key: "import", label: "Import from Shopify", screen: "import-shopify" },
  { key: "golive", label: "Go live", screen: "cutover" },
];

export function SettingsSubTabs({ app }: { app: DashboardCtx }) {
  const active =
    app.nav.screen === "import-shopify"
      ? "import"
      : app.nav.screen === "cutover"
        ? "golive"
        : (app.nav.sub ?? "general");
  return <SubTabs app={app} tabs={SETTINGS_TABS} activeKey={active} />;
}

// The Store surface (BUILD group): the studio builder + the viral-product
// Discover feed sit side by side on one subtab bar.
const STORE_TABS: SubTabDef[] = [
  { key: "store", label: "Store", screen: "storefront" },
  { key: "discover", label: "Discover", screen: "discover" },
];

const STORE_ACTIVE: Partial<Record<Screen, string>> = {
  storefront: "store",
  discover: "discover",
};

export function StoreSubTabs({ app }: { app: DashboardCtx }) {
  return (
    <SubTabs app={app} tabs={STORE_TABS} activeKey={STORE_ACTIVE[app.nav.screen] ?? "store"} />
  );
}
