import { useEffect, useMemo, useRef, useState } from "react";
import { Btn, Card, Pill, Placeholder, SectionTitle, TableSkeleton } from "../ui";
import {
  OrderSortHeader,
  nextSortState,
  useSortedRowsEntrance,
} from "./OrderListFamily";
import { timeAgo } from "../format";
import { DashboardApiError, receiveTransfer } from "~/lib/dashboard/client";
import {
  fetchAllPendingTransfers,
  fetchReceivedTransfers,
  type ShopTransferVM,
} from "~/lib/dashboard/transfers-client";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import TransferModal from "./TransferModal";
import type { DashboardCtx } from "../context";

// Shop-wide view of in-transit stock moves plus a 30-day received history.
// The transfer GET only returns state=in_transit rows for the pending card,
// so every row there is receivable; receiving lands the units in on_hand at
// the destination and moves the row to the history card on the next load.

const GRID = "1fr 1.4fr 0.7fr 1.4fr 1.1fr";

/** Both transfer tables default to the server's newest-first order, which no
 *  column represents — the header cycle returns to it on a third click. */
const DEFAULT_TRANSFER_SORT = { sort: "default", dir: "desc" } as const;

/** The label the SKU / variant column actually renders, so sorting matches what
 *  the merchant reads rather than the underlying field precedence. */
function variantLabel(row: ShopTransferVM): string {
  return row.sku ?? row.variantTitle ?? row.variantId;
}

function compareTransfers(
  a: ShopTransferVM,
  b: ShopTransferVM,
  sort: string,
  dir: "asc" | "desc",
): number {
  const mul = dir === "asc" ? 1 : -1;
  // ISO timestamps compare correctly as strings. Newest-first is the tiebreak on
  // every column so equal-valued rows keep one stable order.
  const byRecency = b.createdAt.localeCompare(a.createdAt);
  switch (sort) {
    case "transfer":
      // The column shows the short id over its age, so it sorts by age — the
      // part a merchant can actually reason about.
      return mul * a.createdAt.localeCompare(b.createdAt);
    case "sku":
      return mul * variantLabel(a).localeCompare(variantLabel(b)) || byRecency;
    case "qty":
      return mul * (a.qty - b.qty) || byRecency;
    case "route":
      return (
        mul * `${a.fromName} → ${a.toName}`.localeCompare(`${b.fromName} → ${b.toName}`) ||
        byRecency
      );
    case "status":
      // Each table holds a single state (in transit / received), so Status
      // orders by when that state was reached.
      return mul * (a.receivedAt ?? a.createdAt).localeCompare(b.receivedAt ?? b.createdAt);
    default:
      return 0;
  }
}

function VariantCell({ row }: { row: ShopTransferVM }) {
  if (row.sku) {
    return (
      <div className="min-w-0">
        <div className="cd-row-title truncate">{row.sku}</div>
        {row.variantTitle && <div className="cd-caption truncate">{row.variantTitle}</div>}
      </div>
    );
  }
  if (row.variantTitle) {
    return <div className="cd-row-title truncate">{row.variantTitle}</div>;
  }
  // No label survived the join — show the real id, clearly marked as one.
  return (
    <div className="min-w-0">
      <div className="cd-row-title tabular-nums truncate">{row.variantId.slice(0, 8)}</div>
      <div className="cd-caption">Variant id</div>
    </div>
  );
}

