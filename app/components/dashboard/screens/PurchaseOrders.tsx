import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Btn, Card, Pan, Pill, Placeholder, SectionTitle, TableSkeleton } from "../ui";
import { CDIcon } from "../icons";
import { money, timeAgo } from "../format";
import {
  DashboardApiError,
  fetchPurchaseOrders,
  type PurchaseOrderVM,
} from "~/lib/dashboard/client";
import {
  cancelPo,
  fetchPoDetail,
  fetchPoPage,
  fetchPoScreen,
  markPoOrdered,
  poPdfUrl,
  promotePoDraft,
  receivePoLines,
  type PoDetailVM,
  type PoListItemVM,
  type PoScreenData,
  type PoStatusVM,
  type SupplierVM,
} from "~/lib/dashboard/po-client";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import PoModal from "./PoModal";
import PoSuppliersModal from "./PoSuppliersModal";
import type { DashboardCtx } from "../context";

// Real purchase orders: supplier, destination, ETA, lines, and a
// draft → ordered → partially received → received lifecycle (plus cancelled).
// Marking ordered moves the quantities into incoming at the destination;
// receiving moves incoming into on-hand. The Autopilot restock drafts (audit
// snapshots) stay in their own section below and can be converted into real
// draft POs.

const GRID = "1.2fr 1fr 1fr 0.9fr 1.1fr 1.1fr";
const DRAFT_GRID = "1fr 1.6fr 1fr 1.6fr";

function StatusPill({ status }: { status: PoStatusVM }) {
  if (status === "ordered") return <Pill tone="accent" icon="truck">Ordered</Pill>;
  if (status === "partial") return <Pill tone="warn" icon="truck">Partly received</Pill>;
  if (status === "received") return <Pill tone="success" icon="check">Received</Pill>;
  if (status === "cancelled") return <Pill icon="x">Cancelled</Pill>;
  return <Pill icon="doc">Draft</Pill>;
}

/** "2026-08-01" → "Aug 1, 2026" (UTC — date-only strings are UTC days). */
function etaLabel(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) return date;
  return new Date(t).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ---- legacy Autopilot drafts (audit-backed) --------------------------------------

function OutcomeBadge({ outcome }: { outcome: string }) {
  if (outcome === "succeeded") return <Pill tone="success" icon="check">Drafted</Pill>;
  if (outcome === "retrying") return <Pill tone="warn" icon="clock">Retrying</Pill>;
  if (outcome === "failed") return <Pill tone="critical" icon="x">Failed</Pill>;
  return <Pill>{outcome}</Pill>;
}

/** Error captions come from upstream executors and can run long; keep the row
 *  scannable by capping at 80 chars. */
