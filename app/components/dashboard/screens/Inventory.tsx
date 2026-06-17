// Calderyn DashV2 — Inventory screen (LIVE).
// Ported from the inventory section of the prototype's screen-ops.jsx, wired to
// the live data layer. Self-fetches SKUs via fetchSkus() (there is no app.skus).
// Renders the prototype's inventory table: title, sku code, on-hand, days of
// cover, velocity, ship P&L, and a status pill. Rows that map
// to an open alert are clickable through to that alert.
import { useEffect, useMemo, useState } from "react";
import { Btn, Card, Pill, Segmented, Placeholder, Sparkline } from "../ui";
import { CDIcon } from "../icons";
import {
  executeAlertAction,
  fetchSkus,
  fetchSkuHistory,
  fetchSkuAffinity,
  relocateSku,
  sortSkus,
  DashboardApiError,
} from "~/lib/dashboard/client";
import { inventoryAlertActions, openAlertsBySku } from "~/lib/inventory-alerts";
import { formatDemandUnits, formatStockoutDate } from "~/lib/inventory-demand";
import { money, moneyK } from "../format";
import { ShipPnlCell } from "../ship-pnl-cell";
import type { DashboardCtx } from "../context";
import type { SkuVM, AlertVM } from "../view-models";
import type { SkuAffinityItem, SkuHistoryPoint } from "~/lib/types";

type PillTone = "neutral" | "success" | "critical" | "accent" | "warn";

/** Ship-cost provenance pill — mirrors the Shopify-side SKU badge, using the
 * dashboard's own Pill primitive (worst/lowest-confidence source per SKU). */
function ShipCostPill({ source }: { source: SkuVM["ship_cost_source"] }) {
  let label: string;
  let tone: PillTone;
  switch (source) {
    case "actual_invoice":
    case "actual_event":
      label = "Actual";
      tone = "success";
      break;
    case "reconciled":
      label = "Reconciled";
      tone = "accent";
      break;
    case "manual":
      label = "Manual";
      tone = "accent";
      break;
    case "modeled":
      label = "Modeled";
      tone = "warn";
      break;
    case "fallback":
      label = "Estimate";
      tone = "warn";
      break;
    default:
      return null;
  }
  return <Pill tone={tone}>{label}</Pill>;
}

const SKU_STATUS: Record<string, { label: string; tone: PillTone }> = {
  stockout: { label: "Stocked out", tone: "critical" },
  risk: { label: "At risk", tone: "warn" },
  reorder: { label: "Reorder soon", tone: "warn" },
  misplaced: { label: "Wrong location", tone: "accent" },
  healthy: { label: "Healthy", tone: "success" },
};

/* ---------- Screen ---------- */
type Filter = "All" | "Needs attention" | "Healthy";
type SortBy = "Stock" | "Revenue";

