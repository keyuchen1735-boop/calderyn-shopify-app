import { useCallback, useEffect, useRef, useState } from "react";
import { Btn, Card, Pan, Pill, Placeholder, SectionTitle, Segmented, TableSkeleton } from "../ui";
import { CDIcon } from "../icons";
import { money, shortDateYear, timeAgo } from "../format";
import { useModalChrome } from "../use-modal-chrome";
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

/** One label per status — the pills and the filter control must agree. */
const STATUS_LABELS: Record<PoStatusVM, string> = {
  draft: "Draft",
  ordered: "Ordered",
  partial: "Partly received",
  received: "Received",
  cancelled: "Cancelled",
};

const FILTER_OPTIONS = [
  { value: "all", label: "All" },
  ...(Object.keys(STATUS_LABELS) as PoStatusVM[]).map((value) => ({
    value,
    label: STATUS_LABELS[value],
  })),
];

function StatusPill({ status }: { status: PoStatusVM }) {
  if (status === "ordered") return <Pill tone="accent" icon="truck">{STATUS_LABELS.ordered}</Pill>;
  if (status === "partial") return <Pill tone="warn" icon="truck">{STATUS_LABELS.partial}</Pill>;
  if (status === "received") return <Pill tone="success" icon="check">{STATUS_LABELS.received}</Pill>;
  if (status === "cancelled") return <Pill icon="x">{STATUS_LABELS.cancelled}</Pill>;
  return <Pill icon="doc">{STATUS_LABELS.draft}</Pill>;
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
        {/* Convert needs a SETTLED snapshot: a retrying executor may still
            rewrite it, so only succeeded drafts are convertible. The PDF only
            needs the snapshot to exist (hasPdf — the PDF route's predicate). */}
        {row.hasPdf && row.outcome === "succeeded" && (
          <Btn small icon="plus" disabled={promoting} onClick={onConvert}>
            {promoting ? "Converting…" : "Convert to PO"}
          </Btn>
        )}
        {row.hasPdf && (
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
    ["Expected", detail.expectedAt ? shortDateYear(detail.expectedAt) : "—"],
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

/** Remaining-to-receive prefill per line. Lines whose variant was deleted
 *  can't be received (the server refuses), so they prefill 0 — shared by the
 *  receive panel's open and its "Receive all". */
function remainingQtys(detail: PoDetailVM): Record<string, string> {
  const qtys: Record<string, string> = {};
  for (const line of detail.lines) {
    qtys[line.id] = String(
      line.variantId == null ? 0 : Math.max(0, line.qtyOrdered - line.qtyReceived),
    );
  }
  return qtys;
}

/** All drawer-scoped state, reset as one unit at open/close so nothing (like
 *  receive quantities) can leak from one PO into another. */
interface DrawerState {
  poId: string | null;
  detail: PoDetailVM | null;
  error: string | null;
  receiveOpen: boolean;
  receiveQtys: Record<string, string>;
  /** One receive SUBMISSION id: generated when the receive panel opens and
   *  reused if the same submission is retried, so the server treats a replay
   *  as a no-op instead of double-counting stock. */
  receiptId: string | null;
  confirmCancel: boolean;
  busy: string | null;
}

const DRAWER_CLOSED: DrawerState = {
  poId: null,
  detail: null,
  error: null,
  receiveOpen: false,
  receiveQtys: {},
  receiptId: null,
  confirmCancel: false,
  busy: null,
};

export default function PurchaseOrders({ app }: { app: DashboardCtx }) {
  // Seeded from the session cache so a return visit paints instantly; the
  // mount fetch below revalidates and writes back through. Only the default
  // offset-0 payload touches the cache — paged-in rows stay local.
  const seeded = cachedScreenData<PoScreenData>(SCREEN_CACHE_KEYS.po);
  const seededDrafts = cachedScreenData<{ rows: PurchaseOrderVM[]; total: number }>(
    SCREEN_CACHE_KEYS.purchaseOrders,
  );
  const [pos, setPos] = useState<PoListItemVM[] | null>(() => seeded?.pos ?? null);
  const [total, setTotal] = useState(() => seeded?.total ?? 0);
  const [suppliers, setSuppliers] = useState<SupplierVM[]>(() => seeded?.suppliers ?? []);
  const [promotedIds, setPromotedIds] = useState<Set<string>>(
    () => new Set(seeded?.promotedAuditIds ?? []),
  );
  const [loading, setLoading] = useState(() => !seeded);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [staleWarning, setStaleWarning] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Legacy Autopilot drafts (audit rows) for the section below the PO table.
  const [drafts, setDrafts] = useState<PurchaseOrderVM[] | null>(
    () => seededDrafts?.rows ?? null,
  );
  const [draftsTotal, setDraftsTotal] = useState(() => seededDrafts?.total ?? 0);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [loadingMoreDrafts, setLoadingMoreDrafts] = useState(false);
  const [promoting, setPromoting] = useState<string | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PoDetailVM | null>(null);
  const [suppliersOpen, setSuppliersOpen] = useState(false);
  // "all" = no filter; anything else narrows the server-side list (the filter
  // is a po_list predicate, so paging + totals stay honest within a status).
  // loadedFilter tracks which filter the rows in `pos` belong to, so the UI
  // never renders one filter's rows under another filter's selected segment.
  const [statusFilter, setStatusFilter] = useState<PoStatusVM | "all">("all");
  const [loadedFilter, setLoadedFilter] = useState<PoStatusVM | "all">("all");
  const loadedFilterRef = useRef(loadedFilter);
  const statusFilterRef = useRef(statusFilter);
  statusFilterRef.current = statusFilter;

  // Drawer state (one object — see DrawerState). poId is set on row click;
  // the detail loads after.
  const [drawer, setDrawer] = useState<DrawerState>(DRAWER_CLOSED);

  const toast = app.toast;
  const posRef = useRef(pos);
  posRef.current = pos;

  useEffect(() => {
    let alive = true;
    if (!posRef.current) setLoading(true);
    void (async () => {
      // The legacy drafts load first: their audit ids are what the main
      // payload's promoted-draft filter is scoped to (bounded, never the
      // unbounded promoted list). The two still fail independently.
      let auditIds: string[] = [];
      try {
        const legacy = await fetchPurchaseOrders({});
        if (!alive) return;
        cacheScreenData(SCREEN_CACHE_KEYS.purchaseOrders, legacy);
        setDrafts(legacy.rows);
        setDraftsTotal(legacy.total);
        setDraftsError(null);
        auditIds = legacy.rows.map((r) => r.id);
      } catch (err) {
        if (!alive) return;
        setDraftsError(
          err instanceof DashboardApiError ? err.message : "Couldn't load Autopilot drafts.",
        );
      }
      try {
        const status = statusFilter === "all" ? undefined : statusFilter;
        const main = await fetchPoScreen(auditIds, status);
        if (!alive) return;
        // Only the unfiltered offset-0 payload is the cache contract's shape —
        // a filtered list must never seed the next visit.
        if (!status) cacheScreenData(SCREEN_CACHE_KEYS.po, main);
        loadedFilterRef.current = statusFilter;
        setLoadedFilter(statusFilter);
        setPos(main.pos);
        setTotal(main.total);
        setSuppliers(main.suppliers);
        // Only replace the promoted set when it was computed against real
        // draft ids — after a drafts failure it would be empty and would
        // resurrect converted drafts still seeded from the cache.
        if (auditIds.length) setPromotedIds(new Set(main.promotedAuditIds));
        setStaleWarning(false);
        setLoadError(null);
      } catch (err) {
        if (!alive) return;
        if (posRef.current && loadedFilterRef.current === statusFilter) {
          setStaleWarning(true);
        } else {
          // Either nothing is loaded yet, or the rows on screen belong to a
          // DIFFERENT filter — showing them under this segment would misread
          // as matches, so drop to the error state instead.
          setPos(null);
          loadedFilterRef.current = statusFilter;
          setLoadedFilter(statusFilter);
          setLoadError(
            err instanceof DashboardApiError ? err.message : "Couldn't load purchase orders.",
          );
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey, statusFilter]);

  /** Full refetch — only for mutations that ADD rows (create, convert). New
   *  rows land as drafts, so jump back to the unfiltered view first or the
   *  just-created PO would be invisible under an active filter. Drawer
   *  actions patch the affected row in place instead (patchPo). */
  const reload = useCallback(() => {
    setStatusFilter("all");
    setReloadKey((k) => k + 1);
  }, []);

  /** Write a mutated PO back into the list + screen cache from the returned
   *  detail — every list field is on the detail, so no refetch and no
   *  collapse of paged-in rows. */
  const patchPo = useCallback(
    (updated: PoDetailVM) => {
      const item: PoListItemVM = {
        id: updated.id,
        poNumber: updated.poNumber,
        supplierName: updated.supplierName,
        destinationName: updated.destinationName,
        status: updated.status,
        expectedAt: updated.expectedAt,
        source: updated.source,
        lineCount: updated.lineCount,
        unitsOrdered: updated.unitsOrdered,
        unitsReceived: updated.unitsReceived,
        totalCents: updated.totalCents,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      };
      // A status-changing action (mark ordered, cancel) moves the row out of a
      // narrowed view — drop it and keep the "x of total" label honest. The
      // rows on screen belong to loadedFilter (not the possibly-mid-switch
      // statusFilter), so that is the predicate to judge against.
      const filter = loadedFilterRef.current;
      const drops =
        filter !== "all" &&
        item.status !== filter &&
        (posRef.current?.some((p) => p.id === item.id) ?? false);
      setPos((cur) => {
        if (!cur) return cur;
        const next = cur.map((p) => (p.id === item.id ? item : p));
        return drops ? next.filter((p) => p.id !== item.id) : next;
      });
      if (drops) setTotal((t) => Math.max(0, t - 1));
      // The cache always holds the unfiltered payload, so the row is updated
      // there regardless of the active filter.
      const cached = cachedScreenData<PoScreenData>(SCREEN_CACHE_KEYS.po);
      if (cached?.pos.some((p) => p.id === item.id)) {
        cacheScreenData(SCREEN_CACHE_KEYS.po, {
          ...cached,
          pos: cached.pos.map((p) => (p.id === item.id ? item : p)),
        });
      }
    },
    [],
  );

  const loadMore = async () => {
    if (!pos) return;
    setLoadingMore(true);
    try {
      const page = await fetchPoPage(pos.length, statusFilter === "all" ? undefined : statusFilter);
      // The filter changed while this page was in flight — its rows belong to
      // the previous filter's universe, so appending them would corrupt the
      // narrowed list (and its total).
      if (statusFilterRef.current !== statusFilter) return;
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

  const loadMoreDrafts = async () => {
    if (!drafts) return;
    setLoadingMoreDrafts(true);
    try {
      const page = await fetchPurchaseOrders({ offset: drafts.length });
      // De-dupe by id: a draft created between pages shifts the window, so a
      // paged-in row may already be shown (avoids duplicate keys).
      setDrafts((cur) => {
        const current = cur ?? [];
        const seen = new Set(current.map((d) => d.id));
        return [...current, ...page.rows.filter((d) => !seen.has(d.id))];
      });
      setDraftsTotal(page.total);
    } catch (err) {
      toast(
        err instanceof DashboardApiError ? err.message : "Couldn't load more drafts.",
        "warn",
        "critical",
      );
    } finally {
      setLoadingMoreDrafts(false);
    }
  };

  // ---- drawer plumbing -------------------------------------------------------

  const openPo = (poId: string) => setDrawer({ ...DRAWER_CLOSED, poId });
  const closeDrawer = useCallback(() => setDrawer(DRAWER_CLOSED), []);

  const drawerDetailId = drawer.detail?.id ?? null;
  useEffect(() => {
    const poId = drawer.poId;
    if (!poId) return;
    if (drawerDetailId === poId) return; // already delivered (e.g. convert)
    let alive = true;
    fetchPoDetail(poId)
      .then((d) => {
        if (alive) setDrawer((cur) => (cur.poId === poId ? { ...cur, detail: d } : cur));
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setDrawer((cur) =>
          cur.poId === poId
            ? {
                ...cur,
                error:
                  err instanceof DashboardApiError
                    ? err.message
                    : "Couldn't load the purchase order.",
              }
            : cur,
        );
      });
    return () => {
      alive = false;
    };
  }, [drawer.poId, drawerDetailId]);

  // Escape closes, first control focuses, Tab cycles inside — shared chrome.
  // Bubble-phase Escape: a PoModal stacked on top swallows it in capture.
  const { ref: drawerRef, onKeyDown: onDrawerKeyDown } = useModalChrome<HTMLDivElement>({
    onClose: closeDrawer,
    enabled: drawer.poId != null,
    escape: "bubble",
  });

  // ---- actions -----------------------------------------------------------------

  const runAction = async (
    key: string,
    fn: () => Promise<PoDetailVM>,
    successMessage: string,
  ) => {
    if (drawer.busy) return;
    setDrawer((cur) => ({ ...cur, busy: key }));
    try {
      const updated = await fn();
      setDrawer((cur) =>
        cur.poId === updated.id
          ? {
              ...cur,
              detail: updated,
              receiveOpen: false,
              receiveQtys: {},
              receiptId: null,
              confirmCancel: false,
            }
          : cur,
      );
      patchPo(updated);
      toast(successMessage, "check");
    } catch (err) {
      toast(
        err instanceof DashboardApiError ? err.message : "That didn't go through — try again.",
        "warn",
        "critical",
      );
    } finally {
      setDrawer((cur) => ({ ...cur, busy: null }));
    }
  };

  const startReceive = () => {
    setDrawer((cur) =>
      cur.detail
        ? {
            ...cur,
            receiveOpen: true,
            receiveQtys: remainingQtys(cur.detail),
            receiptId: crypto.randomUUID(),
          }
        : cur,
    );
  };

  const receiveAll = () => {
    setDrawer((cur) =>
      cur.detail ? { ...cur, receiveQtys: remainingQtys(cur.detail) } : cur,
    );
  };

  const submitReceive = () => {
    const { detail, receiveQtys, receiptId } = drawer;
    if (!detail || !receiptId) return;
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
    void runAction(
      "receive",
      () => receivePoLines(detail.id, entries, receiptId),
      "Stock received.",
    );
  };

  const onConvertDraft = (auditId: string) => {
    if (promoting) return;
    setPromoting(auditId);
    promotePoDraft(auditId)
      .then((po) => {
        toast("Converted to a purchase order.", "check");
        setPromotedIds((cur) => new Set([...cur, auditId]));
        reload();
        setDrawer({ ...DRAWER_CLOSED, poId: po.id, detail: po });
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
  // The rows in state belong to a different filter than the selected segment
  // (a switch is in flight) — show the skeleton rather than mislabeled rows.
  const filterPending = pos != null && loadedFilter !== statusFilter;
  const detail = drawer.detail;

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
        {pos && (shown.length > 0 || statusFilter !== "all") && (
          <div style={{ padding: "12px 16px 4px" }}>
            <Segmented
              small
              value={statusFilter}
              onChange={(next) => setStatusFilter(next as PoStatusVM | "all")}
              options={FILTER_OPTIONS}
            />
          </div>
        )}
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
        ) : filterPending ? (
          <TableSkeleton />
        ) : shown.length === 0 ? (
          statusFilter !== "all" ? (
            <Placeholder
              icon="doc"
              title="No purchase orders in this status"
              sub="Switch back to All to see every purchase order."
            />
          ) : (
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
          )
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
                  {row.expectedAt ? shortDateYear(row.expectedAt) : "—"}
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

      {!loadError && pos && !filterPending && pos.length < total && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          <Btn disabled={loadingMore} onClick={() => { void loadMore(); }}>
            {loadingMore ? "Loading…" : `Load more (${pos.length} of ${total})`}
          </Btn>
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <SectionTitle>Autopilot drafts</SectionTitle>
        <Card pad={false}>
          {draftsError && drafts == null ? (
            <Placeholder icon="warn" title="Drafts unavailable" sub={draftsError} />
          ) : drafts == null ? (
            <TableSkeleton rows={3} />
          ) : visibleDrafts.length === 0 ? (
            <>
              <Placeholder
                icon="doc"
                title="No restock drafts"
                sub="When Calderyn drafts a PO from an inventory alert it lands here, ready to convert."
              />
              <div className="flex justify-center" style={{ paddingBottom: 28 }}>
                <Btn small icon="bell" onClick={() => app.navigate("alerts")}>
                  View alerts
                </Btn>
              </div>
            </>
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
        {!draftsError && drafts && drafts.length < draftsTotal && (
          <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
            <Btn disabled={loadingMoreDrafts} onClick={() => { void loadMoreDrafts(); }}>
              {loadingMoreDrafts ? "Loading…" : `Load more (${drafts.length} of ${draftsTotal})`}
            </Btn>
          </div>
        )}
      </div>

      {drawer.poId && (
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

              {drawer.error ? (
                <Placeholder icon="warn" title="Couldn't load this PO" sub={drawer.error} />
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
                                {line.sku ?? line.title ?? "Deleted product"}
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
                            {drawer.receiveOpen && (
                              <input
                                className="cd-input tabular-nums"
                                type="number"
                                min={0}
                                max={remaining}
                                aria-label={`Receive quantity for ${line.sku ?? line.title ?? "line"}`}
                                style={{ width: 76, flexShrink: 0 }}
                                value={drawer.receiveQtys[line.id] ?? ""}
                                onChange={(e) =>
                                  setDrawer((cur) => ({
                                    ...cur,
                                    receiveQtys: { ...cur.receiveQtys, [line.id]: e.target.value },
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

                  {drawer.receiveOpen ? (
                    <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
                      <Btn small onClick={receiveAll}>Receive all</Btn>
                      <div style={{ flex: 1 }} />
                      <Btn
                        small
                        onClick={() => setDrawer((cur) => ({ ...cur, receiveOpen: false }))}
                        disabled={drawer.busy != null}
                      >
                        Back
                      </Btn>
                      <Btn
                        small
                        kind="primary"
                        icon="check"
                        disabled={drawer.busy != null}
                        onClick={submitReceive}
                      >
                        {drawer.busy === "receive" ? "Receiving…" : "Receive"}
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
                          disabled={drawer.busy != null}
                          onClick={() => {
                            void runAction(
                              "order",
                              () => markPoOrdered(detail.id),
                              "Marked as ordered — stock is now expected.",
                            );
                          }}
                        >
                          {drawer.busy === "order" ? "Ordering…" : "Mark ordered"}
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
                        (drawer.confirmCancel ? (
                          <>
                            <Btn
                              small
                              onClick={() =>
                                setDrawer((cur) => ({ ...cur, confirmCancel: false }))
                              }
                            >
                              Keep it
                            </Btn>
                            <Btn
                              small
                              kind="danger"
                              disabled={drawer.busy != null}
                              onClick={() => {
                                void runAction(
                                  "cancel",
                                  () => cancelPo(detail.id),
                                  "Purchase order cancelled.",
                                );
                              }}
                            >
                              {drawer.busy === "cancel" ? "Cancelling…" : "Confirm cancel"}
                            </Btn>
                          </>
                        ) : (
                          <Btn
                            small
                            icon="x"
                            onClick={() => setDrawer((cur) => ({ ...cur, confirmCancel: true }))}
                          >
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
            setDrawer({ ...DRAWER_CLOSED, poId: po.id, detail: po });
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
            patchPo(po);
            setDrawer((cur) => (cur.poId === po.id ? { ...cur, detail: po } : cur));
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