function trimError(message: string): string {
  const t = message.trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

function DraftRow({
  row,
  promoting,
  onConvert,
}: {
  row: PurchaseOrderVM;
  promoting: boolean;
  onConvert: () => void;
}) {
  return (
    <div className="cd-trow" style={{ gridTemplateColumns: DRAFT_GRID }}>
      <div className="cd-row-title tabular-nums truncate">
        {row.poNumber ?? row.id.slice(0, 8).toUpperCase()}
      </div>
      <div className="min-w-0">
        <div className="cd-row-title truncate">{row.sku ?? "—"}</div>
        {row.lineCount > 0 && (
          <div className="cd-caption truncate">
            {row.lineCount} line{row.lineCount === 1 ? "" : "s"}
            {row.totalCents != null ? ` · ${money(row.totalCents)}` : ""}
          </div>
        )}
        {row.outcome === "failed" && row.lastError && (
          <div className="cd-caption truncate" style={{ color: "var(--orange)" }}>
            {trimError(row.lastError)}
          </div>
        )}
      </div>
      <div className="cd-caption">{timeAgo(row.createdAt)}</div>
      <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
        <OutcomeBadge outcome={row.outcome} />
        {/* Both actions need the PO snapshot in the audit row; hasPdf is that
            exact predicate, so neither button can dead-end. */}
        {row.hasPdf && (
          <>
            <Btn small icon="plus" disabled={promoting} onClick={onConvert}>
              {promoting ? "Converting…" : "Convert to PO"}
            </Btn>
            <Btn
              small
              icon="download"
              onClick={() =>
                window.open(
                  `/dashboard/api/audit/${encodeURIComponent(row.id)}/po.pdf`,
                  "_blank",
                  "noopener",
                )
              }
            >
              PDF
            </Btn>
          </>
        )}
      </div>
    </div>
  );
}

// ---- detail drawer -----------------------------------------------------------------

function DrawerMeta({ detail }: { detail: PoDetailVM }) {
  const rows: Array<[string, string]> = [
    ["Supplier", detail.supplierName ?? "—"],
    ["Deliver to", detail.destinationName],
    ["Expected", detail.expectedAt ? etaLabel(detail.expectedAt) : "—"],
    ["Created", timeAgo(detail.createdAt)],
  ];
  if (detail.orderedAt) rows.push(["Ordered", timeAgo(detail.orderedAt)]);
  if (detail.receivedAt) rows.push(["Received", timeAgo(detail.receivedAt)]);
  if (detail.cancelledAt) rows.push(["Cancelled", timeAgo(detail.cancelledAt)]);
  if (detail.source === "autopilot") rows.push(["Source", "Autopilot restock draft"]);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px" }}>
      {rows.map(([label, value]) => (
        <div key={label}>
          <div className="cd-caption">{label}</div>
          <div className="cd-row-title truncate">{value}</div>
        </div>
      ))}
      {detail.notes && (
        <div style={{ gridColumn: "1 / -1" }}>
          <div className="cd-caption">Notes</div>
          <div className="cd-row-title" style={{ whiteSpace: "pre-wrap" }}>{detail.notes}</div>
        </div>
      )}
    </div>
  );
}

