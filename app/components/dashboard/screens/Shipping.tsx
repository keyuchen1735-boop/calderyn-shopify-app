import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Btn, Card, Pan, Pill, Placeholder, Toggle } from "../ui";
import { money } from "../format";
import { DashboardApiError } from "~/lib/dashboard/client";
import {
  fetchShippingSummary,
  postShippingSettings,
  type FlatRateRowView,
  type RateSourceKindView,
  type ShipOriginDto,
  type ShippingSummary,
  type ShipRulesDtoView,
} from "~/lib/dashboard/shipping-client";
import {
  cacheScreenData,
  cachedScreenData,
  SCREEN_CACHE_KEYS,
} from "~/lib/dashboard/screen-cache";
import { COUNTRIES } from "~/lib/storefront/countries";
import type { DashboardCtx } from "../context";

// Own chunk: keeps maplibre-gl out of the main dashboard bundle.
const ShippingRouteMap = lazy(() => import("../ShippingRouteMap"));

const SHIPPING_TABS = ["overview", "rates", "setup"] as const;
const RATE_GRID = "1.4fr 1fr 1fr 1fr";
const FLAT_GRID = "1.2fr 1fr 0.9fr 0.9fr 0.9fr auto";

const SOURCE_COPY: Record<
  RateSourceKindView,
  { pill: string; tone: "success" | "neutral" | "warn" }
