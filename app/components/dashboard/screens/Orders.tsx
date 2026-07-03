import { useCallback, useEffect, useState } from "react";
import { Btn, Card, Placeholder, TableSkeleton } from "../ui";
import { SubTabs } from "../subtabs";
import { money, timeAgo } from "../format";
import { DashboardApiError } from "~/lib/dashboard/client";
import { fetchOrdersPage, type OrderRow, type OrdersPage } from "~/lib/dashboard/orders-client";
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

export default function Orders({ app }: { app: DashboardCtx }) {
  const [page, setPage] = useState<OrdersPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [refundOrder, setRefundOrder] = useState<OrderRow | null>(null);
  const toast = app.toast;

  const load = useCallback(
    (signal?: { alive: boolean }) => {
      setLoading(true);
      fetchOrdersPage()
        .then((p) => {
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

  const sub = app.nav.sub ?? "orders";
  // Lists are capped server-side at 100 rows — past the cap the true total is
  // unknown here, so the badge says "100+" instead of posing as a count.
  const count = (n: number | undefined) =>
    n == null ? null : n >= 100 ? "100+" : String(n);

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Orders">
        <div>
          <h1 className="cd-h1">Orders</h1>
        </div>
      </header>

      <SubTabs
        app={app}
        activeKey={sub}
        tabs={[
          { key: "orders", label: "Orders", screen: "orders", sub: "orders", count: count(page?.orders.length) },
          { key: "labels", label: "Shipping charges", screen: "orders", sub: "labels", count: count(page?.shipCharges.length) },
          { key: "drafts", label: "Draft carts", screen: "orders", sub: "drafts", count: count(page?.drafts.length) },
          { key: "abandoned", label: "Abandoned", screen: "orders", sub: "abandoned", count: count(page?.abandoned.length) },
        ]}
      />

      {!page ? (
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
      ) : sub === "orders" ? (
        <Card pad={false}>
          {page.orders.length === 0 ? (
            <Placeholder
              icon="doc"
              title="No orders yet"
              sub="Orders from your storefront and from AI shopping assistants land here."
            />
          ) : (
            <>
              <div className="cd-tablehd" style={{ gridTemplateColumns: "1fr 1.6fr 1fr 1fr 1fr auto" }}>
                <span>Order</span>
                <span>Customer</span>
                <span>Total</span>
                <span>Attributed to</span>
                <span>State</span>
                <span />
              </div>
              {page.orders.map((r) => (
                <div key={r.id} className="cd-trow" style={{ gridTemplateColumns: "1fr 1.6fr 1fr 1fr 1fr auto" }}>
                  <div>
                    <div className="cd-row-title tabular-nums">{r.ref}</div>
                    <div className="cd-caption">{timeAgo(r.createdAt)}</div>
                  </div>
                  <div className="truncate">{r.buyerEmail ?? "Guest"}</div>
                  <div className="cd-row-num tabular-nums">{money(r.totalCents)}</div>
                  <div className="cd-caption truncate">{r.attribution ?? "Direct"}</div>
                  <div>
                    <StateBadge state={r.state} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    {REFUNDABLE_STATES.has(r.state) && (
                      <Btn small icon="rotate" onClick={() => setRefundOrder(r)}>
                        Refund
                      </Btn>
                    )}
                  </div>
                </div>
              ))}
            </>
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
