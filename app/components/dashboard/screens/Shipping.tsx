import { useEffect, useState } from "react";
import { Btn, Card, Pill, Placeholder } from "../ui";
import { money } from "../format";
import { DashboardApiError } from "~/lib/dashboard/client";
import { fetchShippingSummary, type ShippingSummary } from "~/lib/dashboard/shipping-client";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import type { DashboardCtx } from "../context";

const RATE_GRID = "1.4fr 1fr 1fr 1fr";

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

export default function Shipping({ app }: { app: DashboardCtx }) {
  // Seeded from the session cache so a return visit paints instantly; the
  // mount fetch below revalidates and writes back through.
  const [page, setPage] = useState<ShippingSummary | null>(() =>
    cachedScreenData<ShippingSummary>(SCREEN_CACHE_KEYS.shipping),
  );
  const [loading, setLoading] = useState(true);
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
              <span className="cd-caption">locked quotes across all surfaces</span>
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
              <span className="cd-caption">share of quotes on the static card</span>
            </Card>
            <Card className="cd-stat">
              <span className="cd-stat-label">Delivery promise</span>
              <span className="cd-stat-value tabular-nums">{q.avgPromise ?? "—"}</span>
              <span className="cd-caption">average quoted window</span>
            </Card>
          </div>

          <Card pad={false}>
            <div className="cd-pad-x cd-pad-t">
              <h2 className="cd-h2">Rate card</h2>
              <p className="cd-caption" style={{ marginTop: 4 }}>
                Live fallback rates the quote engine uses when carrier rates are unavailable.
                Shown for a sample 500 g package; rates step up by package weight.
              </p>
            </div>
            {page.rateCard.length === 0 ? (
              <Placeholder
                icon="truck"
                title="No rate card"
                sub="The quote engine returned no fallback rates."
              />
            ) : (
              <>
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
                    <div className="cd-row-num tabular-nums">{money(r.amountCents)}</div>
                    <div className="cd-caption" title="Scorecard coming soon">
                      —
                    </div>
                    <div className="cd-caption">{r.estDays}</div>
                  </div>
                ))}
              </>
            )}
          </Card>

          <div className="cd-grid-duo">
            <Card>
              <h2 className="cd-h2">Ship-from origin</h2>
              {page.origin ? (
                <>
                  <div style={{ marginTop: 8 }}>
                    <AddressRow label="Street" value={page.origin.street1} />
                    <AddressRow label="City" value={page.origin.city} />
                    <AddressRow label="State" value={page.origin.state} />
                    <AddressRow label="ZIP" value={page.origin.zip} />
                    <AddressRow label="Country" value={page.origin.country} />
                  </div>
                  <p className="cd-caption" style={{ marginTop: 10 }}>
                    {page.origin.source === "merchant"
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
                <div className="flex gap-8" style={{ marginTop: 10 }}>
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