export default function Transfers({ app }: { app: DashboardCtx }) {
  // Seeded from the session cache so a return visit paints instantly; the
  // mount fetch below revalidates and writes back through.
  const [rows, setRows] = useState<ShopTransferVM[] | null>(() =>
    cachedScreenData<ShopTransferVM[]>(SCREEN_CACHE_KEYS.transfers),
  );
  const [received, setReceived] = useState<ShopTransferVM[] | null>(null);
  const [receivedError, setReceivedError] = useState<string | null>(null);
  // First-load failure with nothing to show — rendered in the card so the API
  // message isn't lost to a transient toast.
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Set when a reload fails but stale rows are still on screen, so the list
  // stays useful without pretending it's fresh.
  const [staleWarning, setStaleWarning] = useState(false);
  const [receiving, setReceiving] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Bumped after a successful receive/create so the effect re-pulls the lists.
  const [reloadKey, setReloadKey] = useState(0);
  // The two tables sort independently — they answer different questions.
  const [pendingSort, setPendingSort] = useState<{ sort: string; dir: "asc" | "desc" }>(
    DEFAULT_TRANSFER_SORT,
  );
  const [receivedSort, setReceivedSort] = useState<{ sort: string; dir: "asc" | "desc" }>(
    DEFAULT_TRANSFER_SORT,
  );
  const toast = app.toast;

  // Latest rows, readable inside the async load without re-running the effect.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    // Both lists load together but fail independently — one failing must not
    // blank the other, so each result is handled on its own.
    void Promise.allSettled([fetchAllPendingTransfers(), fetchReceivedTransfers()]).then(
      ([pending, hist]) => {
        if (!alive) return;
        if (pending.status === "fulfilled") {
          cacheScreenData(SCREEN_CACHE_KEYS.transfers, pending.value);
          setRows(pending.value);
          setStaleWarning(false);
          setPendingError(null);
        } else if (rowsRef.current) {
          setStaleWarning(true);
        } else {
          setPendingError(
            pending.reason instanceof DashboardApiError
              ? pending.reason.message
              : "Could not load transfers.",
          );
        }
        if (hist.status === "fulfilled") {
          setReceived(hist.value);
          setReceivedError(null);
        } else {
          setReceivedError(
            hist.reason instanceof DashboardApiError
              ? hist.reason.message
              : "Could not load received transfers.",
          );
        }
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const onReceive = async (transferId: string) => {
    if (receiving) return;
    setReceiving(transferId);
    try {
      await receiveTransfer(transferId);
      toast("Received into stock.", "check");
      setReloadKey((k) => k + 1);
    } catch (err) {
      const msg =
        err instanceof DashboardApiError ? err.message : "Couldn't receive the transfer.";
      toast(msg, "warn", "critical");
    } finally {
      setReceiving(null);
    }
  };

  const shownPending = useMemo(() => {
    const list = rows ?? [];
    if (pendingSort.sort === "default") return list;
    return [...list].sort((a, b) => compareTransfers(a, b, pendingSort.sort, pendingSort.dir));
  }, [rows, pendingSort]);

  const shownReceived = useMemo(() => {
    const list = received ?? [];
    if (receivedSort.sort === "default") return list;
    return [...list].sort((a, b) => compareTransfers(a, b, receivedSort.sort, receivedSort.dir));
  }, [received, receivedSort]);

  const pendingHeaderSort = {
    sort: pendingSort.sort,
    dir: pendingSort.dir,
    onSort: (col: string) =>
      setPendingSort((cur) => nextSortState(cur, col, DEFAULT_TRANSFER_SORT)),
  };
  const receivedHeaderSort = {
    sort: receivedSort.sort,
    dir: receivedSort.dir,
    onSort: (col: string) =>
      setReceivedSort((cur) => nextSortState(cur, col, DEFAULT_TRANSFER_SORT)),
  };

  const pendingListRef = useRef<HTMLDivElement>(null);
  useSortedRowsEntrance(pendingListRef, shownPending.map((r) => r.id).join("|"), [
    rows,
    pendingSort,
  ]);
  const receivedListRef = useRef<HTMLDivElement>(null);
  useSortedRowsEntrance(receivedListRef, shownReceived.map((r) => r.id).join("|"), [
    received,
    receivedSort,
  ]);

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Products">
        <div>
          <h1 className="cd-h1">Products</h1>
          <p className="cd-sub">Stock transfers</p>
        </div>
        <Btn kind="primary" icon="swap" onClick={() => setCreating(true)}>
          New transfer
        </Btn>
      </header>

      <Card pad={false}>
        {staleWarning && rows && (
          <div
            className="cd-caption"
            style={{ padding: "8px 16px", color: "var(--orange)" }}
          >
            Couldn&apos;t refresh just now — showing the last loaded list.
          </div>
        )}
        {!rows ? (
          loading ? (
            <TableSkeleton />
          ) : (
            <Placeholder
              icon="warn"
              title="Couldn't load transfers"
              sub={pendingError ?? "Could not load transfers just now. Refresh to try again."}
            />
          )
        ) : rows.length === 0 ? (
          <>
            <Placeholder
              icon="truck"
              title="No transfers in flight"
              sub="Moves marked in transit land here until received."
            />
            <div className="flex justify-center" style={{ paddingBottom: 28 }}>
              <Btn small icon="swap" onClick={() => setCreating(true)}>
                New transfer
              </Btn>
            </div>
          </>
        ) : (
          // Five columns can't compress into a phone width — the table pans
          // sideways inside the card instead of crushing every cell.
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 620 }}>
            <div className="cd-tablehd" style={{ gridTemplateColumns: GRID }}>
              <OrderSortHeader label="Transfer" col="transfer" {...pendingHeaderSort} />
              <OrderSortHeader label="SKU / variant" col="sku" {...pendingHeaderSort} />
              <OrderSortHeader label="Qty" col="qty" {...pendingHeaderSort} />
              <OrderSortHeader label="Route" col="route" {...pendingHeaderSort} />
              <OrderSortHeader label="Status" col="status" {...pendingHeaderSort} />
            </div>
            <div ref={pendingListRef}>
            {shownPending.map((r) => (
              <div key={r.id} className="cd-trow" style={{ gridTemplateColumns: GRID }}>
                <div className="min-w-0">
                  <div className="cd-row-title tabular-nums truncate">
                    {r.id.slice(0, 8).toUpperCase()}
                  </div>
                  <div className="cd-caption">{timeAgo(r.createdAt)}</div>
                </div>
                <VariantCell row={r} />
                <div className="cd-row-num tabular-nums">{r.qty}</div>
                <div className="cd-caption truncate">
                  {r.fromName} → {r.toName}
                </div>
                <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
                  <Pill tone="accent" icon="truck">
                    In transit
                  </Pill>
                  <Btn
                    small
                    icon="check"
                    disabled={receiving === r.id}
                    onClick={() => {
                      void onReceive(r.id);
                    }}
                  >
                    {receiving === r.id ? "Receiving…" : "Mark received"}
                  </Btn>
                </div>
              </div>
            ))}
            </div>
            </div>
          </div>
        )}
      </Card>

      <div style={{ marginTop: 20 }}>
        <SectionTitle>Recently received</SectionTitle>
        <Card pad={false}>
          {receivedError ? (
            <Placeholder icon="warn" title="History unavailable" sub={receivedError} />
          ) : received == null ? (
            <TableSkeleton rows={3} />
          ) : received.length === 0 ? (
            <Placeholder
              icon="truck"
              title="Nothing received yet"
              sub="Transfers you mark received show here for 30 days."
            />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <div style={{ minWidth: 620 }}>
              <div className="cd-tablehd" style={{ gridTemplateColumns: GRID }}>
                <OrderSortHeader label="Transfer" col="transfer" {...receivedHeaderSort} />
                <OrderSortHeader label="SKU / variant" col="sku" {...receivedHeaderSort} />
                <OrderSortHeader label="Qty" col="qty" {...receivedHeaderSort} />
                <OrderSortHeader label="Route" col="route" {...receivedHeaderSort} />
                <OrderSortHeader label="Status" col="status" {...receivedHeaderSort} />
              </div>
              <div ref={receivedListRef}>
              {shownReceived.map((r) => (
                <div key={r.id} className="cd-trow" style={{ gridTemplateColumns: GRID }}>
                  <div className="min-w-0">
                    <div className="cd-row-title tabular-nums truncate">
                      {r.id.slice(0, 8).toUpperCase()}
                    </div>
                    <div className="cd-caption">{timeAgo(r.createdAt)}</div>
                  </div>
                  <VariantCell row={r} />
                  <div className="cd-row-num tabular-nums">{r.qty}</div>
                  <div className="cd-caption truncate">
                    {r.fromName} → {r.toName}
                  </div>
                  <div>
                    <Pill tone="success" icon="check">
                      {r.receivedAt ? `Received ${timeAgo(r.receivedAt)}` : "Received"}
                    </Pill>
                  </div>
                </div>
              ))}
              </div>
              </div>
            </div>
          )}
        </Card>
      </div>

      {creating && (
        <TransferModal
          app={app}
          onClose={() => setCreating(false)}
          onDone={() => setReloadKey((k) => k + 1)}
        />
      )}
    </div>
  );
}
