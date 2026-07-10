import { useEffect, useState } from "react";
import type { FormEvent } from "react";
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
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import { COUNTRIES } from "~/lib/storefront/countries";
import type { DashboardCtx } from "../context";

const RATE_GRID = "1.4fr 1fr 1fr 1fr";
const FLAT_GRID = "1.2fr 1fr 0.9fr 0.9fr 0.9fr auto";

const SOURCE_COPY: Record<RateSourceKindView, { pill: string; tone: "success" | "neutral" | "warn"; sub: string }> = {
  carrier: {
    pill: "Live carrier rates",
    tone: "success",
    sub: "Buyers pay live carrier prices from your connected carrier. The table below is the backup card used if the carrier is unreachable.",
  },
  flat: {
    pill: "Your flat rates",
    tone: "success",
    sub: "Buyers pay the flat rates you set below. Connect a carrier in Settings → Connections to switch to live rates.",
  },
  default: {
    pill: "Default rates",
    tone: "warn",
    sub: "You haven't set shipping rates yet, so buyers pay these sensible defaults. Add your own flat rates below, or connect a carrier for live prices.",
  },
};

/** Labeled address line; skips empty values instead of rendering blank rows. */
function AddressRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-3" style={{ padding: "5px 0" }}>
      <span className="cd-caption">{label}</span>
      <span style={{ fontSize: "13.5px", fontWeight: 550, textAlign: "right" }}>{value}</span>
    </div>
  );
}

function CoverageStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col" style={{ minWidth: 120 }}>
      <span className="cd-stat-value tabular-nums">{value}</span>
      <span className="cd-caption">{label}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
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

function RulesCard({ rules, api }: { rules: ShipRulesDtoView; api: SaveApi }) {
  const [markup, setMarkup] = useState(rules.markupPct.toString());
  const [handlingFee, setHandlingFee] = useState(dollars(rules.handlingCents));
  const [freeShip, setFreeShip] = useState(dollars(rules.freeShipThresholdCents));
  const [handlingDays, setHandlingDays] = useState(rules.handlingDays.toString());
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
      <p className="cd-caption" style={{ marginTop: 4 }}>
        Applied to every shipping quote, whichever rate source is active.
      </p>
      <form onSubmit={onSubmit}>
        <div
          className="cd-grid"
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: 12 }}
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
              value={handlingDays}
              onChange={(e) => setHandlingDays(e.target.value)}
            />
          </Field>
        </div>
        <p className="cd-caption" style={{ marginTop: 8 }}>
          Leave &ldquo;Free shipping over&rdquo; empty to turn free shipping off. &ldquo;Ships
          within&rdquo; sets the handling time buyers see in delivery estimates; an item&rsquo;s own
          handling time is used when it&rsquo;s longer.
        </p>
        <div
          className="flex items-center justify-between gap-3 flex-wrap"
          style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--cd-border, rgba(0,0,0,0.08))" }}
        >
          <div style={{ minWidth: 0 }}>
            <div className="cd-row-title">Local pickup</div>
            <p className="cd-caption" style={{ marginTop: 2 }}>
              Offer a free &ldquo;Pick up&rdquo; option at checkout, collected at your ship-from
              address. Ready after your &ldquo;Ships within&rdquo; window.
            </p>
          </div>
          <Toggle value={pickup} onChange={setPickup} ariaLabel="Offer local pickup" />
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

function OriginCard({ origin, api }: { origin: ShipOriginDto | null; api: SaveApi }) {
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
        {!editing ? (
          <Btn onClick={() => setEditing(true)}>Edit</Btn>
        ) : null}
      </div>
      {!editing && origin ? (
        <>
          <div style={{ marginTop: 8 }}>
            <AddressRow label="Street" value={origin.street1} />
            <AddressRow label="Unit / suite" value={origin.street2} />
            <AddressRow label="City" value={origin.city} />
            <AddressRow label="State" value={origin.state} />
            <AddressRow label="ZIP" value={origin.zip} />
            <AddressRow label="Country" value={origin.country} />
          </div>
          <p className="cd-caption" style={{ marginTop: 10 }}>
            {origin.source === "merchant" ? "Set by you." : "Synced from your Shopify import."}
          </p>
        </>
      ) : (
        <form onSubmit={onSubmit} style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          <p className="cd-caption">
            Rates and delivery estimates are quoted from this address.
          </p>
          <Field label="Street address">
            <input className="cd-input" value={street1} onChange={(e) => setStreet1(e.target.value)} required />
          </Field>
          <Field label="Unit / suite (optional)">
            <input className="cd-input" value={street2} onChange={(e) => setStreet2(e.target.value)} />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="City">
              <input className="cd-input" value={city} onChange={(e) => setCity(e.target.value)} required />
            </Field>
            <Field label="State / region">
              <input className="cd-input" value={state} onChange={(e) => setState(e.target.value)} required />
            </Field>
            <Field label="Postal code">
              <input className="cd-input" value={zip} onChange={(e) => setZip(e.target.value)} required />
            </Field>
            <Field label="Country">
              <select className="cd-input" value={country} onChange={(e) => setCountry(e.target.value)}>
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
            {origin ? <Btn onClick={() => setEditing(false)}>Cancel</Btn> : null}
          </div>
        </form>
      )}
    </Card>
  );
}

