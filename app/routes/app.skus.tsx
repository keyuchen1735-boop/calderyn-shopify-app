import { Fragment, useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData , data } from "react-router";
import { useEmbeddedNavigate } from "../lib/embedded-nav";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Modal,
  Page,
  Popover,
  Select,
  Text,
  TextField,
  Tooltip,
  useBreakpoints,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";
import {
  executeInventoryRelocation,
  RelocationError,
} from "~/lib/actions/inventory-relocate.server";
import {
  executeInventoryAlertAction,
  type InventoryAlertActionKind,
} from "~/lib/actions/alert-action.server";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import { useActionToast, type ActionToast } from "~/lib/toast";
import { BrandGlyph } from "~/components/calderyn/brand-icons";
import type { Alert, ShopLocation, SKU, SkuAffinityItem, SkuHistoryPoint } from "~/lib/types";
import { fmtMoney } from "~/lib/format";
import { splitSkuTitle } from "~/lib/sku-title";
import {
  inventoryAlertActions,
  openAlertsBySku,
} from "~/lib/inventory-alerts";
import {
  formatDemandUnits,
  formatStockoutDate,
  projectedStockoutDate,
} from "~/lib/inventory-demand";
import { sparklinePath } from "~/lib/sparkline";

type SortKey =
  | "days_of_cover"
  | "on_hand"
  | "velocity"
  | "revenue_30d_cents"
  | "title";
type SortDir = "asc" | "desc";

type LoaderPayload = {
  skus: SKU[];
  alerts: Alert[];
  locations: ShopLocation[];
  error: { code: string; message: string } | null;
};