export default function Inventory({ app }: { app: DashboardCtx }) {
  const [filter, setFilter] = useState<Filter>("All");
  const [sortBy, setSortBy] = useState<SortBy>("Stock");
  const [fVendor, setFVendor] = useState("");
  const [fType, setFType] = useState("");
  const [fCollection, setFCollection] = useState("");
  const [fTag, setFTag] = useState("");
  const [skus, setSkus] = useState<SkuVM[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [relocating, setRelocating] = useState<SkuVM | null>(null);
  const [alertsFor, setAlertsFor] = useState<SkuVM | null>(null);
  const [busy, setBusy] = useState(false);
  // app.refresh() reloads the shell's data but not this screen's self-fetched
  // SKUs; bump this counter to re-run the fetch after a successful relocate.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchSkus()
      .then((rows) => {
        if (!alive) return;
        setSkus(rows);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(
          err instanceof DashboardApiError ? err.message : "Couldn't load inventory.",
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  /**
   * Executes the transfer. Returns true when the dialog's idempotency key was
   * burned server-side (a terminal failure was recorded or the request was
   * rejected) and must be rotated before a retry; false when it must be kept.
   */
  async function confirmRelocate(
    skuId: string,
    fromId: string,
    toId: string,
    qty: number,
    idempotencyKey: string,
  ): Promise<boolean> {
    setBusy(true);
    try {
      const { outcome } = await relocateSku(skuId, {
        fromLocationId: fromId,
        toLocationId: toId,
        quantity: qty,
        idempotencyKey,
      });
      if (outcome === "succeeded") {
        app.toast("Inventory transfer executed", "box", "success");
        setRelocating(null);
        setReloadKey((k) => k + 1);
        app.refresh();
        return false;
      }
      app.toast("Transfer recorded as failed — check the audit log", "warn", "critical");
      // The server recorded a terminal failed outcome under this key; a retry
      // must mint a fresh key or it would replay the failed audit forever.
      return true;
    } catch (err) {
      app.toast(
        err instanceof DashboardApiError ? err.message : "Couldn't move inventory.",
        "warn",
        "critical",
      );
      // DashboardApiError means the server actually responded (apiSend throws
      // it only on a 4xx/5xx response): it recorded a terminal state or
      // rejected the request, so the key is burned — rotate. Anything else is
      // a network-level failure (fetch rejected with no server response): the
      // transfer may have been applied, so KEEP the key and let the retry
      // dedupe via priorExecutionForKey.
      return err instanceof DashboardApiError;
    } finally {
      setBusy(false);
    }
  }

  async function runAlertAction(alertId: string, kind: string) {
    setBusy(true);
    try {
      const { outcome } = await executeAlertAction(alertId, { type: kind });
      if (outcome === "succeeded") {
        app.toast(kind === "snooze_alert" ? "Alert snoozed" : "Inventory transfer executed", "box", "success");
        setReloadKey((k) => k + 1);
        app.refresh();
      } else {
        app.toast("Action recorded as failed — check the audit log", "warn", "critical");
      }
    } catch (err) {
      app.toast(
        err instanceof DashboardApiError ? err.message : "Couldn't execute the action.",
        "warn",
        "critical",
      );
    } finally {
      setBusy(false);
    }
  }

  // Distinct facet values for the slicing dropdowns — a facet with no values
  // renders no filter (no dead filters).
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
    const sv = (set: Set<string>) => [...set].sort((a, b) => a.localeCompare(b));
    return { vendors: sv(vendors), types: sv(types), collections: sv(collections), tags: sv(tags) };
  }, [skus]);

  // Filter by status + facets, then "Revenue" sort re-ranks (SKUs arrive
  // on-hand-desc from fetchSkus, so "Stock" is the as-loaded order).
  const filtered = skus.filter(
    (s) =>
      (filter === "All"
        ? true
        : filter === "Healthy"
          ? s.status === "healthy"
          : s.status !== "healthy") &&
      (!fVendor || s.vendor === fVendor) &&
      (!fType || s.product_type === fType) &&
      (!fCollection || (s.collections ?? []).includes(fCollection)) &&
      (!fTag || (s.tags ?? []).includes(fTag)),
  );
  const shown =
    sortBy === "Revenue" ? sortSkus(filtered, "revenue_30d_cents") : filtered;

  // Alerts reference SKUs by their sku code — exact match (the prototype's
  // title-prefix heuristic never matched real sku codes). One O(alerts) pass,
  // same helper the extension page uses.
  const alertsBySku = useMemo(() => openAlertsBySku(app.alerts), [app.alerts]);
  const openAlertsFor = (sku: SkuVM): AlertVM[] => alertsBySku.get(sku.sku) ?? [];

  return (
    <div className="cd-screen">
      <ScreenHeaderInline
        loading={loading}
        total={skus.length}
        filter={filter}
        onFilter={setFilter}
        sortBy={sortBy}
        onSort={setSortBy}
      />
      {(facets.vendors.length ||
        facets.types.length ||
        facets.collections.length ||
        facets.tags.length) > 0 && (
        <div
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}
        >
          <DashFacet label="Vendor" value={fVendor} options={facets.vendors} onChange={setFVendor} />
          <DashFacet label="Type" value={fType} options={facets.types} onChange={setFType} />
          <DashFacet
            label="Collection"
            value={fCollection}
            options={facets.collections}
            onChange={setFCollection}
          />
          <DashFacet label="Tag" value={fTag} options={facets.tags} onChange={setFTag} />
          {(fVendor || fType || fCollection || fTag) && (
            <Btn
              small
              onClick={() => {
                setFVendor("");
                setFType("");
                setFCollection("");
                setFTag("");
              }}
            >
              Clear filters
            </Btn>
          )}
        </div>
      )}
      <Card pad={false}>
        {loading ? (
          <Placeholder icon="box" title="Loading inventory" sub="Reading on-hand and velocity across your locations." />
        ) : error ? (
          <Placeholder icon="warn" title="Couldn't load inventory" sub={error} />
        ) : skus.length === 0 ? (
          <Placeholder icon="box" title="No SKUs" sub="Connect a store and your tracked SKUs will appear here." />
        ) : (
          <>
            <div className="cd-table-head">
              <span style={{ flex: "1 1 0", minWidth: 140 }}>SKU</span>
              <span style={{ width: 64, textAlign: "right" }}>On hand</span>
              <span style={{ width: 60, textAlign: "right" }}>Cover</span>
              <span style={{ width: 64, textAlign: "right" }}>Velocity</span>
              <span style={{ width: 76, textAlign: "right" }}>Rev · 30d</span>
              <span style={{ width: 88, textAlign: "right" }}>Ship P&amp;L</span>
              <span style={{ width: 120 }}>Main demand</span>
              <span style={{ width: 84 }}></span>
              <span style={{ width: 56, textAlign: "center" }}>Alerts</span>
              <span style={{ width: 92, textAlign: "right" }}>Ship cost</span>
              <span style={{ width: 92, textAlign: "right" }}>Status</span>
            </div>
            <div className="cd-rows">
              {shown.map((s) => {
                const st = SKU_STATUS[s.status] ?? SKU_STATUS.healthy;
                const skuAlerts = openAlertsFor(s);
                const alert = skuAlerts[0];
                const canRelocate = s.locations_detail.some((l) => l.available > 0);
                // Sell-out date label, only for low-cover rows — a date on
                // healthy long-tail stock is just noise. Mirrors the extension's
                // caution band (cover < 7d) so the date shows under the same
                // condition on both surfaces (projected_stockout is null for
                // no-sales SKUs, matching the extension's `selling` gate).
                const stockoutLabel =
                  s.projected_stockout && s.days_of_cover < 7
                    ? formatStockoutDate(s.projected_stockout)
                    : null;
                return (
                  <div
                    key={s.id}
                    className="cd-row"
                    style={{ cursor: alert ? "pointer" : "default" }}
                    role={alert ? "button" : undefined}
                    tabIndex={alert ? 0 : undefined}
                    onClick={alert ? () => app.navigate("alerts", alert.id) : undefined}
                    onKeyDown={
                      alert
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              app.navigate("alerts", alert.id);
                            }
                          }
                        : undefined
                    }
                  >
                    <div className="min-w-0" style={{ flex: "1 1 0", minWidth: 140 }}>
                      <div className="cd-row-title truncate">{s.title}</div>
                      <div className="cd-caption truncate">
                        {s.category ? `${s.sku} · ${s.category}` : s.sku}
                      </div>
                    </div>
                    <span
                      className="tabular-nums cd-row-num"
                      style={{
                        width: 64,
                        textAlign: "right",
                        color: s.on_hand === 0 ? "var(--red)" : "var(--text-1)",
                      }}
                    >
                      {s.on_hand}
                    </span>
                    <span
                      style={{
                        width: 60,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-end",
                      }}
                    >
                      <span
                        className="tabular-nums"
                        style={{ color: s.days_of_cover <= 9 ? "var(--red)" : "var(--text-2)" }}
                      >
                        {s.days_of_cover}d
                      </span>
                      {stockoutLabel && (
                        <span
                          className="cd-caption tabular-nums"
                          title={`Projected to sell out around ${stockoutLabel} at the current pace`}
                        >
                          ~{stockoutLabel}
                        </span>
                      )}
                    </span>
                    <span
                      className="tabular-nums cd-caption"
                      style={{ width: 64, textAlign: "right" }}
                    >
                      {s.velocity.toFixed(1)}/day
                    </span>
                    <span
                      className="tabular-nums cd-caption"
                      style={{ width: 76, textAlign: "right" }}
                    >
                      {s.revenue_30d_cents ? moneyK(s.revenue_30d_cents) : "—"}
                    </span>
                    <span
                      style={{
                        width: 88,
                        textAlign: "right",
                        display: "flex",
                        justifyContent: "flex-end",
                      }}
                      title="Shipping collected − true ship cost, last 30d"
                    >
                      <ShipPnlCell cents={s.ship_pnl_cents} />
                    </span>
                    <span style={{ width: 120 }}>
                      {s.demand ? (
                        <span
                          className="min-w-0"
                          title={`${formatDemandUnits(s.demand.units_30d)} in ${s.demand.region} · ${s.demand.stock_in_region} in stock there`}
                          style={{ display: "flex", flexDirection: "column" }}
                        >
                          <span
                            className="truncate"
                            style={{
                              color:
                                s.demand.stock_in_region === 0
                                  ? "var(--red)"
                                  : "var(--text-2)",
                            }}
                          >
                            {s.demand.region}
                          </span>
                          <span
                            className="cd-caption tabular-nums truncate"
                            style={
                              s.demand.stock_in_region === 0
                                ? { color: "var(--red)" }
                                : undefined
                            }
                          >
                            {formatDemandUnits(s.demand.units_30d)}
                          </span>
                        </span>
                      ) : (
                        <span className="cd-caption">—</span>
                      )}
                    </span>
                    {/* Wrapper stops click/keydown bubbling to the row, which
                        otherwise navigates to the linked alert. */}
                    <span
                      style={{ width: 84, display: "flex", justifyContent: "flex-end" }}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      {canRelocate && (
                        <Btn small onClick={() => setRelocating(s)}>
                          Relocate
                        </Btn>
                      )}
                    </span>
                    {/* Same bubbling guard: opening the alert panel must not
                        also trigger the row's navigate-to-alert handler. */}
                    <span
                      style={{ width: 56, display: "flex", justifyContent: "center" }}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      {skuAlerts.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setAlertsFor(s)}
                          aria-label={`${skuAlerts.length} open alerts`}
                          style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
                        >
                          <Pill tone="warn">{String(skuAlerts.length)}</Pill>
                        </button>
                      )}
                    </span>
                    <span style={{ width: 92, display: "flex", justifyContent: "flex-end" }}>
                      <ShipCostPill source={s.ship_cost_source} />
                    </span>
                    <span style={{ width: 92, display: "flex", justifyContent: "flex-end" }}>
                      <Pill tone={st.tone}>{st.label}</Pill>
                    </span>
                  </div>
                );
              })}
              {shown.length === 0 && (
                <div className="cd-caption" style={{ padding: "16px 4px" }}>
                  No SKUs match these filters.
                </div>
              )}
            </div>
          </>
        )}
      </Card>
      <p className="cd-caption" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <CDIcon name="box" size={13} /> Rows with an open alert are clickable; the alert count opens inline actions.
      </p>
      {alertsFor && (
        <AlertActionsDialog
          sku={alertsFor}
          alerts={openAlertsFor(alertsFor)}
          busy={busy}
          onClose={() => setAlertsFor(null)}
          onExecute={runAlertAction}
          onOpenAlert={(id) => app.navigate("alerts", id)}
        />
      )}
      {relocating && (
        <RelocateDialog
          sku={relocating}
          busy={busy}
          onClose={() => setRelocating(null)}
          onConfirm={(fromId, toId, qty, key) =>
            confirmRelocate(relocating.id, fromId, toId, qty, key)
          }
        />
      )}
    </div>
  );
}

