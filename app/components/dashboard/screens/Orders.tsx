import { useCallback, useEffect, useState } from "react";
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

// Order-state → badge tone. The vocabulary is the order spine's shared state
// set (app/lib/order/state.ts).
const STATE_TONE: Record<string, string> = {
  paid: "var(--green)",
  fulfilled: "var(--green)",
  checkout_pending: "var(--orange)",
  cancelled: "var(--text-3)",
  refunded: "var(--orange)",
  partially_refunded: "var(--orange)",
  cart: "var(--text-3)",
};

const STATE_LABEL: Record<string, string> = {
  paid: "Paid",
  fulfilled: "Fulfilled",
  checkout_pending: "Checkout pending",
  cancelled: "Cancelled",
  refunded: "Refunded",
  partially_refunded: "Partially refunded",
  cart: "Cart",
};

// Only an owned order that has captured money (and isn't already fully refunded) can be
// refunded through Calderyn — mirrors REFUNDABLE_STATES in refund.server.ts.
const REFUNDABLE_STATES = new Set(["paid", "fulfilled", "partially_refunded"]);

// Migrated Shopify orders whose money was captured at Shopify: Calderyn can't
// reverse that charge, so the merchant is told, plainly, to refund it in Shopify.
const SHOPIFY_REFUND_HINT_STATES = new Set(["paid", "partially_refunded", "partially_paid"]);

function StateBadge({ state }: { state: string }) {
  return (
    <span
      className="cd-badge"
      style={{ color: STATE_TONE[state] ?? "var(--text-2)", background: "var(--gray-bg)" }}
    >
      {STATE_LABEL[state] ?? state}
    </span>
  );
}

// Shopify financial statuses on migrated orders → dashboard pill. Same visual
// vocabulary as the native badge so the merged list reads as one history.
const IMPORTED_STATUS: Record<string, { label: string; tone: "success" | "warn" | "neutral" }> = {
  paid: { label: "Paid", tone: "success" },
  partially_paid: { label: "Partially paid", tone: "warn" },
  partially_refunded: { label: "Partially refunded", tone: "warn" },
  refunded: { label: "Refunded", tone: "warn" },
  pending: { label: "Pending", tone: "neutral" },
  authorized: { label: "Authorized", tone: "neutral" },
  voided: { label: "Voided", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
};

function statusTitle(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ") : "Unknown";
}

function ImportedStatusPill({ status }: { status: string }) {
  const s = IMPORTED_STATUS[status] ?? { label: statusTitle(status), tone: "neutral" as const };
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
  state: string;
  source: "calderyn" | "shopify";
  // The native OrderRow (for the refund modal) when this row is a Calderyn
  // order; null for migrated orders (their money lives at Shopify).
  refundRow: OrderRow | null;
};

function mergeOrders(native: OrderRow[] | null, imported: ImportedOrderRow[] | null): DisplayOrder[] {
  const rows: DisplayOrder[] = [];
  for (const o of native ?? []) {
    rows.push({
      id: o.id,
      ref: o.ref,
      createdAt: o.createdAt,
      customer: o.buyerEmail,
      totalCents: o.totalCents,
      state: o.state,
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
      state: o.financialStatus,
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
}: {
  native: OrderRow[] | null;
  imported: ImportedOrderRow[] | null;
  totalCount: number;
  loading: boolean;
  onRefund: (order: OrderRow) => void;
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
  const cols = "1fr 1.4fr 1fr 1fr 1fr auto";
  return (
    <Card pad={false}>
      <div className="cd-tablehd" style={{ gridTemplateColumns: cols }}>
        <span>Order</span>
        <span>Customer</span>
        <span>Total</span>
        <span>Date</span>
        <span>Status</span>
        <span />
      </div>
      {shown.map((r) => {
        const refundable = r.refundRow && REFUNDABLE_STATES.has(r.state) ? r.refundRow : null;
        return (
          <div key={`${r.source}:${r.id}`} className="cd-trow" style={{ gridTemplateColumns: cols }}>
            <div>
              <div className="cd-row-title tabular-nums">{r.ref}</div>
              {r.source === "shopify" && <div className="cd-caption">Shopify</div>}
            </div>
            <div className="truncate">{r.customer ?? (r.source === "shopify" ? "" : "Guest")}</div>
            <div className="cd-row-num tabular-nums">{money(r.totalCents)}</div>
            <div className="cd-caption">{r.createdAt ? timeAgo(r.createdAt) : ""}</div>
            <div>
              {r.source === "shopify" ? (
                <ImportedStatusPill status={r.state} />
              ) : (
                <StateBadge state={r.state} />
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
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

  const sub = app.nav.sub ?? "orders";

  // Unified order count = native rows shown + the true migrated total. The
  // subtab navigation lives in the sidebar rail; this screen renders the view
  // for the active sub only.
  const ordersTotal = (page?.orders.length ?? 0) + (imported?.totalCount ?? 0);

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
                    {money(r.valueCents)}
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
                    {money(r.totalCents)}
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