> = {
  carrier: {
    pill: "Live carrier rates",
    tone: "success",
  },
  flat: {
    pill: "Your flat rates",
    tone: "success",
  },
  default: {
    pill: "Default rates",
    tone: "warn",
  },
};

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
      label: "Estimated weights",
      value:
        q.lowConfidenceSharePct != null ? `${q.lowConfidenceSharePct}%` : "—",
      detail: "quotes missing product dimensions",
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
          {[0, 1, 2, 3, 4].map((index) => (
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

function ShippingRates({
  summary,
  api = READ_ONLY_API,
}: {
  summary: ShippingSummary;
  api?: SaveApi;
}) {
  const rules = summary.rules ?? DEFAULT_RULES;
  const flatRates = summary.flatRates ?? [];
  const rateSourceKind = summary.rateSourceKind ?? "default";

  return (
    <div className="cd-shipping-setup cd-shipping-rates">
      <RulesCard key={JSON.stringify(rules)} rules={rules} api={api} />

      <Card className="cd-shipping-rate-card" pad={false}>
        <div className="cd-shipping-rate-head">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="cd-h2">Rate card</h2>
            <Pill tone={SOURCE_COPY[rateSourceKind].tone}>
              {SOURCE_COPY[rateSourceKind].pill}
            </Pill>
          </div>
        </div>
        {summary.rateCard.length === 0 ? (
          <Placeholder icon="truck" title="No rate card" />
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
                  <div className="cd-shipping-rate-value">{rate.service}</div>
                </div>
                <div className="cd-row-num tabular-nums">
                  {rate.amountCents === 0 ? "Free" : money(rate.amountCents)}
                </div>
                <div className="cd-shipping-rate-value">Coming soon</div>
                <div className="cd-shipping-rate-value">{rate.estDays}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <FlatRatesCard rates={flatRates} kind={rateSourceKind} api={api} />
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="cd-field" style={{ minWidth: 0 }}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Dollars string for a cents value ("" for null) — form-friendly, no currency sign. */
function dollars(cents: number | null): string {
  return cents == null ? "" : (cents / 100).toString();
}

function ozToLb(oz: number | null): string {
  return oz == null ? "" : (Math.round((oz / 16) * 100) / 100).toString();
}

interface SaveApi {
  saving: boolean;
  submit: (body: Record<string, unknown>, okMsg: string) => Promise<boolean>;
}

const DEFAULT_RULES: ShipRulesDtoView = {
  markupPct: 0,
  handlingCents: 0,
  freeShipThresholdCents: null,
  handlingDays: 1,
  pickupEnabled: false,
  pickupNote: null,
};

const READ_ONLY_API: SaveApi = {
  saving: false,
  submit: async () => false,
};

function RulesCard({ rules, api }: { rules: ShipRulesDtoView; api: SaveApi }) {
  const [markup, setMarkup] = useState(rules.markupPct.toString());
  const [handlingFee, setHandlingFee] = useState(dollars(rules.handlingCents));
  const [freeShip, setFreeShip] = useState(
    dollars(rules.freeShipThresholdCents),
  );
  const [handlingDays, setHandlingDays] = useState(
    rules.handlingDays.toString(),
  );
  const [pickup, setPickup] = useState(rules.pickupEnabled);
  const [pickupNote, setPickupNote] = useState(rules.pickupNote ?? "");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void api.submit(
      {
        intent: "set_rules",
        markup_pct: markup === "" ? 0 : markup,
        handling_fee: handlingFee === "" ? 0 : handlingFee,
        free_ship_threshold: freeShip,
        handling_days: handlingDays === "" ? 1 : handlingDays,
        pickup_enabled: pickup,
        pickup_note: pickupNote,
      },
      "Shipping rules saved.",
    );
  }

  return (
    <Card>
      <h2 className="cd-h2">Rates &amp; rules</h2>
      <form onSubmit={onSubmit}>
        <div
          className="cd-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 12,
            marginTop: 12,
          }}
        >
          <Field label="Free shipping over ($)">
            <input
              className="cd-input"
              type="number"
              min={0}
              step="0.01"
              placeholder="Off"
              value={freeShip}
              onChange={(e) => setFreeShip(e.target.value)}
            />
          </Field>
          <Field label="Handling fee ($ per order)">
            <input
              className="cd-input"
              type="number"
              min={0}
              step="0.01"
              placeholder="0.00"
              value={handlingFee}
              onChange={(e) => setHandlingFee(e.target.value)}
            />
          </Field>
          <Field label="Rate markup (%)">
            <input
              className="cd-input"
              type="number"
              min={-100}
              max={1000}
              step="0.1"
              placeholder="0"
              value={markup}
              onChange={(e) => setMarkup(e.target.value)}
            />
          </Field>
          <Field label="Ships within (days)">
            <input
              className="cd-input"
              type="number"
              min={0}
              max={60}
              step={1}
              placeholder="1"
              value={handlingDays}
              onChange={(e) => setHandlingDays(e.target.value)}
            />
          </Field>
        </div>
        <div
          className="flex items-center justify-between gap-3 flex-wrap"
          style={{
            marginTop: 14,
            paddingTop: 12,
            borderTop: "1px solid var(--cd-border, rgba(0,0,0,0.08))",
          }}
        >
          <div className="cd-row-title">Local pickup</div>
          <Toggle
            value={pickup}
            onChange={setPickup}
            ariaLabel="Offer local pickup"
          />
        </div>
        {pickup ? (
          <div style={{ marginTop: 10 }}>
            <Field label="Pickup instructions (optional, shown to buyers)">
              <input
                className="cd-input"
                maxLength={200}
                placeholder="e.g. Mon to Sat, 10am to 6pm, side entrance on 5th Ave"
                value={pickupNote}
                onChange={(e) => setPickupNote(e.target.value)}
              />
            </Field>
          </div>
        ) : null}
        <div style={{ marginTop: 12 }}>
          <Btn kind="primary" type="submit" disabled={api.saving}>
            {api.saving ? "Saving…" : "Save rules"}
          </Btn>
        </div>
      </form>
    </Card>
  );
}

function OriginCard({
  origin,
  api,
}: {
  origin: ShipOriginDto | null;
  api: SaveApi;
}) {
  const [editing, setEditing] = useState(origin == null);
  const [street1, setStreet1] = useState(origin?.street1 ?? "");
  const [street2, setStreet2] = useState(origin?.street2 ?? "");
  const [city, setCity] = useState(origin?.city ?? "");
  const [state, setState] = useState(origin?.state ?? "");
  const [zip, setZip] = useState(origin?.zip ?? "");
  const [country, setCountry] = useState(origin?.country ?? "US");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const ok = await api.submit(
      { intent: "set_origin", street1, street2, city, state, zip, country },
      "Ship-from address saved.",
    );
    if (ok) setEditing(false);
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <h2 className="cd-h2">Ship-from origin</h2>
        {!editing ? <Btn onClick={() => setEditing(true)}>Edit</Btn> : null}
      </div>
      {!editing && origin ? (
        <>
          <div style={{ marginTop: 8 }}>
            <AddressRow label="Street" value={origin.street1} />
            <AddressRow label="Unit / suite" value={origin.street2 ?? ""} />
            <AddressRow label="City" value={origin.city} />
            <AddressRow label="State" value={origin.state} />
            <AddressRow label="ZIP" value={origin.zip} />
            <AddressRow label="Country" value={origin.country} />
          </div>
          <p className="cd-caption" style={{ marginTop: 10 }}>
            {origin.source === "merchant"
              ? "Set by you."
              : "Synced from your Shopify import."}
          </p>
        </>
      ) : (
        <form
          onSubmit={onSubmit}
          style={{
            marginTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <p className="cd-caption">
            Rates and delivery estimates are quoted from this address.
          </p>
          <Field label="Street address">
            <input
              className="cd-input"
              value={street1}
              onChange={(e) => setStreet1(e.target.value)}
              required
            />
          </Field>
          <Field label="Unit / suite (optional)">
            <input
              className="cd-input"
              value={street2}
              onChange={(e) => setStreet2(e.target.value)}
            />
          </Field>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}
          >
            <Field label="City">
              <input
                className="cd-input"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                required
              />
            </Field>
            <Field label="State / region">
              <input
                className="cd-input"
                value={state}
                onChange={(e) => setState(e.target.value)}
                required
              />
            </Field>
            <Field label="Postal code">
              <input
                className="cd-input"
                value={zip}
                onChange={(e) => setZip(e.target.value)}
                required
              />
            </Field>
            <Field label="Country">
              <select
                className="cd-input"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
              >
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="flex gap-2">
            <Btn kind="primary" type="submit" disabled={api.saving}>
              {api.saving ? "Saving…" : "Save address"}
            </Btn>
            {origin ? (
              <Btn onClick={() => setEditing(false)}>Cancel</Btn>
            ) : null}
          </div>
        </form>
      )}
    </Card>
  );
}

function ShippingSetup({
  summary,
  onReviewProducts,
  api = READ_ONLY_API,
}: {
  summary: ShippingSummary;
  onReviewProducts: () => void;
  api?: SaveApi;
}) {
  return (
    <div className="cd-shipping-setup">
      <div className="cd-shipping-setup-grid">
        <OriginCard
          key={JSON.stringify(summary.origin)}
          origin={summary.origin}
          api={api}
        />

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
  api = READ_ONLY_API,
}: {
  page: ShippingSummary | null;
  loading: boolean;
  activeTab?: ShippingTab;
  onTabChange: (tab: ShippingTab) => void;
  onReviewProducts: () => void;
  dark: boolean;
  api?: SaveApi;
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
          <ShippingRates summary={page} api={api} />
        ) : (
          <ShippingSetup
            summary={page}
            onReviewProducts={onReviewProducts}
            api={api}
          />
        )}
      </div>
    </div>
  );
}

const EMPTY_FLAT_FORM = {
  label: "",
  zone: "all",
  maxLb: "",
  amount: "",
  estDays: "",
};

function FlatRatesCard({
  rates,
  kind,
  api,
}: {
  rates: FlatRateRowView[];
  kind: RateSourceKindView;
  api: SaveApi;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FLAT_FORM);

  function startEdit(r: FlatRateRowView) {
    setEditingId(r.id);
    setForm({
      label: r.label,
      zone: r.zone,
      maxLb: ozToLb(r.maxWeightOz),
      amount: dollars(r.amountCents) || "0",
      estDays: r.estTransitDays == null ? "" : r.estTransitDays.toString(),
    });
  }

  function reset() {
    setEditingId(null);
    setForm(EMPTY_FLAT_FORM);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const ok = await api.submit(
      {
        intent: editingId ? "update_flat_rate" : "add_flat_rate",
        id: editingId ?? undefined,
        label: form.label,
        zone: form.zone,
        max_weight_lb: form.maxLb,
        amount: form.amount,
        est_days: form.estDays,
      },
      editingId ? "Flat rate updated." : "Flat rate added.",
    );
    if (ok) reset();
  }

  const zoneLabel: Record<FlatRateRowView["zone"], string> = {
    all: "Everywhere",
    domestic: "Domestic",
    international: "International",
  };

  return (
    <Card pad={false}>
      <div className="cd-pad-x cd-pad-t">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="cd-h2">Flat rates</h2>
          {kind === "flat" ? (
            <Pill tone="success">Active at checkout</Pill>
          ) : null}
        </div>
      </div>
      {rates.length > 0 ? (
        <Pan min={620}>
          <div
            className="cd-tablehd"
            style={{ gridTemplateColumns: FLAT_GRID }}
          >
            <span>Name</span>
            <span>Ships to</span>
            <span>Up to (lb)</span>
            <span>Price</span>
            <span>Transit</span>
            <span />
          </div>
          {rates.map((r) => (
            <div
              key={r.id}
              className="cd-trow"
              style={{ gridTemplateColumns: FLAT_GRID }}
            >
              <div className="cd-row-title">{r.label}</div>
              <div className="cd-shipping-rate-value">{zoneLabel[r.zone]}</div>
              <div className="cd-row-num tabular-nums">
                {r.maxWeightOz == null ? "Any" : ozToLb(r.maxWeightOz)}
              </div>
              <div className="cd-row-num tabular-nums">
                {r.amountCents === 0 ? "Free" : money(r.amountCents)}
              </div>
              <div className="cd-shipping-rate-value">
                {r.estTransitDays == null ? "—" : `${r.estTransitDays} days`}
              </div>
              <div className="flex gap-2 justify-end">
                <Btn onClick={() => startEdit(r)}>Edit</Btn>
                <Btn
                  onClick={() =>
                    void api.submit(
                      { intent: "delete_flat_rate", id: r.id },
                      "Flat rate removed.",
                    )
                  }
                  disabled={api.saving}
                >
                  Delete
                </Btn>
              </div>
            </div>
          ))}
        </Pan>
      ) : null}
      <div className="cd-pad-x" style={{ paddingTop: 12, paddingBottom: 16 }}>
        <form onSubmit={onSubmit}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
              gap: 10,
            }}
          >
            <Field label="Name">
              <input
                className="cd-input"
                placeholder="Standard"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                required
              />
            </Field>
            <Field label="Ships to">
              <select
                className="cd-input"
                value={form.zone}
                onChange={(e) => setForm({ ...form, zone: e.target.value })}
              >
                <option value="all">Everywhere</option>
                <option value="domestic">Domestic only</option>
                <option value="international">International only</option>
              </select>
            </Field>
            <Field label="Up to (lb, optional)">
              <input
                className="cd-input"
                type="number"
                min={0.01}
                step="0.01"
                placeholder="Any weight"
                value={form.maxLb}
                onChange={(e) => setForm({ ...form, maxLb: e.target.value })}
              />
            </Field>
            <Field label="Price ($)">
              <input
                className="cd-input"
                type="number"
                min={0}
                step="0.01"
                placeholder="0.00"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                required
              />
            </Field>
            <Field label="Transit (days, optional)">
              <input
                className="cd-input"
                type="number"
                min={0}
                max={90}
                step={1}
                placeholder="3"
                value={form.estDays}
                onChange={(e) => setForm({ ...form, estDays: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex gap-2" style={{ marginTop: 12 }}>
            <Btn kind="primary" type="submit" disabled={api.saving}>
              {api.saving ? "Saving…" : editingId ? "Update rate" : "Add rate"}
            </Btn>
            {editingId ? <Btn onClick={reset}>Cancel</Btn> : null}
          </div>
        </form>
      </div>
    </Card>
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
  const [saving, setSaving] = useState(false);
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

  async function submit(
    body: Record<string, unknown>,
    okMsg: string,
  ): Promise<boolean> {
    setSaving(true);
    try {
      const refreshed = await postShippingSettings(body);
      cacheScreenData(SCREEN_CACHE_KEYS.shipping, refreshed);
      setPage(refreshed);
      toast(okMsg, "check");
      return true;
    } catch (err) {
      const msg =
        err instanceof DashboardApiError
          ? err.message
          : "Could not save shipping settings.";
      toast(msg, "warn", "critical");
      return false;
    } finally {
      setSaving(false);
    }
  }

  const api: SaveApi = { saving, submit };
  return (
    <ShippingView
      page={page}
      loading={loading}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onReviewProducts={() => app.navigate("catalog")}
      dark={app.t.dark === true}
      api={api}
    />
  );
}