/* ---------- Per-SKU alert actions dialog ---------- */
// Mirror of the extension's alerts popover: each open alert with its
// inline-executable actions; form-based actions open the alert detail.
function AlertActionsDialog({
  sku,
  alerts,
  busy,
  onClose,
  onExecute,
  onOpenAlert,
}: {
  sku: SkuVM;
  alerts: AlertVM[];
  busy: boolean;
  onClose: () => void;
  onExecute: (alertId: string, kind: string) => Promise<void>;
  onOpenAlert: (alertId: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "color-mix(in oklch, black 32%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Alerts for ${sku.title}`}
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 440 }}
      >
        <Card>
          <div className="cd-h2" style={{ marginBottom: 10 }}>
            Alerts — {sku.title}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {alerts.length === 0 && (
              <p className="cd-caption">No open alerts for this SKU anymore.</p>
            )}
            {alerts.map((a) => {
              const actions = inventoryAlertActions(a);
              return (
                <div key={a.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <button
                    type="button"
                    className="cd-row-title"
                    onClick={() => onOpenAlert(a.id)}
                    style={{
                      background: "none",
                      border: 0,
                      padding: 0,
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    {a.title}
                  </button>
                  <span className="cd-caption tabular-nums">
                    {money(a.dollar_impact)} at stake
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    {actions.map((act) =>
                      act.mode === "execute" ? (
                        <Btn
                          key={act.kind}
                          small
                          disabled={busy}
                          onClick={() => void onExecute(a.id, act.kind)}
                        >
                          {act.kind === "reallocate_inventory" ? "Move stock" : "Snooze"}
                        </Btn>
                      ) : (
                        <Btn key={act.kind} small onClick={() => onOpenAlert(a.id)}>
                          Draft PO
                        </Btn>
                      ),
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------- Relocate dialog ---------- */
// No shared modal primitive exists in the dashboard kit yet, so this renders a
// minimal fixed backdrop + centered Card, with cd-field/cd-input form controls
// (the Predictor screen's form styling).
/** Lazy-loaded 90-day on-hand trend for one SKU, shown in the relocate dialog.
 * Reuses the dashboard Sparkline primitive. Auto-scaled, so the min–max range is
 * labelled to keep the shape honest (a small wiggle shouldn't read as a crash). */
function StockHistory({ skuId }: { skuId: string }) {
  const [points, setPoints] = useState<SkuHistoryPoint[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    setPoints(null);
    setError(false);
    fetchSkuHistory(skuId)
      .then((rows) => alive && setPoints(rows))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [skuId]);

  let body: React.ReactNode;
  if (error) {
    body = <span className="cd-caption">Couldn&apos;t load stock history.</span>;
  } else if (points === null) {
    body = <span className="cd-caption">Loading…</span>;
  } else if (points.length < 2) {
    body = (
      <span className="cd-caption">
        Not enough history yet — the trend builds as stock changes.
      </span>
    );
  } else {
    const values = points.map((p) => p.on_hand);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const first = points[0];
    const last = points[points.length - 1];
    const stroke = last.on_hand < first.on_hand ? "var(--red)" : "var(--text-2)";
    body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <Sparkline data={values} width={300} height={52} stroke={stroke} />
        <span className="cd-caption tabular-nums">
          Range {min.toLocaleString()}–{max.toLocaleString()} units · {points.length} updates
        </span>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="cd-row-title" style={{ marginBottom: 6 }}>
        Stock history · 90 days
      </div>
      {body}
    </div>
  );
}

/** Lazy-loaded "frequently bought with" panel for one SKU, shown in the relocate
 * dialog. Display-only list of co-purchased SKUs with order counts + share. */
function BoughtWith({ skuId }: { skuId: string }) {
  const [items, setItems] = useState<SkuAffinityItem[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    setItems(null);
    setError(false);
    fetchSkuAffinity(skuId)
      .then((rows) => alive && setItems(rows))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [skuId]);

  let body: React.ReactNode;
  if (error) {
    body = <span className="cd-caption">Couldn&apos;t load bundles.</span>;
  } else if (items === null) {
    body = <span className="cd-caption">Loading…</span>;
  } else if (items.length === 0) {
    body = (
      <span className="cd-caption">No frequent pairings yet — this builds as orders come in.</span>
    );
  } else {
    body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((it) => (
          <div
            key={it.sku_id}
            style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
          >
            <span className="cd-row-title truncate">{it.title}</span>
            <span className="cd-caption tabular-nums" style={{ whiteSpace: "nowrap" }}>
              {it.co_count.toLocaleString()} order{it.co_count === 1 ? "" : "s"} ·{" "}
              {Math.round(it.share * 100)}%
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="cd-row-title" style={{ marginBottom: 6 }}>
        Frequently bought with
      </div>
      {body}
    </div>
  );
}

function RelocateDialog({
  sku,
  busy,
  onClose,
  onConfirm,
}: {
  sku: SkuVM;
  busy: boolean;
  onClose: () => void;
  /** Resolves true when the idempotency key was burned and must be rotated. */
  onConfirm: (fromId: string, toId: string, qty: number, idempotencyKey: string) => Promise<boolean>;
}) {
  const suggestion = sku.suggested_transfer;
  const sources = sku.locations_detail.filter((l) => l.available > 0);
  // The dashboard API has no shop-locations endpoint; destinations are the
  // SKU's own ACTIVE locations (the server rejects inactive destinations)
  // plus the suggested destination (active by construction in the view's
  // dest pick), deduped by id. Sources stay unfiltered: draining an
  // inactive location is valid.
  const destinations = [
    ...sku.locations_detail.filter((l) => l.active),
    ...(suggestion && !sku.locations_detail.some((l) => l.id === suggestion.to_location_id)
      ? [
          {
            id: suggestion.to_location_id,
            name: suggestion.to_location_name,
            region: null,
            available: 0,
            active: true,
          },
        ]
      : []),
  ];

  // One key per relocation intent, minted on dialog mount: an in-flight
  // double-click or a retry after a network timeout replays, not re-executes.
  // Rotated only when onConfirm reports the server burned it (terminal
  // failure or rejected request).
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [fromId, setFromId] = useState(
    suggestion && sources.some((l) => l.id === suggestion.from_location_id)
      ? suggestion.from_location_id
      : sources[0]?.id ?? "",
  );
  const [toId, setToId] = useState(suggestion?.to_location_id ?? destinations[0]?.id ?? "");
  const [qty, setQty] = useState(suggestion ? String(suggestion.recommended_delta) : "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const source = sources.find((l) => l.id === fromId);
  const qtyNum = /^\d+$/.test(qty.trim()) ? Number(qty.trim()) : NaN;
  const valid =
    qtyNum > 0 &&
    fromId !== "" &&
    toId !== "" &&
    fromId !== toId &&
    source != null &&
    qtyNum <= source.available;

  return (
    // Backdrop click closes; Escape is handled above, so the static-element
    // click handler is a pointer convenience, not the only dismissal path.
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "color-mix(in oklch, black 32%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Relocate ${sku.title}`}
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 420 }}
      >
        <Card>
          <div className="cd-h2" style={{ marginBottom: 6 }}>
            Relocate {sku.title}
          </div>
          <StockHistory skuId={sku.id} />
          {sku.demand && (
            <p className="cd-caption" style={{ marginBottom: 12 }}>
              {sku.demand.units_30d} units sold in {sku.demand.region} over 30 days ·{" "}
              {sku.demand.stock_in_region} in stock there.
            </p>
          )}
          <BoughtWith skuId={sku.id} />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label className="cd-field">
              <span>From</span>
              <select
                className="cd-input"
                value={fromId}
                onChange={(e) => setFromId(e.target.value)}
              >
                {sources.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.available} available)
                  </option>
                ))}
              </select>
            </label>
            <label className="cd-field">
              <span>To</span>
              <select className="cd-input" value={toId} onChange={(e) => setToId(e.target.value)}>
                {destinations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="cd-field">
              <span>Quantity</span>
              <input
                className="cd-input tabular-nums"
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            </label>
            <p className="cd-caption">
              Recorded in the audit log. Reversible via Undo for 24 hours.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn onClick={onClose} disabled={busy}>
                Cancel
              </Btn>
              <Btn
                kind="primary"
                onClick={() => {
                  void onConfirm(fromId, toId, qtyNum, idempotencyKey).then((burned) => {
                    if (burned) setIdempotencyKey(crypto.randomUUID());
                  });
                }}
                disabled={busy || !valid}
              >
                Move inventory
              </Btn>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------- Header (mirrors the prototype's ScreenHeader) ---------- */
/** A single inventory facet filter (dashboard native select). Renders nothing
 * when the facet has no values, so empty facets don't show dead filters. */
function DashFacet({
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
    <select
      className="cd-input"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: "auto", minWidth: 132 }}
    >
      <option value="">All {label.toLowerCase()}s</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function ScreenHeaderInline({
  loading,
  total,
  filter,
  onFilter,
  sortBy,
  onSort,
}: {
  loading: boolean;
  total: number;
  filter: Filter;
  onFilter: (next: Filter) => void;
  sortBy: SortBy;
  onSort: (next: SortBy) => void;
}) {
  return (
    <header className="cd-screen-head" data-screen-label="Inventory">
      <div>
        <h1 className="cd-h1">Inventory</h1>
        <p className="cd-sub">
          {loading
            ? "Loading SKUs across your locations…"
            : `${total} tracked SKUs`}
        </p>
      </div>
      <div className="flex items-center gap-2.5">
        <span className="cd-caption">Sort</span>
        <Segmented
          small
          value={sortBy}
          onChange={(v) => onSort(v as SortBy)}
          options={["Stock", "Revenue"]}
        />
        <Segmented
          small
          value={filter}
          onChange={(v) => onFilter(v as Filter)}
          options={["All", "Needs attention", "Healthy"]}
        />
      </div>
    </header>
  );
}
