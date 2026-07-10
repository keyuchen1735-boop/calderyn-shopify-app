import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Btn, Card, Pill, Placeholder, TableSkeleton, Tooltip } from "../ui";
import { money, timeAgo } from "../format";
import { DashboardApiError } from "~/lib/dashboard/client";
import {
  fetchImportedOrders,
  fetchOrdersPage,
  type ImportedOrdersPage,
  type OrderRow,
  type OrdersPage,
} from "~/lib/dashboard/orders-client";
import type { ImportedOrderRow } from "~/lib/order/imported-list-types";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import type { DashboardCtx } from "../context";
import RefundModal from "./RefundModal";
import OrderDetailScreen from "./OrderDetail";
import { fulfillmentBadge, paymentPillStyle, REFUNDABLE_ORDER_STATES } from "./order-status";

// Migrated Shopify orders whose money was captured at Shopify: Calderyn can't
// reverse that charge, so the merchant is told, plainly, to refund it in Shopify.
const SHOPIFY_REFUND_HINT_STATES = new Set(["paid", "partially_refunded", "partially_paid"]);

function PaymentPill({ status }: { status: string }) {
  const s = paymentPillStyle(status);
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

// One display row across both origins: native Calderyn orders and migrated
// Shopify orders render in a single unified list, newest first.
type DisplayOrder = {
  id: string;
  ref: string;
  createdAt: string | null;
  customer: string | null;
  totalCents: number;
  currency: string;
  // Native: the OrderState lifecycle enum (paid/partially_fulfilled/fulfilled/cancelled/...) —
  // drives the Fulfillment badge. Imported: the same value as financialStatus (Shopify never
  // hands this surface a separate lifecycle state), so its Fulfillment badge is always skipped.
  state: string;
  // financial_status vocabulary (paid/refunded/partially_refunded/...) — drives the Payment pill
  // for BOTH origins.
  financialStatus: string;
  source: "calderyn" | "shopify";
  // The native OrderRow (for the refund modal) when this row is a Calderyn
  // order; null for migrated orders (their money lives at Shopify).
  refundRow: OrderRow | null;
};

/** `orders/<sourceId>` id for a display row — `shopify:`-prefixed for migrated orders, matching
 *  the prefix loadOrderDetail (detail.server.ts) and the write routes expect. */
function displayOrderSourceId(r: DisplayOrder): string {
  return r.source === "shopify" ? `shopify:${r.id}` : r.id;
}

function mergeOrders(native: OrderRow[] | null, imported: ImportedOrderRow[] | null): DisplayOrder[] {
  const rows: DisplayOrder[] = [];
  for (const o of native ?? []) {
    rows.push({
      id: o.id,
      ref: o.ref,
      createdAt: o.createdAt,
      customer: o.buyerEmail,
      totalCents: o.totalCents,
      currency: o.currency,
      state: o.state,
      financialStatus: o.financialStatus,
      source: "calderyn",
      refundRow: o,
    });
  }
  for (const o of imported ?? []) {
    rows.push({
      id: o.id,
      ref: o.ref,
      createdAt: o.processedAt,
      customer: null,
      totalCents: o.totalCents,
      currency: o.currency,
      state: o.financialStatus,
      financialStatus: o.financialStatus,
      source: "shopify",
      refundRow: null,
    });
  }
  rows.sort((a, b) => {
    const at = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bt - at;
  });
  return rows;
}

// The visible list is bounded; the merged history can be thousands of orders.
const ORDERS_VISIBLE = 100;

function UnifiedOrdersList({
  native,
  imported,
  totalCount,
  loading,
  onRefund,
  onOpen,
}: {
  native: OrderRow[] | null;
  imported: ImportedOrderRow[] | null;
  totalCount: number;
  loading: boolean;
  onRefund: (order: OrderRow) => void;
  onOpen: (sourceId: string) => void;
}) {
  if (native == null && imported == null) {
    return (
      <Card pad={false}>
        {loading ? (
          <TableSkeleton />
        ) : (
          <Placeholder
            icon="doc"
            title="Orders unavailable"
            sub="Could not load orders just now. Refresh to try again."
          />
        )}
      </Card>
    );
  }

  const merged = mergeOrders(native, imported);
  if (merged.length === 0) {
    return (
      <Card pad={false}>
        <Placeholder
          icon="doc"
          title="No orders yet"
          sub="Orders from your storefront and from AI shopping assistants land here."
        />
      </Card>
    );
  }

  const shown = merged.slice(0, ORDERS_VISIBLE);
  const cols = "1fr 1.2fr 0.9fr 0.9fr 0.9fr 1fr auto";
  return (
    <Card pad={false}>
      <div className="cd-tablehd" style={{ gridTemplateColumns: cols }}>
        <span>Order</span>
        <span>Customer</span>
        <span>Total</span>
        <span>Date</span>
        <span>Payment</span>
        <span>Fulfillment</span>
        <span />
      </div>
      {shown.map((r) => {
        const refundable = r.refundRow && REFUNDABLE_ORDER_STATES.has(r.state) ? r.refundRow : null;
        const fulfillment = r.source === "calderyn" ? fulfillmentBadge(r.state, null) : null;
        const open = () => onOpen(displayOrderSourceId(r));
        return (
          <div
            key={`${r.source}:${r.id}`}
            className="cd-trow"
            style={{ gridTemplateColumns: cols, cursor: "pointer" }}
            role="button"
            tabIndex={0}
            onClick={open}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                open();
              }
            }}
          >
            <div>
              <div className="cd-row-title tabular-nums">{r.ref}</div>
              {r.source === "shopify" && <div className="cd-caption">Shopify</div>}
            </div>
            <div className="truncate">{r.customer ?? (r.source === "shopify" ? "" : "Guest")}</div>
            <div className="cd-row-num tabular-nums">{money(r.totalCents, r.currency)}</div>
            <div className="cd-caption">{r.createdAt ? timeAgo(r.createdAt) : ""}</div>
            <div>
              <PaymentPill status={r.financialStatus} />
            </div>
            <div>
              {fulfillment && (
                <span className="cd-badge" style={{ color: fulfillment.tone, background: "var(--gray-bg)" }}>
                  {fulfillment.label}
                </span>
              )}
            </div>
            <div
              style={{ display: "flex", justifyContent: "flex-end" }}
              onClick={(e) => e.stopPropagation()}
            >
              {refundable ? (
                <Btn small icon="rotate" onClick={() => onRefund(refundable)}>
                  Refund
                </Btn>
              ) : r.source === "shopify" && SHOPIFY_REFUND_HINT_STATES.has(r.state) ? (
                <Tooltip content="This order was paid through Shopify. To refund it, issue the refund from your Shopify admin.">
                  <span className="cd-caption" style={{ cursor: "help" }}>
                    Refund in Shopify
                  </span>
                </Tooltip>
              ) : null}
            </div>
          </div>
        );
      })}
      {totalCount > shown.length && (
        <div className="cd-caption" style={{ padding: "10px 16px", textAlign: "center" }}>
          Showing the most recent {shown.length.toLocaleString("en-US")} of{" "}
          {totalCount.toLocaleString("en-US")} orders.
        </div>
      )}
    </Card>
  );
}