export default function PurchaseOrders({ app }: { app: DashboardCtx }) {
  // Seeded from the session cache so a return visit paints instantly; the
  // mount fetch below revalidates and writes back through. Only the default
  // offset-0 payload touches the cache — paged-in rows stay local.
  const seeded = cachedScreenData<PoScreenData>(SCREEN_CACHE_KEYS.po);
  const [pos, setPos] = useState<PoListItemVM[] | null>(() => seeded?.pos ?? null);
  const [total, setTotal] = useState(() => seeded?.total ?? 0);
  const [suppliers, setSuppliers] = useState<SupplierVM[]>(() => seeded?.suppliers ?? []);
  const [promotedIds, setPromotedIds] = useState<Set<string>>(
    () => new Set(seeded?.promotedAuditIds ?? []),
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [staleWarning, setStaleWarning] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Legacy Autopilot drafts (audit rows) for the section below the PO table.
  const [drafts, setDrafts] = useState<PurchaseOrderVM[] | null>(null);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<string | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PoDetailVM | null>(null);
  const [suppliersOpen, setSuppliersOpen] = useState(false);

  // Drawer state. openPoId is set on row click; the detail loads after.
  const [openPoId, setOpenPoId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PoDetailVM | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveQtys, setReceiveQtys] = useState<Record<string, string>>({});
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const toast = app.toast;
  const posRef = useRef(pos);
  posRef.current = pos;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    // The real-PO payload and the legacy drafts list load together but fail
    // independently — one failing must not blank the other.
    void Promise.allSettled([fetchPoScreen(), fetchPurchaseOrders({})]).then(([main, legacy]) => {
      if (!alive) return;
      if (main.status === "fulfilled") {
        cacheScreenData(SCREEN_CACHE_KEYS.po, main.value);
        setPos(main.value.pos);
        setTotal(main.value.total);
        setSuppliers(main.value.suppliers);
        setPromotedIds(new Set(main.value.promotedAuditIds));
        setStaleWarning(false);
        setLoadError(null);
      } else if (posRef.current) {
        setStaleWarning(true);
      } else {
        setLoadError(
          main.reason instanceof DashboardApiError
            ? main.reason.message
            : "Couldn't load purchase orders.",
        );
      }
      if (legacy.status === "fulfilled") {
        cacheScreenData(SCREEN_CACHE_KEYS.purchaseOrders, legacy.value);
        setDrafts(legacy.value.rows);
        setDraftsError(null);
      } else {
        setDraftsError(
          legacy.reason instanceof DashboardApiError
            ? legacy.reason.message
            : "Couldn't load Autopilot drafts.",
        );
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const loadMore = async () => {
    if (!pos) return;
    setLoadingMore(true);
    try {
      const page = await fetchPoPage(pos.length);
      setPos((cur) => {
        const current = cur ?? [];
        const seen = new Set(current.map((p) => p.id));
        return [...current, ...page.pos.filter((p) => !seen.has(p.id))];
      });
      setTotal(page.total);
    } catch (err) {
      toast(
        err instanceof DashboardApiError ? err.message : "Couldn't load more purchase orders.",
        "warn",
        "critical",
      );
    } finally {
      setLoadingMore(false);
    }
  };

  // ---- drawer plumbing -------------------------------------------------------

  const openPo = (poId: string) => {
    setOpenPoId(poId);
    setDetail(null);
    setDetailError(null);
    setReceiveOpen(false);
    setConfirmCancel(false);
  };

  useEffect(() => {
    if (!openPoId) return;
    let alive = true;
    fetchPoDetail(openPoId)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setDetailError(
          err instanceof DashboardApiError ? err.message : "Couldn't load the purchase order.",
        );
      });
    return () => {
      alive = false;
    };
  }, [openPoId]);

  const closeDrawer = useCallback(() => {
    setOpenPoId(null);
    setDetail(null);
    setDetailError(null);
    setReceiveOpen(false);
    setConfirmCancel(false);
  }, []);

  useEffect(() => {
    if (!openPoId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPoId, closeDrawer]);

  // Focus the first control when the drawer opens (same as TransferModal).
  const drawerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!openPoId) return;
    drawerRef.current?.querySelector<HTMLElement>("button, input, select")?.focus();
  }, [openPoId]);

  // Keep Tab cycling inside the drawer while it's open (mirrors TransferModal).
  const onDrawerKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const nodes = drawerRef.current?.querySelectorAll<HTMLElement>("button, input, select");
    if (!nodes) return;
    const focusable = Array.from(nodes).filter((n) => !n.hasAttribute("disabled"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && drawerRef.current?.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // ---- actions -----------------------------------------------------------------

  const runAction = async (
    key: string,
    fn: () => Promise<PoDetailVM>,
    successMessage: string,
  ) => {
    if (actionBusy) return;
    setActionBusy(key);
    try {
      const updated = await fn();
      setDetail(updated);
      setReceiveOpen(false);
      setConfirmCancel(false);
      toast(successMessage, "check");
      reload();
    } catch (err) {
      toast(
        err instanceof DashboardApiError ? err.message : "That didn't go through — try again.",
        "warn",
        "critical",
      );
    } finally {
      setActionBusy(null);
    }
  };

  const startReceive = () => {
    if (!detail) return;
    const prefill: Record<string, string> = {};
    for (const line of detail.lines) {
      prefill[line.id] = String(Math.max(0, line.qtyOrdered - line.qtyReceived));
    }
    setReceiveQtys(prefill);
    setReceiveOpen(true);
  };

  const receiveAll = () => {
    if (!detail) return;
    const all: Record<string, string> = {};
    for (const line of detail.lines) {
      all[line.id] = String(Math.max(0, line.qtyOrdered - line.qtyReceived));
    }
    setReceiveQtys(all);
  };

  const submitReceive = () => {
    if (!detail) return;
    const entries: Array<{ lineId: string; qty: number }> = [];
    for (const line of detail.lines) {
      const qty = Math.trunc(Number(receiveQtys[line.id])) || 0;
      if (qty <= 0) continue;
      if (qty > line.qtyOrdered - line.qtyReceived) {
        toast(`${line.sku ?? line.title ?? "A line"} only has ${line.qtyOrdered - line.qtyReceived} left to receive.`, "warn");
        return;
      }
      entries.push({ lineId: line.id, qty });
    }
    if (entries.length === 0) {
      toast("Enter a quantity to receive on at least one line.", "warn");
      return;
    }
    void runAction("receive", () => receivePoLines(detail.id, entries), "Stock received.");
  };

  const onConvertDraft = (auditId: string) => {
    if (promoting) return;
    setPromoting(auditId);
    promotePoDraft(auditId)
      .then((po) => {
        toast("Converted to a purchase order.", "check");
        setPromotedIds((cur) => new Set([...cur, auditId]));
        reload();
        setOpenPoId(po.id);
        setDetail(po);
        setDetailError(null);
      })
      .catch((err: unknown) => {
        toast(
          err instanceof DashboardApiError ? err.message : "Couldn't convert that draft.",
          "warn",
          "critical",
        );
      })
      .finally(() => setPromoting(null));
  };

  const onSuppliersChanged = (next: SupplierVM[]) => {
    setSuppliers(next);
    const cached = cachedScreenData<PoScreenData>(SCREEN_CACHE_KEYS.po);
    if (cached) cacheScreenData(SCREEN_CACHE_KEYS.po, { ...cached, suppliers: next });
  };

  const visibleDrafts = (drafts ?? []).filter((d) => !promotedIds.has(d.id));
  const shown = pos ?? [];

  const canEdit = detail?.status === "draft";
  const canOrder = detail?.status === "draft";
  const canReceive = detail?.status === "ordered" || detail?.status === "partial";
  const canCancel =
    detail?.status === "draft" || detail?.status === "ordered" || detail?.status === "partial";

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Products">
        <div>
          <h1 className="cd-h1">Products</h1>
          <p className="cd-sub">Purchase orders</p>
        </div>
        <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
          <Btn icon="user" onClick={() => setSuppliersOpen(true)}>
            Suppliers
          </Btn>
          <Btn kind="primary" icon="plus" onClick={() => setCreating(true)}>
            New purchase order
          </Btn>
        </div>
      </header>

      <Card pad={false}>
        {staleWarning && pos && (
          <div className="cd-caption" style={{ padding: "8px 16px", color: "var(--orange)" }}>
            Couldn&apos;t refresh just now — showing the last loaded list.
          </div>
        )}
        {!pos ? (
          loading ? (
            <TableSkeleton />
          ) : (
            <Placeholder
              icon="warn"
              title="Couldn't load purchase orders"
              sub={loadError ?? "Could not load purchase orders just now. Refresh to try again."}
            />
          )
        ) : shown.length === 0 ? (
          <>
            <Placeholder
              icon="doc"
              title="No purchase orders yet"
              sub="Draft one to order stock from a supplier — or convert an Autopilot restock draft below."
            />
            <div className="flex justify-center" style={{ paddingBottom: 28 }}>
              <Btn small icon="plus" onClick={() => setCreating(true)}>
                New purchase order
              </Btn>
            </div>
          </>
        ) : (
          <Pan min={760}>
            <div className="cd-tablehd" style={{ gridTemplateColumns: GRID }}>
              <span>PO</span>
              <span>Supplier</span>
              <span>Deliver to</span>
              <span>Expected</span>
              <span>Lines</span>
              <span>Status</span>
            </div>
            {shown.map((row) => (
              <button
                key={row.id}
                type="button"
                className="cd-trow"
                onClick={() => openPo(row.id)}
                style={{
                  gridTemplateColumns: GRID,
                  width: "100%",
                  background: "none",
                  border: 0,
                  font: "inherit",
                  color: "inherit",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <div className="min-w-0">
                  <div className="cd-row-title tabular-nums truncate">{row.poNumber}</div>
                  <div className="cd-caption">{timeAgo(row.updatedAt)}</div>
                </div>
                <div className="cd-caption truncate">{row.supplierName ?? "—"}</div>
                <div className="cd-caption truncate">{row.destinationName}</div>
                <div className="cd-caption tabular-nums">
                  {row.expectedAt ? etaLabel(row.expectedAt) : "—"}
                </div>
                <div className="min-w-0">
                  <div className="cd-row-title tabular-nums truncate">
                    {row.lineCount} line{row.lineCount === 1 ? "" : "s"} · {row.unitsOrdered} units
                  </div>
                  <div className="cd-caption">
                    {row.totalCents != null ? money(row.totalCents) : "Cost TBD"}
                  </div>
                </div>
                <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
                  <StatusPill status={row.status} />
                  {row.status === "partial" && (
                    <span className="cd-caption tabular-nums">
                      {row.unitsReceived} of {row.unitsOrdered}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </Pan>
        )}
      </Card>

      {!loading && !loadError && pos && pos.length < total && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          <Btn disabled={loadingMore} onClick={() => { void loadMore(); }}>
            {loadingMore ? "Loading…" : `Load more (${pos.length} of ${total})`}
          </Btn>
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <SectionTitle>Autopilot drafts</SectionTitle>
        <Card pad={false}>
          {draftsError ? (
            <Placeholder icon="warn" title="Drafts unavailable" sub={draftsError} />
          ) : drafts == null ? (
            <TableSkeleton rows={3} />
          ) : visibleDrafts.length === 0 ? (
            <Placeholder
              icon="doc"
              title="No restock drafts"
              sub="When Calderyn drafts a PO from an inventory alert it lands here, ready to convert."
            />
          ) : (
            <Pan min={620}>
              <div className="cd-tablehd" style={{ gridTemplateColumns: DRAFT_GRID }}>
                <span>PO</span>
                <span>Detail</span>
                <span>Drafted</span>
                <span>Actions</span>
              </div>
              {visibleDrafts.map((r) => (
                <DraftRow
                  key={r.id}
                  row={r}
                  promoting={promoting === r.id}
                  onConvert={() => onConvertDraft(r.id)}
                />
              ))}
            </Pan>
          )}
        </Card>
      </div>

      {openPoId && (
        <div
          role="presentation"
          onClick={closeDrawer}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 80,
            background: "color-mix(in oklch, black 32%, transparent)",
          }}
        >
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Purchase order details"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onDrawerKeyDown}
            style={{
              position: "fixed",
              top: 0,
              right: 0,
              bottom: 0,
              width: "min(600px, 100vw)",
              overflowY: "auto",
              padding: 16,
            }}
          >
            <Card>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 12,
                }}
              >
                <div className="min-w-0">
                  <div className="cd-h2 tabular-nums truncate">
                    {detail?.poNumber ?? "Purchase order"}
                  </div>
                  {detail && (
                    <div style={{ marginTop: 4 }}>
                      <StatusPill status={detail.status} />
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={closeDrawer}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 26,
                    height: 26,
                    background: "none",
                    border: 0,
                    color: "inherit",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  <CDIcon name="x" size={15} />
                </button>
              </div>

              {detailError ? (
                <Placeholder icon="warn" title="Couldn't load this PO" sub={detailError} />
              ) : !detail ? (
                <TableSkeleton rows={4} />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <DrawerMeta detail={detail} />

                  <div>
                    <div className="cd-caption" style={{ marginBottom: 6 }}>Lines</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {detail.lines.map((line) => {
                        const remaining = Math.max(0, line.qtyOrdered - line.qtyReceived);
                        return (
                          <div
                            key={line.id}
                            style={{ display: "flex", alignItems: "center", gap: 8 }}
                          >
                            <div className="min-w-0" style={{ flex: 1 }}>
                              <div className="cd-row-title truncate">
                                {line.sku ?? line.title ?? line.variantId.slice(0, 8)}
                              </div>
                              {line.title && line.sku && (
                                <div className="cd-caption truncate">{line.title}</div>
                              )}
                            </div>
                            <div className="cd-caption tabular-nums" style={{ flexShrink: 0 }}>
                              {line.qtyReceived} of {line.qtyOrdered} received
                            </div>
                            <div className="cd-caption tabular-nums" style={{ flexShrink: 0 }}>
                              {line.unitCostCents != null ? money(line.unitCostCents) : "TBD"}
                            </div>
                            {receiveOpen && (
                              <input
                                className="cd-input tabular-nums"
                                type="number"
                                min={0}
                                max={remaining}
                                aria-label={`Receive quantity for ${line.sku ?? line.title ?? "line"}`}
                                style={{ width: 76, flexShrink: 0 }}
                                value={receiveQtys[line.id] ?? ""}
                                onChange={(e) =>
                                  setReceiveQtys((cur) => ({
                                    ...cur,
                                    [line.id]: e.target.value,
                                  }))
                                }
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="cd-caption tabular-nums" style={{ marginTop: 8 }}>
                      Total: {detail.totalCents != null ? money(detail.totalCents) : "TBD"}
                    </div>
                  </div>

                  {receiveOpen ? (
                    <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
                      <Btn small onClick={receiveAll}>Receive all</Btn>
                      <div style={{ flex: 1 }} />
                      <Btn small onClick={() => setReceiveOpen(false)} disabled={actionBusy != null}>
                        Back
                      </Btn>
                      <Btn
                        small
                        kind="primary"
                        icon="check"
                        disabled={actionBusy != null}
                        onClick={submitReceive}
                      >
                        {actionBusy === "receive" ? "Receiving…" : "Receive"}
                      </Btn>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
                      {canEdit && (
                        <Btn small icon="edit" onClick={() => setEditing(detail)}>
                          Edit
                        </Btn>
                      )}
                      {canOrder && (
                        <Btn
                          small
                          kind="primary"
                          icon="truck"
                          disabled={actionBusy != null}
                          onClick={() => {
                            void runAction(
                              "order",
                              () => markPoOrdered(detail.id),
                              "Marked as ordered — stock is now expected.",
                            );
                          }}
                        >
                          {actionBusy === "order" ? "Ordering…" : "Mark ordered"}
                        </Btn>
                      )}
                      {canReceive && (
                        <Btn small kind="primary" icon="check" onClick={startReceive}>
                          Receive…
                        </Btn>
                      )}
                      <Btn
                        small
                        icon="download"
                        onClick={() => window.open(poPdfUrl(detail.id), "_blank", "noopener")}
                      >
                        PDF
                      </Btn>
                      <div style={{ flex: 1 }} />
                      {canCancel &&
                        (confirmCancel ? (
                          <>
                            <Btn small onClick={() => setConfirmCancel(false)}>Keep it</Btn>
                            <Btn
                              small
                              kind="danger"
                              disabled={actionBusy != null}
                              onClick={() => {
                                void runAction(
                                  "cancel",
                                  () => cancelPo(detail.id),
                                  "Purchase order cancelled.",
                                );
                              }}
                            >
                              {actionBusy === "cancel" ? "Cancelling…" : "Confirm cancel"}
                            </Btn>
                          </>
                        ) : (
                          <Btn small icon="x" onClick={() => setConfirmCancel(true)}>
                            Cancel PO
                          </Btn>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}

      {creating && (
        <PoModal
          app={app}
          suppliers={suppliers}
          onClose={() => setCreating(false)}
          onDone={(po) => {
            reload();
            setOpenPoId(po.id);
            setDetail(po);
            setDetailError(null);
          }}
        />
      )}

      {editing && (
        <PoModal
          app={app}
          suppliers={suppliers}
          existing={editing}
          onClose={() => setEditing(null)}
          onDone={(po) => {
            reload();
            setDetail(po);
          }}
        />
      )}

      {suppliersOpen && (
        <PoSuppliersModal
          app={app}
          suppliers={suppliers}
          onChanged={onSuppliersChanged}
          onClose={() => setSuppliersOpen(false)}
        />
      )}
    </div>
  );
}