const EMPTY_FLAT_FORM = { label: "", zone: "all", maxLb: "", amount: "", estDays: "" };

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
          {kind === "flat" ? <Pill tone="success">Active at checkout</Pill> : null}
        </div>
        <p className="cd-caption" style={{ marginTop: 4 }}>
          {kind === "carrier"
            ? "Used only if you disconnect your carrier — live carrier rates are active now."
            : "What buyers pay at checkout. Rows with the same name form weight tiers (the tightest fitting tier prices the order)."}
        </p>
      </div>
      {rates.length > 0 ? (
        <Pan min={620}>
          <div className="cd-tablehd" style={{ gridTemplateColumns: FLAT_GRID }}>
            <span>Name</span>
            <span>Ships to</span>
            <span>Up to (lb)</span>
            <span>Price</span>
            <span>Transit</span>
            <span />
          </div>
          {rates.map((r) => (
            <div key={r.id} className="cd-trow" style={{ gridTemplateColumns: FLAT_GRID }}>
              <div className="cd-row-title">{r.label}</div>
              <div className="cd-caption">{zoneLabel[r.zone]}</div>
              <div className="cd-row-num tabular-nums">{r.maxWeightOz == null ? "Any" : ozToLb(r.maxWeightOz)}</div>
              <div className="cd-row-num tabular-nums">{r.amountCents === 0 ? "Free" : money(r.amountCents)}</div>
              <div className="cd-caption">
                {r.estTransitDays == null ? "—" : `${r.estTransitDays} days`}
              </div>
              <div className="flex gap-2 justify-end">
                <Btn onClick={() => startEdit(r)}>Edit</Btn>
                <Btn
                  onClick={() => void api.submit({ intent: "delete_flat_rate", id: r.id }, "Flat rate removed.")}
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
            style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}
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
  const [saving, setSaving] = useState(false);
  const toast = app.toast;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchShippingSummary()
      .then((p) => {
        cacheScreenData(SCREEN_CACHE_KEYS.shipping, p);
        if (alive) setPage(p);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const msg = err instanceof DashboardApiError ? err.message : "Could not load shipping.";
        toast(msg, "warn", "critical");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [toast]);

  async function submit(body: Record<string, unknown>, okMsg: string): Promise<boolean> {
    setSaving(true);
    try {
      const refreshed = await postShippingSettings(body);
      cacheScreenData(SCREEN_CACHE_KEYS.shipping, refreshed);
      setPage(refreshed);
      toast(okMsg, "check");
      return true;
    } catch (err) {
      const msg = err instanceof DashboardApiError ? err.message : "Could not save shipping settings.";
      toast(msg, "warn", "critical");
      return false;
    } finally {
      setSaving(false);
    }
  }

  const api: SaveApi = { saving, submit };
  const q = page?.quotes30d;

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Shipping">
        <div>
          <h1 className="cd-h1">Shipping</h1>
        </div>
        <span className="cd-soon">Carrier scorecard soon</span>
      </header>

      {!page || !q ? (
        <Card>
          <Placeholder
            icon="truck"
            title={loading ? "Loading shipping" : "Shipping unavailable"}
            sub={
              loading
                ? "Reading your quote engine configuration and activity."
                : "Could not load shipping just now. Refresh to try again."
            }
          />
        </Card>
      ) : (
        <>
          <div className="cd-stat-grid">
            <Card className="cd-stat">
              <span className="cd-stat-label">Quotes issued · 30d</span>
              <span className="cd-stat-value tabular-nums">{q.count}</span>
              <span className="cd-caption">checkout, chat and agent quotes</span>
            </Card>
            <Card className="cd-stat">
              <span className="cd-stat-label">Avg shipping quote</span>
              <span className="cd-stat-value tabular-nums">
                {q.avgShippingCents != null ? money(q.avgShippingCents) : "—"}
              </span>
              <span className="cd-caption">per quote, last 30 days</span>
            </Card>
            <Card className="cd-stat">
              <span className="cd-stat-label">Fallback rate used</span>
              <span className="cd-stat-value tabular-nums">
                {q.fallbackSharePct != null ? `${q.fallbackSharePct}%` : "—"}
              </span>
              <span className="cd-caption">share of quotes on the backup card</span>
            </Card>
            <Card className="cd-stat">
              <span className="cd-stat-label">Estimated weights</span>
              <span className="cd-stat-value tabular-nums">
                {q.lowConfidenceSharePct != null ? `${q.lowConfidenceSharePct}%` : "—"}
              </span>
              <span className="cd-caption">quotes missing product dimensions</span>
            </Card>
            <Card className="cd-stat">
              <span className="cd-stat-label">Delivery promise</span>
              <span className="cd-stat-value tabular-nums">{q.avgPromise ?? "—"}</span>
              <span className="cd-caption">average quoted window</span>
            </Card>
          </div>

          {/* Keyed on the server truth: a revalidation (or another card's save) that
              changes the stored values remounts the form so it never shows — and
              silently re-saves — stale cached values. */}
          <RulesCard key={JSON.stringify(page.rules)} rules={page.rules} api={api} />

          <Card pad={false}>
            <div className="cd-pad-x cd-pad-t">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <h2 className="cd-h2">Rate card</h2>
                <Pill tone={SOURCE_COPY[page.rateSourceKind].tone}>
                  {SOURCE_COPY[page.rateSourceKind].pill}
                </Pill>
              </div>
              <p className="cd-caption" style={{ marginTop: 4 }}>
                {SOURCE_COPY[page.rateSourceKind].sub}{" "}
                Shown for a sample 500 g package; rates step up by package weight.
              </p>
            </div>
            {page.rateCard.length === 0 ? (
              <Placeholder
                icon="truck"
                title="No rate card"
                sub="The quote engine returned no rates."
              />
            ) : (
              <Pan min={480}>
                <div className="cd-tablehd" style={{ gridTemplateColumns: RATE_GRID }}>
                  <span>Carrier · service</span>
                  <span>Rate</span>
                  <span>On-time</span>
                  <span>Delivery promise</span>
                </div>
                {page.rateCard.map((r) => (
                  <div
                    key={`${r.carrier}-${r.service}`}
                    className="cd-trow"
                    style={{ gridTemplateColumns: RATE_GRID }}
                  >
                    <div>
                      <div className="cd-row-title">{r.carrier}</div>
                      <div className="cd-caption">{r.service}</div>
                    </div>
                    <div className="cd-row-num tabular-nums">
                      {r.amountCents === 0 ? "Free" : money(r.amountCents)}
                    </div>
                    <div className="cd-caption" title="Scorecard coming soon">
                      —
                    </div>
                    <div className="cd-caption">{r.estDays}</div>
                  </div>
                ))}
              </Pan>
            )}
          </Card>

          <FlatRatesCard rates={page.flatRates} kind={page.rateSourceKind} api={api} />

          <div className="cd-grid-duo">
            <OriginCard key={JSON.stringify(page.origin)} origin={page.origin} api={api} />

            <Card>
              <h2 className="cd-h2">Carrier service</h2>
              {page.carrierService ? (
                <>
                  <div style={{ marginTop: 10 }}>
                    <Pill tone={page.carrierService.active ? "success" : "neutral"}>
                      {page.carrierService.active ? "Active" : "Inactive"}
                    </Pill>
                  </div>
                  <p className="cd-caption" style={{ marginTop: 10 }}>
                    {page.carrierService.active
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
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h2 className="cd-h2">Product ship data coverage</h2>
                <div className="flex gap-8" style={{ marginTop: 10, flexWrap: "wrap", rowGap: 12 }}>
                  <CoverageStat
                    value={`${page.coverage.withShipData} / ${page.coverage.variantsTotal}`}
                    label="variants with ship data"
                  />
                  <CoverageStat
                    value={String(page.coverage.missingDims)}
                    label="missing dimensions"
                  />
                  <CoverageStat
                    value={String(page.coverage.restricted)}
                    label="with country restrictions"
                  />
                </div>
              </div>
              <Btn onClick={() => app.navigate("catalog")}>Review products</Btn>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
