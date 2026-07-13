import { lazy, Suspense, useEffect, useState, type KeyboardEvent } from "react";
import { Btn, Card, Pill, Placeholder } from "../ui";
import { money } from "../format";
import { DashboardApiError } from "~/lib/dashboard/client";
import {
  fetchShippingSummary,
  type ShippingSummary,
} from "~/lib/dashboard/shipping-client";
import {
  cacheScreenData,
  cachedScreenData,
  SCREEN_CACHE_KEYS,
} from "~/lib/dashboard/screen-cache";
import type { DashboardCtx } from "../context";

// Own chunk: keeps maplibre-gl out of the main dashboard bundle.
const ShippingRouteMap = lazy(() => import("../ShippingRouteMap"));

const SHIPPING_TABS = ["overview", "rates", "setup"] as const;
const RATE_GRID = "1.4fr 1fr 1fr 1fr";

export type ShippingTab = (typeof SHIPPING_TABS)[number];

const SHIPPING_TAB_LABELS: Record<ShippingTab, string> = {
  overview: "Overview",
  rates: "Rates & delivery",
  setup: "Setup",
};

export function nextShippingTab(
  current: ShippingTab,
  key: string,
): ShippingTab {
  if (key === "Home") return SHIPPING_TABS[0];
  if (key === "End") return SHIPPING_TABS[SHIPPING_TABS.length - 1];

  const direction =
    key === "ArrowRight" || key === "ArrowDown"
      ? 1
      : key === "ArrowLeft" || key === "ArrowUp"
        ? -1
        : 0;
  if (direction === 0) return current;

  const index = SHIPPING_TABS.indexOf(current);
  return SHIPPING_TABS[
    (index + direction + SHIPPING_TABS.length) % SHIPPING_TABS.length
  ];
}

/** Labeled address line; skips empty values instead of rendering blank rows. */
function AddressRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="cd-shipping-address-row">
      <span className="cd-caption">{label}</span>
      <span className="cd-shipping-address-value">{value}</span>
    </div>
  );
}

function CoverageStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="cd-shipping-coverage-stat">
      <span className="cd-stat-value tabular-nums">{value}</span>
      <span className="cd-caption">{label}</span>
    </div>
  );
}

function ShippingTabs({
  activeTab,
  onTabChange,
}: {
  activeTab: ShippingTab;
  onTabChange: (tab: ShippingTab) => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (
      ![
        "ArrowRight",
        "ArrowDown",
        "ArrowLeft",
        "ArrowUp",
        "Home",
        "End",
      ].includes(event.key)
    ) {
      return;
    }
    const next = nextShippingTab(activeTab, event.key);
    event.preventDefault();
    onTabChange(next);
    document.getElementById(`cd-shipping-tab-${next}`)?.focus();
  };

  return (
    <div
      className="cd-shipping-tabs"
      role="tablist"
      aria-label="Shipping sections"
    >
      {SHIPPING_TABS.map((tab) => (
        <button
          className="cd-shipping-tab"
          id={`cd-shipping-tab-${tab}`}
          key={tab}
          type="button"
          role="tab"
          aria-selected={activeTab === tab}
          aria-controls={`cd-shipping-panel-${tab}`}
          tabIndex={activeTab === tab ? 0 : -1}
          onClick={() => onTabChange(tab)}
          onKeyDown={onKeyDown}
        >
          {SHIPPING_TAB_LABELS[tab]}
        </button>
      ))}
    </div>
  );
}