export default function Orders({ app }: { app: DashboardCtx }) {
  // Seeded from the session cache so a return visit paints the last page
  // instantly; the mount fetch below revalidates and writes back through.
  const [page, setPage] = useState<OrdersPage | null>(() =>
    cachedScreenData<OrdersPage>(SCREEN_CACHE_KEYS.orders),
  );
  const [loading, setLoading] = useState(true);
  const [refundOrder, setRefundOrder] = useState<OrderRow | null>(null);
  // Migrated Shopify order history, merged into the main list so the Orders
  // screen shows the whole store as one continuous history.
  const [imported, setImported] = useState<ImportedOrdersPage | null>(() =>
    cachedScreenData<ImportedOrdersPage>(SCREEN_CACHE_KEYS.importedOrders),
  );
  const [importedLoading, setImportedLoading] = useState(imported === null);
  const toast = app.toast;

  const load = useCallback(
    (signal?: { alive: boolean }) => {
      setLoading(true);
      fetchOrdersPage()
        .then((p) => {
          cacheScreenData(SCREEN_CACHE_KEYS.orders, p);
          if (!signal || signal.alive) setPage(p);
        })
        .catch((err: unknown) => {
          if (signal && !signal.alive) return;
          const msg = err instanceof DashboardApiError ? err.message : "Could not load orders.";
          toast(msg, "warn", "critical");
        })
        .finally(() => {
          if (!signal || signal.alive) setLoading(false);
        });
    },
    [toast],
  );

  useEffect(() => {
    const signal = { alive: true };
    load(signal);
    return () => {
      signal.alive = false;
    };
  }, [load]);

  // Load migrated order history on mount (revalidating any warm-cache seed) so
  // it merges into the main list. Its own failure is non-critical: the native
  // orders still render, so this only warns, it never blanks the screen.
  useEffect(() => {
    const signal = { alive: true };
    fetchImportedOrders()
      .then((p) => {
        cacheScreenData(SCREEN_CACHE_KEYS.importedOrders, p);
        if (signal.alive) setImported(p);
      })
      .catch(() => {
        /* migrated history is additive; native orders own the error UX */
      })
      .finally(() => {
        if (signal.alive) setImportedLoading(false);
      });
    return () => {
      signal.alive = false;
    };
  }, []);

  // Order-detail actions (fulfill/cancel/refund/archive) mutate the native list this screen
  // already holds in memory, so a plain return-to-list doesn't see the change until a refetch.
  // Rather than thread an onChanged callback through every modal on the detail screen, this
  // component (which owns `load`) just refetches the moment nav.param goes from "viewing an
  // order" back to null — i.e. on the Back button, wherever the visit came from.
  const wasViewingOrder = useRef(false);
  useEffect(() => {
    if (app.nav.param) {
      wasViewingOrder.current = true;
      return;
    }
    if (wasViewingOrder.current) {
      wasViewingOrder.current = false;
      load();
    }
  }, [app.nav.param, load]);

  const sub = app.nav.sub ?? "orders";

  // Unified order count = native rows shown + the true migrated total. The
  // subtab navigation lives in the sidebar rail; this screen renders the view
  // for the active sub only.
  const ordersTotal = (page?.orders.length ?? 0) + (imported?.totalCount ?? 0);

  // Merged rows, kept only to seed the detail screen instantly from whatever's already loaded —
  // recomputed with the list, so it's never stale by the time a row is clicked.
  const merged = useMemo(
    () => mergeOrders(page?.orders ?? null, imported?.orders ?? null),
    [page, imported],
  );

  // Row-click / deep-link: nav.param carries the selected order's sourceId (`shopify:<id>` for
  // migrated orders, a bare id for native ones) — same idiom as Campaigns' selected-campaign branch.
  if (app.nav.param) {
    const seedRow = merged.find((r) => displayOrderSourceId(r) === app.nav.param) ?? null;
    return (
      <OrderDetailScreen
        app={app}
        sourceId={app.nav.param}
        seed={
          seedRow
            ? {
                ref: seedRow.ref,
                totalCents: seedRow.totalCents,
                currency: seedRow.currency,
                createdAt: seedRow.createdAt,
                source: seedRow.source,
                state: seedRow.state,
                financialStatus: seedRow.financialStatus,
              }
            : null
        }
      />
    );
  }

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Orders">
        <div>
          <h1 className="cd-h1">Orders</h1>
        </div>
      </header>

      {sub === "orders" ? (
        <UnifiedOrdersList
          native={page?.orders ?? null}
          imported={imported?.orders ?? null}
          totalCount={ordersTotal}
          loading={loading && importedLoading}
          onRefund={setRefundOrder}
          onOpen={(sourceId) => app.navigate("orders", sourceId)}
        />
      ) : !page ? (
        <Card pad={false}>
          {loading ? (
            <TableSkeleton />
          ) : (
            <Placeholder
              icon="doc"
              title="Orders unavailable"
              sub="Could not load orders just now. Refresh to try again."
            />
          )}
        </Card>
      ) : sub === "labels" ? (
        <Card pad={false}>
          {page.shipCharges.length === 0 ? (
            <Placeholder
              icon="truck"
              title="No shipping charges yet"
              sub="Carrier-invoice lines from your ship-cost imports land here, matched to orders."
            />
          ) : (
            <>
              <div className="cd-tablehd" style={{ gridTemplateColumns: "1fr 1.3fr 1.6fr 0.9fr 1.1fr" }}>
                <span>Order</span>
                <span>Carrier</span>
                <span>Tracking</span>
                <span style={{ textAlign: "right" }}>Cost</span>
                <span>Status</span>
              </div>
              {page.shipCharges.map((r, i) => (
                <div key={i} className="cd-trow" style={{ gridTemplateColumns: "1fr 1.3fr 1.6fr 0.9fr 1.1fr" }}>
                  <div className="cd-row-title tabular-nums">{r.orderRef}</div>
                  <div className="truncate">{r.carrier ?? "—"}</div>
                  <div className="cd-caption tabular-nums truncate">{r.tracking ?? "—"}</div>
                  <div className="cd-row-num tabular-nums" style={{ textAlign: "right" }}>
                    {money(r.costCents)}
                  </div>
                  <div>
                    <span
                      className="cd-badge"
                      style={{
                        color: r.matched ? "var(--green)" : "var(--orange)",
                        background: "var(--gray-bg)",
                      }}
                    >
                      {r.matched ? "Matched" : "Unmatched"}
                    </span>
                  </div>
                </div>
              ))}
            </>
          )}
        </Card>
      ) : sub === "drafts" ? (
        <Card pad={false}>
          {page.drafts.length === 0 ? (
            <Placeholder
              icon="doc"
              title="No open carts"
              sub="In-progress baskets that haven't reached checkout show up here."
            />
          ) : (
            <>
              <div className="cd-tablehd" style={{ gridTemplateColumns: "1fr 1.5fr 1.2fr 0.9fr 1.4fr" }}>
                <span>Cart</span>
                <span>Customer</span>
                <span>Items</span>
                <span style={{ textAlign: "right" }}>Value</span>
                <span>Started</span>
              </div>
              {page.drafts.map((r) => (
                <div key={r.id} className="cd-trow" style={{ gridTemplateColumns: "1fr 1.5fr 1.2fr 0.9fr 1.4fr" }}>
                  <div className="cd-row-title tabular-nums">{r.ref}</div>
                  <div className="truncate">{r.buyerEmail ?? "Guest"}</div>
                  <div className="cd-caption">{r.itemCount} items</div>
                  <div className="cd-row-num tabular-nums" style={{ textAlign: "right" }}>
                    {money(r.valueCents, r.currency)}
                  </div>
                  <div className="cd-caption">{timeAgo(r.createdAt)}</div>
                </div>
              ))}
            </>
          )}
        </Card>
      ) : (
        <Card pad={false}>
          {page.abandoned.length === 0 ? (
            <Placeholder
              icon="clock"
              title="No abandoned checkouts"
              sub="Checkouts that stall for over an hour before payment show up here."
            />
          ) : (
            <>
              <div className="cd-tablehd" style={{ gridTemplateColumns: "1fr 1.8fr 0.9fr 1fr 1.3fr" }}>
                <span>Checkout</span>
                <span>Customer</span>
                <span style={{ textAlign: "right" }}>Value</span>
                <span>Stage</span>
                <span>Started</span>
              </div>
              {page.abandoned.map((r) => (
                <div key={r.id} className="cd-trow" style={{ gridTemplateColumns: "1fr 1.8fr 0.9fr 1fr 1.3fr" }}>
                  <div className="cd-row-title tabular-nums">{r.ref}</div>
                  <div className="truncate">{r.buyerEmail ?? "Guest"}</div>
                  <div className="cd-row-num tabular-nums" style={{ textAlign: "right" }}>
                    {money(r.totalCents, r.currency)}
                  </div>
                  <div className="cd-caption">Payment</div>
                  <div className="cd-caption">{timeAgo(r.createdAt)}</div>
                </div>
              ))}
            </>
          )}
        </Card>
      )}

      {refundOrder && (
        <RefundModal
          app={app}
          order={refundOrder}
          onClose={() => setRefundOrder(null)}
          onDone={() => load()}
        />
      )}
    </div>
  );
}