export type RelocatePayload = ActionToast & {
  error?: { code: string; message: string };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const [skus, alerts, locations] = await Promise.all([
      client.skus.list(request.signal),
      client.alerts.list({}, request.signal),
      client.locations.list(request.signal),
    ]);
    return data<LoaderPayload>({ skus, alerts, locations, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return data<LoaderPayload>({
      skus: [],
      alerts: [],
      locations: [],
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  // Per-row alert actions share the relocate route; everything that drives
  // the mutation is re-derived server-side from the shop-scoped alert.
  if (String(formData.get("intent") ?? "") === "alert_action") {
    return alertAction(formData, session.shop, admin, request.signal);
  }

  // Boundary validation — never trust the modal's FormData (repo rule).
  const skuId = String(formData.get("sku_id") ?? "").trim();
  const fromLocationId = String(formData.get("from_location_id") ?? "").trim();
  const toLocationId = String(formData.get("to_location_id") ?? "").trim();
  const qtyRaw = String(formData.get("quantity") ?? "").trim();
  const idempotencyKey = String(formData.get("idempotency_key") ?? "").trim();

  if (
    !skuId ||
    !fromLocationId ||
    !toLocationId ||
    !idempotencyKey ||
    !/^\d+$/.test(qtyRaw) ||
    Number(qtyRaw) <= 0
  ) {
    return data<RelocatePayload>(
      {
        ok: false,
        error: { code: "INVALID_INPUT", message: "Quantity must be a positive whole number." },
        toast: { message: "Quantity must be a positive whole number.", isError: true },
      },
      { status: 422 },
    );
  }

  try {
    const shopId = await resolveShopId(session.shop);
    const result = await executeInventoryRelocation(
      shopId,
      {
        alertId: null,
        skuId,
        fromLocationId,
        toLocationId,
        quantity: Number(qtyRaw),
        idempotencyKey,
      },
      getSupabase(),
      admin,
    );
    const ok = result.outcome === "succeeded";
    return data<RelocatePayload>({
      ok,
      toast: ok
        ? { message: "Inventory transfer executed — see the audit log" }
        : { message: "Transfer recorded as failed — check the audit log", isError: true },
    });
  } catch (err) {
    if (err instanceof RelocationError) {
      return data<RelocatePayload>(
        {
          ok: false,
          error: { code: err.code, message: err.message },
          toast: { message: err.message, isError: true },
        },
        { status: 422 },
      );
    }
    const message = err instanceof Error ? err.message : "Inventory transfer failed.";
    return data<RelocatePayload>(
      { ok: false, error: { code: "ACTION_FAILED", message }, toast: { message, isError: true } },
      { status: 500 },
    );
  }
};

/** A SKU with no recent sales has no meaningful velocity or days-of-cover
 * (the engine caps cover at 999 in that case). */
const hasSales = (s: SKU) => (s.velocity ?? 0) > 0;

/** The SKU type carries no "overstocked" flag, so derive it the same way the
 * design does: a selling SKU sitting on more than 180 days of cover. */
const isOverstocked = (s: SKU) => hasSales(s) && (s.days_of_cover ?? 0) > 180;

const ALERT_ACTION_KINDS: InventoryAlertActionKind[] = [
  "reallocate_inventory",
  "snooze_alert",
];

async function alertAction(
  formData: FormData,
  shop: string,
  admin: Parameters<typeof executeInventoryAlertAction>[0]["admin"],
  signal: AbortSignal,
) {
  const alertId = String(formData.get("alert_id") ?? "").trim();
  const kind = String(formData.get("kind") ?? "").trim() as InventoryAlertActionKind;
  const idempotencyKey = String(formData.get("idempotency_key") ?? "").trim();
  if (!alertId || !idempotencyKey || !ALERT_ACTION_KINDS.includes(kind)) {
    const message = "Invalid alert action.";
    return data<RelocatePayload>(
      { ok: false, error: { code: "INVALID_INPUT", message }, toast: { message, isError: true } },
      { status: 422 },
    );
  }

  try {
    const shopId = await resolveShopId(shop);
    const { outcome } = await executeInventoryAlertAction({
      client: calderynClient(shop),
      admin,
      sb: getSupabase(),
      shopId,
      alertId,
      kind,
      idempotencyKey,
      signal,
    });
    const ok = outcome === "succeeded";
    return data<RelocatePayload>({
      ok,
      toast: ok
        ? {
            message:
              kind === "snooze_alert"
                ? "Alert snoozed"
                : "Inventory transfer executed — see the audit log",
          }
        : { message: "Action recorded as failed — check the audit log", isError: true },
    });
  } catch (err) {
    if (err instanceof CalderynError) {
      return data<RelocatePayload>(
        {
          ok: false,
          error: { code: err.code, message: err.message },
          toast: { message: err.message, isError: true },
        },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Alert action failed.";
    return data<RelocatePayload>(
      { ok: false, error: { code: "ACTION_FAILED", message }, toast: { message, isError: true } },
      { status: 500 },
    );
  }
}

type Filter = "all" | "flagged" | "over";
const PAGE_SIZE = 8;

export default function SKUs() {
  const navigate = useEmbeddedNavigate();
  const { skus, alerts, locations, error } = useLoaderData<typeof loader>();

  const [sortKey, setSortKey] = useState<SortKey>("on_hand");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [fVendor, setFVendor] = useState("");
  const [fType, setFType] = useState("");
  const [fCollection, setFCollection] = useState("");
  const [fTag, setFTag] = useState("");
  const [page, setPage] = useState(0);
  const [relocating, setRelocating] = useState<SKU | null>(null);
  const { smDown } = useBreakpoints();
  const fetcher = useFetcher<RelocatePayload>();
  useActionToast(fetcher.data);
  useEffect(() => {
    if (fetcher.data?.ok) setRelocating(null);
  }, [fetcher.data]);

  // Alerts reference SKUs by their human sku code (alerts.sku), NOT the
  // sku_dim uuid — joining on s.id matched nothing and left the column empty.
  const alertsBySku = useMemo(() => openAlertsBySku(alerts), [alerts]);

  // KPI rollups across the full catalog (not the filtered/paged view).
  const stats = useMemo(() => {
    let units = 0;
    let flaggedSkus = 0;
    let openAlerts = 0;
    let overstocked = 0;
    const covers: number[] = [];
    for (const s of skus) {
      units += s.on_hand ?? 0;
      const skuAlerts = alertsBySku.get(s.sku) ?? [];
      if (skuAlerts.length > 0) {
        flaggedSkus += 1;
        openAlerts += skuAlerts.length;
      }
      if (isOverstocked(s)) overstocked += 1;
      if (hasSales(s)) covers.push(s.days_of_cover ?? 0);
    }
    let median = 0;
    if (covers.length) {
      const sortedCovers = [...covers].sort((a, b) => a - b);
      const mid = Math.floor(sortedCovers.length / 2);
      median =
        sortedCovers.length % 2
          ? sortedCovers[mid]
          : (sortedCovers[mid - 1] + sortedCovers[mid]) / 2;
    }
    return { units, flaggedSkus, openAlerts, overstocked, median, coverCount: covers.length };
  }, [skus, alertsBySku]);

  // Distinct facet values across the loaded SKUs — drives the slicing dropdowns.
  // A facet with no values renders no filter (acceptance: no dead filters).
  const facets = useMemo(() => {
    const vendors = new Set<string>();
    const types = new Set<string>();
    const collections = new Set<string>();
    const tags = new Set<string>();
    for (const s of skus) {
      if (s.vendor) vendors.add(s.vendor);
      if (s.product_type) types.add(s.product_type);
      for (const c of s.collections ?? []) collections.add(c);
      for (const t of s.tags ?? []) tags.add(t);
    }
    const sortVals = (set: Set<string>) => [...set].sort((a, b) => a.localeCompare(b));
    return {
      vendors: sortVals(vendors),
      types: sortVals(types),
      collections: sortVals(collections),
      tags: sortVals(tags),
    };
  }, [skus]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skus.filter((s) => {
      if (filter === "flagged" && (alertsBySku.get(s.sku) ?? []).length === 0) return false;
      if (filter === "over" && !isOverstocked(s)) return false;
      if (q && !(s.title.toLowerCase().includes(q) || s.sku.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)))
        return false;
      if (fVendor && s.vendor !== fVendor) return false;
      if (fType && s.product_type !== fType) return false;
      if (fCollection && !(s.collections ?? []).includes(fCollection)) return false;
      if (fTag && !(s.tags ?? []).includes(fTag)) return false;
      return true;
    });
  }, [skus, alertsBySku, filter, query, fVendor, fType, fCollection, fTag]);

  const sorted = useMemo(() => {
    const compare = (a: SKU, b: SKU) => {
      if (sortKey === "title") return a.title.localeCompare(b.title);
      return (a[sortKey] ?? 0) - (b[sortKey] ?? 0);
    };
    const arr = [...filtered].sort(compare);
    return sortDir === "asc" ? arr : arr.reverse();
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageIdx = Math.min(Math.max(page, 0), totalPages - 1);
  const start = pageIdx * PAGE_SIZE;
  const paged = sorted.slice(start, start + PAGE_SIZE);
  const rangeText =
    sorted.length === 0
      ? "No SKUs match"
      : `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, sorted.length)} of ${sorted.length} SKUs`;

  const sortBy = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
    setPage(0);
  };
  const sortInd = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "");
  const sortCol = (key: SortKey) => (sortKey === key ? "#173a4d" : "#9a9a9a");

  const anyFacet = Boolean(fVendor || fType || fCollection || fTag);
  const clearFacets = () => {
    setFVendor("");
    setFType("");
    setFCollection("");
    setFTag("");
    setPage(0);
  };
  const hasFacets =
    facets.vendors.length > 0 ||
    facets.types.length > 0 ||
    facets.collections.length > 0 ||
    facets.tags.length > 0;

  const CHIPS: { key: Filter; label: string; dot?: string }[] = [
    { key: "all", label: "All SKUs" },
    { key: "flagged", label: "Needs attention", dot: "#d72c0d" },
    { key: "over", label: "Overstocked", dot: "#d9a400" },
  ];

  return (
    <Page
      fullWidth
      title="Inventory"
      subtitle="Stock health across every SKU, with days of cover and where demand is concentrated."
      titleMetadata={<ShopifySourcePill />}
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" title="Couldn't load SKUs">
            <p>{error.message}</p>
          </Banner>
        )}

        {/* ===== KPI STRIP ===== */}
        <div className="invx-kpis">
          <div className="invx-kpi">
            <div className="invx-kpi-label">Units on hand</div>
            <div className="invx-kpi-value">{stats.units.toLocaleString()}</div>
            <div className="invx-kpi-sub">
              across {skus.length} SKU{skus.length === 1 ? "" : "s"}
            </div>
          </div>
          <div className="invx-kpi" data-accent="red">
            <div className="invx-kpi-label">Needs attention</div>
            <div className="invx-kpi-value">
              {stats.flaggedSkus} SKU{stats.flaggedSkus === 1 ? "" : "s"}
            </div>
            <div className="invx-kpi-sub invx-red">
              {stats.openAlerts} open inventory alert{stats.openAlerts === 1 ? "" : "s"}
            </div>
          </div>
          <div className="invx-kpi" data-accent="amber">
            <div className="invx-kpi-label">Overstocked</div>
            <div className="invx-kpi-value">
              {stats.overstocked} SKU{stats.overstocked === 1 ? "" : "s"}
            </div>
            <div className="invx-kpi-sub invx-amber">over 180 days of cover</div>
          </div>
          <div className="invx-kpi">
            <div className="invx-kpi-label">Median cover</div>
            <div className="invx-kpi-value">
              {stats.coverCount ? `${Math.round(stats.median)} days` : "—"}
            </div>
            <div className="invx-kpi-sub">
              {stats.coverCount ? "across selling SKUs" : "no sales yet"}
            </div>
          </div>
        </div>

        {skus.length === 0 && !error ? (
          <Card>
            <Box padding="600">
              <BlockStack gap="300" inlineAlign="center">
                <Text as="p" variant="headingMd">
                  No SKUs yet
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  They appear here as soon as Shopify syncs your catalog.
                </Text>
              </BlockStack>
            </Box>
          </Card>
        ) : smDown ? (
          <Card padding="0">
            {paged.map((s, i) => (
              <Fragment key={s.id}>
                {i > 0 && <div className="invx-card-divider" />}
                <SkuCard
                  s={s}
                  alerts={alertsBySku.get(s.sku) ?? []}
                  onRelocate={() => setRelocating(s)}
                />
              </Fragment>
            ))}
            <div className="invx-foot">
              <span className="invx-foot-range">{rangeText}</span>
              <Pager pageIdx={pageIdx} totalPages={totalPages} setPage={setPage} />
            </div>
          </Card>
        ) : (
          <Card padding="0">
            {/* toolbar: filter chips + search */}
            <div className="invx-toolbar">
              <div className="invx-chips">
                {CHIPS.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className="invx-chip"
                    data-on={filter === c.key}
                    onClick={() => {
                      setFilter(c.key);
                      setPage(0);
                    }}
                  >
                    {c.dot && <span className="invx-chip-dot" style={{ background: c.dot }} />}
                    {c.label}
                  </button>
                ))}
              </div>
              <div className="invx-search">
                <SearchIcon />
                <input
                  type="search"
                  placeholder="Search by product or SKU"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(0);
                  }}
                  aria-label="Search SKUs"
                />
              </div>
            </div>

            {hasFacets && (
              <div className="invx-facets">
                <FacetSelect label="Vendor" value={fVendor} options={facets.vendors} onChange={(v) => { setFVendor(v); setPage(0); }} />
                <FacetSelect label="Type" value={fType} options={facets.types} onChange={(v) => { setFType(v); setPage(0); }} />
                <FacetSelect label="Collection" value={fCollection} options={facets.collections} onChange={(v) => { setFCollection(v); setPage(0); }} />
                <FacetSelect label="Tag" value={fTag} options={facets.tags} onChange={(v) => { setFTag(v); setPage(0); }} />
                {anyFacet && (
                  <Button variant="plain" onClick={clearFacets}>
                    Clear filters
                  </Button>
                )}
              </div>
            )}

            <div className="invx-scroll">
              <div className="invx-table">
                <div className="invx-head">
                  <button type="button" className="invx-sort" style={{ color: sortCol("title") }} onClick={() => sortBy("title")}>
                    Product{sortInd("title")}
                  </button>
                  <button type="button" className="invx-sort" style={{ color: sortCol("days_of_cover") }} onClick={() => sortBy("days_of_cover")}>
                    Stock &amp; cover{sortInd("days_of_cover")}
                  </button>
                  <button type="button" className="invx-sort invx-r" style={{ color: sortCol("velocity") }} onClick={() => sortBy("velocity")}>
                    Velocity{sortInd("velocity")}
                  </button>
                  <button type="button" className="invx-sort invx-r" style={{ color: sortCol("revenue_30d_cents") }} onClick={() => sortBy("revenue_30d_cents")}>
                    Revenue · 30d{sortInd("revenue_30d_cents")}
                  </button>
                  <span>Where demand is</span>
                  <span className="invx-r">Action</span>
                </div>

                {paged.length === 0 ? (
                  <div className="invx-empty">
                    {query.trim()
                      ? `No SKUs match "${query.trim()}".`
                      : "No SKUs match these filters."}
                  </div>
                ) : (
                  paged.map((s) => {
                    const skuAlerts = alertsBySku.get(s.sku) ?? [];
                    const canRelocate = s.locations_detail.some((l) => l.available > 0);
                    // Variant-first: lead with the variant, product name beneath.
                    // Single-variant SKUs (no variant) keep product + sku code.
                    const { product, variant } = splitSkuTitle(s.title);
                    return (
                      <div key={s.id} className="invx-row">
                        <div className="invx-prod">
                          <div className="invx-prod-title" title={s.title}>
                            {variant ?? product}
                          </div>
                          <div className="invx-prod-sku" title={s.id}>
                            {variant ? product : s.sku}
                          </div>
                        </div>
                        <StockCover s={s} />
                        <span className="invx-vel invx-r">
                          {hasSales(s) ? (
                            <>
                              <span className="cdn-tnum">{(s.velocity ?? 0).toFixed(1)}</span>
                              <span className="invx-muted"> /day</span>
                            </>
                          ) : (
                            <span className="invx-muted">No sales</span>
                          )}
                        </span>
                        <span className="invx-rev invx-r">
                          {s.revenue_30d_cents ? (
                            <span className="cdn-tnum">{fmtMoney(s.revenue_30d_cents)}</span>
                          ) : (
                            <span className="invx-muted">—</span>
                          )}
                        </span>
                        <div className="invx-demand">
                          <DemandLabel demand={s.demand} />
                        </div>
                        <div className="invx-actions">
                          {skuAlerts.length > 0 && <AlertsPill alerts={skuAlerts} />}
                          {canRelocate && (
                            <button
                              type="button"
                              className="invx-relocate"
                              onClick={() => setRelocating(s)}
                            >
                              Relocate
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}

                <div className="invx-foot">
                  <span className="invx-foot-range">{rangeText}</span>
                  <Pager pageIdx={pageIdx} totalPages={totalPages} setPage={setPage} />
                </div>
              </div>
            </div>
          </Card>
        )}
      </BlockStack>

      {relocating && (
        <RelocateModal
          sku={relocating}
          locations={locations}
          fetcher={fetcher}
          onClose={() => setRelocating(null)}
        />
      )}
    </Page>
  );
}

function Pager({
  pageIdx,
  totalPages,
  setPage,
}: {
  pageIdx: number;
  totalPages: number;
  setPage: (fn: (p: number) => number) => void;
}) {
  return (
    <div className="invx-pager">
      <button
        type="button"
        className="invx-page"
        disabled={pageIdx <= 0}
        onClick={() => setPage((p) => Math.max(0, p - 1))}
      >
        ‹ Prev
      </button>
      <span className="invx-page-label">
        Page {pageIdx + 1} of {totalPages}
      </span>
      <button
        type="button"
        className="invx-page"
        disabled={pageIdx >= totalPages - 1}
        onClick={() => setPage((p) => p + 1)}
      >
        Next ›
      </button>
    </div>
  );
}

/** Stock count + a status dot keyed to days-of-cover health, matching the
 * design's coloring (red < 14d, amber > 180d overstocked, green otherwise,
 * grey for no-sales). Low-cover rows also surface the projected sell-out date. */
function StockCover({ s }: { s: SKU }) {
  const selling = hasSales(s);
  const cover = s.days_of_cover ?? 0;
  let dot = "#1a7f4f";
  let coverColor = "#5c8a6f";
  let coverText: string;
  let stockoutLabel: string | null = null;
  if (!selling) {
    dot = "#c4c4c4";
    coverColor = "#9a9a9a";
    coverText = "No sales yet";
  } else if (cover > 180) {
    dot = "#d9a400";
    coverColor = "#9a7400";
    coverText = `${cover.toFixed(0)}d cover · overstocked`;
  } else if (cover < 14) {
    dot = "#d72c0d";
    coverColor = "#b3300f";
    coverText = `${cover.toFixed(1)}d cover · reorder soon`;
    const iso = projectedStockoutDate(cover, s.velocity ?? 0);
    stockoutLabel = iso ? formatStockoutDate(iso) : null;
  } else {
    coverText = `${cover.toFixed(0)}d cover`;
  }
  return (
    <div className="invx-stock">
      <span className="invx-dot" style={{ background: dot }} />
      <div className="invx-stock-body">
        <div className="invx-stock-count">
          <span className="cdn-tnum">{(s.on_hand ?? 0).toLocaleString()}</span> units
        </div>
        <div className="invx-stock-cover" style={{ color: coverColor }}>
          {coverText}
          {stockoutLabel && (
            <Tooltip content={`Projected to sell out around ${stockoutLabel} at the current pace`}>
              <span className="invx-stockout"> · ~{stockoutLabel}</span>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

/** "Where demand is" — region + units sold, mirroring the prior DemandCell
 * (with the same rich tooltip / starved-region critical tone). */
function DemandLabel({ demand }: { demand: SKU["demand"] }) {
  if (!demand) {
    return <span className="invx-muted">No recent sales</span>;
  }
  const starved = demand.stock_in_region === 0;
  return (
    <span
      title={`${demand.units_30d.toLocaleString()} units sold in ${demand.region} over 30 days (${Math.round(demand.share * 100)}% of demand) · ${demand.stock_in_region.toLocaleString()} in stock there`}
    >
      <span className={starved ? "invx-demand-region invx-red" : "invx-demand-region"}>
        {shortLoc(demand.region)}
      </span>
      <span className="invx-muted">
        {" "}
        · <span className="cdn-tnum">{formatDemandUnits(demand.units_30d)}</span> sold / 30d
      </span>
    </span>
  );
}

/** Phone-width render of one SKU row. Same data + relocate entry point as the
 * table, stacked as a card so it doesn't scroll horizontally. */
function SkuCard({
  s,
  alerts,
  onRelocate,
}: {
  s: SKU;
  alerts: Alert[];
  onRelocate: () => void;
}) {
  const canRelocate = s.locations_detail.some((l) => l.available > 0);
  const { product, variant } = splitSkuTitle(s.title);
  return (
    <Box padding="400">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="start" gap="200" wrap={false}>
          <BlockStack gap="050">
            <Text as="span" fontWeight="semibold">
              {variant ?? product}
            </Text>
            <Text as="span" tone="subdued" variant="bodySm">
              {variant ? product : s.sku}
            </Text>
          </BlockStack>
          {alerts.length > 0 && <AlertsPill alerts={alerts} />}
        </InlineStack>
        <StockCover s={s} />
        <InlineStack gap="500" wrap>
          <BlockStack gap="050">
            <Text as="span" variant="bodyXs" tone="subdued">
              Velocity
            </Text>
            <Text as="span" variant="bodySm" fontWeight="semibold" numeric>
              {hasSales(s) ? `${(s.velocity ?? 0).toFixed(1)} /day` : "No sales"}
            </Text>
          </BlockStack>
          <BlockStack gap="050">
            <Text as="span" variant="bodyXs" tone="subdued">
              Revenue · 30d
            </Text>
            <Text as="span" variant="bodySm" fontWeight="semibold" numeric>
              {s.revenue_30d_cents ? fmtMoney(s.revenue_30d_cents) : "—"}
            </Text>
          </BlockStack>
          <BlockStack gap="050">
            <Text as="span" variant="bodyXs" tone="subdued">
              Demand
            </Text>
            <Text as="span" variant="bodySm" fontWeight="semibold">
              {s.demand ? shortLoc(s.demand.region) : "—"}
            </Text>
          </BlockStack>
        </InlineStack>
        {canRelocate && (
          <Box>
            <Button size="slim" onClick={onRelocate}>
              Relocate
            </Button>
          </Box>
        )}
      </BlockStack>
    </Box>
  );
}

/** Per-row open alerts: a pill that opens a popover with each alert's actions,
 * executable without leaving the inventory page. Form-based actions deep-link
 * to the alert detail with its modal pre-opened. */
function AlertsPill({ alerts }: { alerts: Alert[] }) {
  const navigate = useEmbeddedNavigate();
  const fetcher = useFetcher<RelocatePayload>();
  useActionToast(fetcher.data);
  const [open, setOpen] = useState(false);
  // One key per merchant intent: minted per response so a double-click
  // replays, but the NEXT action (possibly a different alert) never collides
  // with a burned key.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const data = fetcher.data;
  useEffect(() => {
    if (data) setIdempotencyKey(crypto.randomUUID());
  }, [data]);

  if (alerts.length === 0) return null;
  const submitting = fetcher.state !== "idle";
  const execute = (alertId: string, kind: "reallocate_inventory" | "snooze_alert") => {
    fetcher.submit(
      { intent: "alert_action", alert_id: alertId, kind, idempotency_key: idempotencyKey },
      { method: "post" },
    );
  };

  return (
    <Popover
      active={open}
      onClose={() => setOpen(false)}
      preferredAlignment="right"
      activator={
        <button
          type="button"
          className="invx-alerts-pill"
          onClick={() => setOpen((v) => !v)}
          aria-label={`${alerts.length} open alert${alerts.length === 1 ? "" : "s"}`}
        >
          {alerts.length}
        </button>
      }
    >
      <Box padding="300" minWidth="280px">
        <BlockStack gap="300">
          {alerts.map((a) => {
            const actions = inventoryAlertActions(a);
            return (
              <BlockStack gap="100" key={a.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/app/alerts/${a.id}`)}
                  style={{ background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left" }}
                >
                  <Text as="span" variant="bodySm" fontWeight="medium">
                    {a.title}
                  </Text>
                </button>
                <Text as="span" tone="subdued" variant="bodySm">
                  {fmtMoney(a.dollar_impact)} at stake
                </Text>
                <InlineStack gap="150">
                  {actions.map((act) =>
                    act.mode === "execute" ? (
                      <Button
                        key={act.kind}
                        size="micro"
                        disabled={submitting}
                        onClick={() => {
                          if (act.kind !== "create_po_draft") execute(a.id, act.kind);
                        }}
                      >
                        {act.kind === "reallocate_inventory" ? "Move stock" : "Snooze"}
                      </Button>
                    ) : (
                      <Button
                        key={act.kind}
                        size="micro"
                        onClick={() => navigate(`/app/alerts/${a.id}?action=create_po_draft`)}
                      >
                        Draft PO
                      </Button>
                    ),
                  )}
                </InlineStack>
              </BlockStack>
            );
          })}
        </BlockStack>
      </Box>
    </Popover>
  );
}

/** A single inventory facet filter. Renders nothing when the facet has no values
 * (so empty facets don't show dead filters). */
function FacetSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div style={{ minWidth: 150 }}>
      <Select
        label={label}
        labelHidden
        options={[
          { label: `All ${label.toLowerCase()}s`, value: "" },
          ...options.map((o) => ({ label: o, value: o })),
        ]}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

function ShopifySourcePill() {
  return (
    <span className="cdn-source-pill">
      <BrandGlyph name="shopify" />
      Synced from Shopify
    </span>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8a8a8a" strokeWidth={2} aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

/** Lazy-loaded 90-day on-hand trend for one SKU, shown in the relocate modal.
 * Sparkline is auto-scaled, so the min–max range is labelled to keep the shape
 * honest (a small wiggle on a tall stock shouldn't read as a crash). */
function StockHistory({ skuId }: { skuId: string }) {
  const fetcher = useFetcher<{
    points: SkuHistoryPoint[];
    error: { code: string; message: string } | null;
  }>();
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data === undefined) {
      fetcher.load(`/app/skus/${encodeURIComponent(skuId)}/history`);
    }
  }, [skuId, fetcher]);

  const data = fetcher.data;
  const points = data?.points ?? [];
  const width = 300;
  const height = 52;

  let body: React.ReactNode;
  if (data === undefined) {
    body = (
      <Text as="span" tone="subdued" variant="bodySm">
        Loading…
      </Text>
    );
  } else if (data.error) {
    body = (
      <Text as="span" tone="subdued" variant="bodySm">
        Couldn&apos;t load stock history.
      </Text>
    );
  } else if (points.length < 2) {
    body = (
      <Text as="span" tone="subdued" variant="bodySm">
        Not enough history yet — the trend builds as stock changes.
      </Text>
    );
  } else {
    const values = points.map((p) => p.on_hand);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const first = points[0];
    const last = points[points.length - 1];
    const stroke =
      last.on_hand < first.on_hand
        ? "var(--p-color-text-critical, #c4321a)"
        : "var(--p-color-text-secondary, #5c5f62)";
    body = (
      <BlockStack gap="100">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`On-hand from ${first.on_hand} on ${first.date} to ${last.on_hand} on ${last.date}`}
        >
          <path
            d={sparklinePath(values, width, height)}
            fill="none"
            stroke={stroke}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <Text as="span" tone="subdued" variant="bodySm">
          Range {min.toLocaleString()}–{max.toLocaleString()} units · {points.length} updates
        </Text>
      </BlockStack>
    );
  }

  return (
    <BlockStack gap="150">
      <Text as="span" variant="bodySm" fontWeight="medium">
        Stock history · 90 days
      </Text>
      {body}
    </BlockStack>
  );
}

/** Lazy-loaded "frequently bought with" panel for one SKU, shown in the relocate
 * modal. Display-only (no navigation) — a compact list of co-purchased SKUs with
 * order counts + share. */
function BoughtWith({ skuId }: { skuId: string }) {
  const fetcher = useFetcher<{
    items: SkuAffinityItem[];
    error: { code: string; message: string } | null;
  }>();
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data === undefined) {
      fetcher.load(`/app/skus/${encodeURIComponent(skuId)}/affinity`);
    }
  }, [skuId, fetcher]);

  const data = fetcher.data;
  const items = data?.items ?? [];

  let body: React.ReactNode;
  if (data === undefined) {
    body = (
      <Text as="span" tone="subdued" variant="bodySm">
        Loading…
      </Text>
    );
  } else if (data.error) {
    body = (
      <Text as="span" tone="subdued" variant="bodySm">
        Couldn&apos;t load bundles.
      </Text>
    );
  } else if (items.length === 0) {
    body = (
      <Text as="span" tone="subdued" variant="bodySm">
        No frequent pairings yet — this builds as orders come in.
      </Text>
    );
  } else {
    body = (
      <BlockStack gap="100">
        {items.map((it) => (
          <InlineStack key={it.sku_id} align="space-between" gap="200" wrap={false}>
            <Text as="span" variant="bodySm" truncate>
              {it.title}
            </Text>
            <Text as="span" tone="subdued" variant="bodySm">
              {it.co_count.toLocaleString()} order{it.co_count === 1 ? "" : "s"} ·{" "}
              {Math.round(it.share * 100)}%
            </Text>
          </InlineStack>
        ))}
      </BlockStack>
    );
  }

  return (
    <BlockStack gap="150">
      <Text as="span" variant="bodySm" fontWeight="medium">
        Frequently bought with
      </Text>
      {body}
    </BlockStack>
  );
}

function RelocateModal({
  sku,
  locations,
  fetcher,
  onClose,
}: {
  sku: SKU;
  locations: ShopLocation[];
  fetcher: ReturnType<typeof useFetcher<RelocatePayload>>;
  onClose: () => void;
}) {
  // With a suggested transfer the modal opens prefilled; without one it's a
  // manual transfer: source defaults to the largest holder, destination to
  // the first other active location, quantity left for the merchant.
  const plan = sku.suggested_transfer;
  const fallbackFrom = sku.locations_detail.find((l) => l.available > 0)?.id ?? "";
  const initialFrom = plan?.from_location_id ?? fallbackFrom;
  const [fromId, setFromId] = useState(initialFrom);
  const [toId, setToId] = useState(
    plan?.to_location_id ??
      locations.find((l) => l.active && l.id !== initialFrom)?.id ??
      "",
  );
  const [qty, setQty] = useState(plan ? String(plan.recommended_delta) : "");
  // One key per relocation intent: double-clicking Confirm while a submit is
  // in flight replays, not re-executes.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const data = fetcher.data;
  useEffect(() => {
    // A terminal failure burned this key server-side; mint a fresh one so the
    // merchant's retry (possibly with edited inputs) actually executes instead
    // of replaying the failed audit. Rotating after a 422 validation reject is
    // harmless (no marker was written). Each response is a fresh object, so
    // consecutive failures rotate the key each time.
    if (data && !data.ok) setIdempotencyKey(crypto.randomUUID());
  }, [data]);

  const sourceOptions = sku.locations_detail
    .filter((l) => l.available > 0)
    .map((l) => ({
      label: `${l.name} (${l.available.toLocaleString()} available)`,
      value: l.id,
    }));
  const destOptions = locations
    .filter((l) => l.active)
    .map((l) => ({
      label: l.region ? `${l.name} — ${l.region}` : l.name,
      value: l.id,
    }));

  const available = sku.locations_detail.find((l) => l.id === fromId)?.available ?? 0;
  const qtyNum = /^\d+$/.test(qty) ? Number(qty) : NaN;
  const qtyError =
    !Number.isInteger(qtyNum) || qtyNum < 1
      ? "Enter a positive whole number"
      : qtyNum > available
        ? `Only ${available.toLocaleString()} available at the source`
        : undefined;
  const invalid = Boolean(qtyError) || !fromId || !toId || fromId === toId;
  const submitting = fetcher.state !== "idle";

  const submit = () => {
    fetcher.submit(
      {
        sku_id: sku.id,
        from_location_id: fromId,
        to_location_id: toId,
        quantity: qty,
        idempotency_key: idempotencyKey,
      },
      { method: "post" },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Relocate ${sku.title}`}
      primaryAction={{
        content: "Move inventory",
        onAction: submit,
        loading: submitting,
        disabled: invalid,
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {/* key per SKU: remount → fresh fetcher → refetch if the modal is
              ever reused for a different SKU without unmounting. */}
          <StockHistory key={`hist-${sku.id}`} skuId={sku.id} />
          <BoughtWith key={`bw-${sku.id}`} skuId={sku.id} />
          {sku.demand && (
            <Text as="p" tone="subdued">
              Main demand is {sku.demand.region} ({sku.demand.units_30d.toLocaleString()}{" "}
              units/30d), which currently holds{" "}
              {sku.demand.stock_in_region.toLocaleString()} units.
            </Text>
          )}
          <Select label="From" options={sourceOptions} value={fromId} onChange={setFromId} />
          <Select
            label="To"
            options={destOptions}
            value={toId}
            onChange={setToId}
            error={fromId === toId ? "Source and destination must differ" : undefined}
          />
          <TextField
            label="Quantity"
            type="text"
            autoComplete="off"
            value={qty}
            onChange={setQty}
            error={qtyError}
            helpText={plan ? "Suggested to cover one week of regional demand." : undefined}
          />
          <Text as="p" tone="subdued" variant="bodySm">
            Transfers via Shopify, recorded in the audit log. Reversible via Undo for 24
            hours.
          </Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function shortLoc(name: string): string {
  const afterDash = name.split(/[—–-]/).pop() ?? name;
  const city = afterDash.split(",")[0]?.trim() || name;
  return city.length > 12 ? city.slice(0, 11) + "…" : city;
}