function ShippingMetricDock({ summary }: { summary: ShippingSummary }) {
  const q = summary.quotes30d;
  const metrics = [
    {
      label: "Quotes issued · 30d",
      value: String(q.count),
      detail: "locked quotes across all surfaces",
    },
    {
      label: "Avg shipping quote",
      value: q.avgShippingCents != null ? money(q.avgShippingCents) : "—",
      detail: "per quote, last 30 days",
    },
    {
      label: "Fallback rate used",
      value: q.fallbackSharePct != null ? `${q.fallbackSharePct}%` : "—",
      detail: "share of quotes on the static card",
    },
    {
      label: "Delivery promise",
      value: q.avgPromise ?? "—",
      detail: "average quoted window",
    },
  ];

  return (
    <dl
      className="cd-shipping-metric-dock"
      aria-label="Shipping health metrics"
    >
      {metrics.map((metric) => (
        <div className="cd-shipping-metric" key={metric.label}>
          <dt className="cd-shipping-metric-label">{metric.label}</dt>
          <dd className="cd-shipping-metric-value tabular-nums">
            {metric.value}
          </dd>
          <dd className="cd-shipping-metric-detail">{metric.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

function ShippingMapSkeleton() {
  return (
    <div
      className="cd-shipping-map-skeleton"
      role="status"
      aria-label="Loading customer shipping routes"
    >
      <span className="cd-shipping-skeleton-route" aria-hidden="true" />
      <span className="cd-shipping-skeleton-route" aria-hidden="true" />
      <span className="cd-shipping-skeleton-route" aria-hidden="true" />
    </div>
  );
}

function ShippingLoadingOverview() {
  return (
    <section
      className="cd-shipping-overview"
      aria-labelledby="cd-shipping-loading-title"
      aria-busy="true"
    >
      <div className="cd-shipping-map-heading">
        <div>
          <h2 className="cd-h2" id="cd-shipping-loading-title">
            Daily shipping health
          </h2>
          <p className="cd-caption">
            Loading shipping configuration and customer routes.
          </p>
        </div>
      </div>
      <div className="cd-shipping-map-stage">
        <ShippingMapSkeleton />
        <div
          className="cd-shipping-metric-dock cd-shipping-metric-dock-loading"
          aria-hidden="true"
        >
          {[0, 1, 2, 3].map((index) => (
            <div className="cd-shipping-metric" key={index}>
              <span className="cd-shipping-metric-skeleton-label" />
              <span className="cd-shipping-metric-skeleton-value" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ShippingOverview({
  summary,
  dark,
  onOpenSetup,
}: {
  summary: ShippingSummary;
  dark: boolean;
  onOpenSetup: () => void;
}) {
  return (
    <section
      className="cd-shipping-overview"
      aria-labelledby="cd-shipping-map-title"
    >
      <div className="cd-shipping-map-heading">
        <div>
          <h2 className="cd-h2" id="cd-shipping-map-title">
            Daily shipping health
          </h2>
          <p className="cd-caption">
            Customer destinations from the last 30 days. Routes are simulated,
            not carrier tracking.
          </p>
        </div>
        <span
          className="cd-shipping-health"
          data-healthy={summary.carrierService?.active === true}
        >
          <span className="cd-shipping-health-dot" aria-hidden="true" />
          {summary.carrierService?.active
            ? "Carrier service healthy"
            : summary.carrierService
              ? "Carrier service inactive"
              : "Carrier service not registered"}
        </span>
      </div>

      <div className="cd-shipping-map-stage">
        <Suspense fallback={<ShippingMapSkeleton />}>
          <ShippingRouteMap
            routes={summary.routes30d}
            dark={dark}
            onOpenSetup={onOpenSetup}
          />
        </Suspense>
        <ShippingMetricDock summary={summary} />
      </div>
      <p className="cd-shipping-map-credit">
        Basemap attribution is available in the map control · City coordinates:{" "}
        <a
          href="https://github.com/JetSetExpert/cities-json"
          target="_blank"
          rel="noreferrer"
        >
          world-cities-json
        </a>{" "}
        (CC BY 4.0)
      </p>
    </section>
  );
}

function ShippingRates({ summary }: { summary: ShippingSummary }) {
  return (
    <Card className="cd-shipping-rate-card" pad={false}>
      <div className="cd-shipping-rate-head">
        <h2 className="cd-h2">Rate card</h2>
        <p className="cd-caption">
          Live fallback rates the quote engine uses when carrier rates are
          unavailable. Shown for a sample 500 g package; rates step up by
          package weight.
        </p>
      </div>
      {summary.rateCard.length === 0 ? (
        <Placeholder
          icon="truck"
          title="No rate card"
          sub="The quote engine returned no fallback rates."
        />
      ) : (
        <div className="cd-shipping-rate-table">
          <div
            className="cd-shipping-rate-row cd-shipping-rate-row-head"
            style={{ gridTemplateColumns: RATE_GRID }}
          >
            <span>Carrier · service</span>
            <span>Rate</span>
            <span>On-time</span>
            <span>Delivery promise</span>
          </div>
          {summary.rateCard.map((rate) => (
            <div
              key={`${rate.carrier}-${rate.service}`}
              className="cd-shipping-rate-row"
              style={{ gridTemplateColumns: RATE_GRID }}
            >
              <div className="cd-shipping-rate-service">
                <div className="cd-row-title">{rate.carrier}</div>
                <div className="cd-caption">{rate.service}</div>
              </div>
              <div className="cd-row-num tabular-nums">
                {money(rate.amountCents)}
              </div>
              <div className="cd-caption" title="Scorecard coming soon">
                —
              </div>
              <div className="cd-caption">{rate.estDays}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ShippingSetup({
  summary,
  onReviewProducts,
}: {
  summary: ShippingSummary;
  onReviewProducts: () => void;
}) {
  return (
    <div className="cd-shipping-setup">
      <div className="cd-shipping-setup-grid">
        <Card>
          <h2 className="cd-h2">Ship-from origin</h2>
          {summary.origin ? (
            <>
              <div className="cd-shipping-address">
                <AddressRow label="Street" value={summary.origin.street1} />
                <AddressRow label="City" value={summary.origin.city} />
                <AddressRow label="State" value={summary.origin.state} />
                <AddressRow label="ZIP" value={summary.origin.zip} />
                <AddressRow label="Country" value={summary.origin.country} />
              </div>
              <p className="cd-caption cd-shipping-setup-note">
                {summary.origin.source === "merchant"
                  ? "Set by you."
                  : "Synced from Shopify."}
              </p>
            </>
          ) : (
            <Placeholder
              icon="truck"
              title="No origin set"
              sub="Run the Shopify import or set a ship-from address during onboarding."
            />
          )}
        </Card>

        <Card>
          <h2 className="cd-h2">Carrier service</h2>
          {summary.carrierService ? (
            <>
              <div className="cd-shipping-carrier-state">
                <Pill
                  tone={summary.carrierService.active ? "success" : "neutral"}
                >
                  {summary.carrierService.active ? "Active" : "Inactive"}
                </Pill>
              </div>
              <p className="cd-caption cd-shipping-setup-note">
                {summary.carrierService.active
                  ? "Quoting live checkout rates through Shopify."
                  : "Registered but not currently active."}
              </p>
            </>
          ) : (
            <Placeholder
              icon="globe"
              title="Not registered"
              sub="The Shopify CarrierService wires quotes into checkout during dual-run."
            />
          )}
        </Card>
      </div>

      <Card>
        <div className="cd-shipping-coverage">
          <div>
            <h2 className="cd-h2">Product ship data coverage</h2>
            <div className="cd-shipping-coverage-stats">
              <CoverageStat
                value={`${summary.coverage.withShipData} / ${summary.coverage.variantsTotal}`}
                label="variants with ship data"
              />
              <CoverageStat
                value={String(summary.coverage.missingDims)}
                label="missing dimensions"
              />
              <CoverageStat
                value={String(summary.coverage.restricted)}
                label="with country restrictions"
              />
            </div>
          </div>
          <Btn onClick={onReviewProducts}>Review products</Btn>
        </div>
      </Card>
    </div>
  );
}

export function ShippingView({
  page,
  loading,
  activeTab = "overview",
  onTabChange,
  onReviewProducts,
  dark,
}: {
  page: ShippingSummary | null;
  loading: boolean;
  activeTab?: ShippingTab;
  onTabChange: (tab: ShippingTab) => void;
  onReviewProducts: () => void;
  dark: boolean;
}) {
  return (
    <div className="cd-screen cd-screen--wide cd-shipping-screen">
      <header
        className="cd-screen-head cd-shipping-head"
        data-screen-label="Shipping"
      >
        <div>
          <h1 className="cd-h1">Shipping</h1>
        </div>
        <span className="cd-soon">Carrier scorecard soon</span>
      </header>

      <ShippingTabs activeTab={activeTab} onTabChange={onTabChange} />

      <div
        className="cd-shipping-panel"
        id={`cd-shipping-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`cd-shipping-tab-${activeTab}`}
        tabIndex={0}
      >
        {!page || !page.quotes30d ? (
          loading ? (
            <ShippingLoadingOverview />
          ) : (
            <Card>
              <Placeholder
                icon="truck"
                title="Shipping unavailable"
                sub="Could not load shipping just now. Refresh to try again."
              />
            </Card>
          )
        ) : activeTab === "overview" ? (
          <ShippingOverview
            summary={page}
            dark={dark}
            onOpenSetup={() => onTabChange("setup")}
          />
        ) : activeTab === "rates" ? (
          <ShippingRates summary={page} />
        ) : (
          <ShippingSetup summary={page} onReviewProducts={onReviewProducts} />
        )}
      </div>
    </div>
  );
}

export default function Shipping({ app }: { app: DashboardCtx }) {
  // Seeded from the session cache so a return visit paints instantly; the
  // mount fetch below revalidates and writes back through.
  const [page, setPage] = useState<ShippingSummary | null>(() =>
    cachedScreenData<ShippingSummary>(SCREEN_CACHE_KEYS.shipping),
  );
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<ShippingTab>("overview");
  const toast = app.toast;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchShippingSummary()
      .then((nextPage) => {
        cacheScreenData(SCREEN_CACHE_KEYS.shipping, nextPage);
        if (alive) setPage(nextPage);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const msg =
          err instanceof DashboardApiError
            ? err.message
            : "Could not load shipping.";
        toast(msg, "warn", "critical");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [toast]);

  return (
    <ShippingView
      page={page}
      loading={loading}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onReviewProducts={() => app.navigate("catalog")}
      dark={app.t.dark === true}
    />
  );
}
