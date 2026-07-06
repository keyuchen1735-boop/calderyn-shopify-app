import { useCallback, useEffect, useState } from "react";
import { Btn, Card, Pill, Placeholder, TableSkeleton } from "../ui";
import { SubTabs } from "../subtabs";
import { money, timeAgo } from "../format";
import { DashboardApiError } from "~/lib/dashboard/client";
import {
  fetchImportedOrders,
  fetchOrdersPage,
  type ImportedOrdersPage,
  type OrderRow,
  type OrdersPage,
} from "~/lib/dashboard/orders-client";
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

// Shopify financial statuses on imported (historical) orders → dashboard pill.
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

function StatBlock({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="cd-caption">{label}</div>
      <div className="tabular-nums" style={{ fontSize: 20, fontWeight: 650, letterSpacing: "-0.01em" }}>
        {value}
      </div>
      {sub && <div className="cd-caption">{sub}</div>}
    </div>
  );
}

// The Orders "Imported" subtab: read-only historical orders + refunds brought
// over by Import-from-Shopify. Summary spans every imported order; the table
// shows the most recent slice (see the server reader's RECENT_LIMIT).
function ImportedOrdersView({
  imported,
  loading,
  app,
}: {
  imported: ImportedOrdersPage | null;
  loading: boolean;
  app: DashboardCtx;
}) {
  if (!imported) {
    return (
      <Card pad={false}>
        {loading ? (
          <TableSkeleton />
        ) : (
          <Placeholder
            icon="doc"
            title="Imported orders unavailable"
            sub="Could not load imported history just now. Refresh to try again."
          />
        )}
      </Card>
    );
  }

  const { summary, orders, totalCount, shownCount } = imported;

  if (totalCount === 0) {
    return (
      <Card pad={false}>
        <Placeholder
          icon="doc"
          title="No imported orders yet"
          sub="Bring your Shopify order history over from Settings, Import from Shopify. It lands here as read-only history."
          actionLabel="Import from Shopify"
          onAction={() => app.navigate("import-shopify", null, null)}
        />
      </Card>
    );
  }

  const span =
    summary.firstOrderAt && summary.lastOrderAt
      ? `${timeAgo(summary.firstOrderAt)} to ${timeAgo(summary.lastOrderAt)}`
      : undefined;
  const cols = "1fr 1fr 1.2fr 1fr 1fr";

  return (
    <>
      <Card>
        <div className="flex flex-wrap gap-8">
          <StatBlock label="Orders" value={summary.orderCount.toLocaleString("en-US")} sub={span} />
          <StatBlock label="Gross revenue" value={money(summary.grossCents)} />
          <StatBlock
            label="Refunded"
            value={money(summary.refundedCents)}
            sub={`${summary.refundCount.toLocaleString("en-US")} refund${summary.refundCount === 1 ? "" : "s"}`}
          />
          <StatBlock label="Net revenue" value={money(summary.netCents)} />
        </div>
        <p className="cd-caption" style={{ marginTop: 14 }}>
          Historical orders from your Shopify store. They were paid on Shopify, so they are read-only
          here; issue any refunds in Shopify.
        </p>
      </Card>

      <Card pad={false}>
        <div className="cd-tablehd" style={{ gridTemplateColumns: cols }}>
          <span>Order</span>
          <span>Date</span>
          <span>Status</span>
          <span style={{ textAlign: "right" }}>Total</span>
          <span style={{ textAlign: "right" }}>Refunded</span>
        </div>
        {orders.map((r) => (
          <div key={r.id} className="cd-trow" style={{ gridTemplateColumns: cols }}>
            <div className="cd-row-title tabular-nums">{r.ref}</div>
            <div className="cd-caption">{r.processedAt ? timeAgo(r.processedAt) : ""}</div>
            <div>
              <ImportedStatusPill status={r.financialStatus} />
            </div>
            <div className="cd-row-num tabular-nums" style={{ textAlign: "right" }}>
              {money(r.totalCents)}
            </div>
            <div
              className="cd-row-num tabular-nums"
              style={{ textAlign: "right", color: r.refundedCents > 0 ? "var(--orange)" : "var(--text-3)" }}
            >
              {money(r.refundedCents)}
            </div>
          </div>
        ))}
        {shownCount < totalCount && (
          <div className="cd-caption" style={{ padding: "10px 16px", textAlign: "center" }}>
            Showing the most recent {shownCount.toLocaleString("en-US")} of{" "}
            {totalCount.toLocaleString("en-US")} orders.
          </div>
        )}
      </Card>
    </>
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
  const [imported, setImported] = useState<ImportedOrdersPage | null>(() =>
    cachedScreenData<ImportedOrdersPage>(SCREEN_CACHE_KEYS.importedOrders),
  );
  // Loading unless the cache already seeded it, so a cold open paints the
  // skeleton, not a one-frame "unavailable" error before the fetch starts.
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

  const sub = app.nav.sub ?? "orders";

  // Lazy-load imported history the first time its subtab opens (most sessions
  // never do); the idle prefetch may have already seeded it. Write-through so a
  // return visit paints instantly.
  useEffect(() => {
    if (sub !== "imported" || imported) return;
    // Adopt a payload the idle warm-up cached after mount instead of refetching.
    const cached = cachedScreenData<ImportedOrdersPage>(SCREEN_CACHE_KEYS.importedOrders);
    if (cached) {
      setImported(cached);
      return;
    }
    const signal = { alive: true };
    setImportedLoading(true);
    fetchImportedOrders()
      .then((p) => {
        cacheScreenData(SCREEN_CACHE_KEYS.importedOrders, p);
        if (signal.alive) setImported(p);
      })
      .catch((err: unknown) => {
        if (!signal.alive) return;
        const msg =
          err instanceof DashboardApiError ? err.message : "Could not load imported orders.";
        toast(msg, "warn", "critical");
      })
      .finally(() => {
        if (signal.alive) setImportedLoading(false);
      });
    return () => {
      signal.alive = false;
    };
  }, [sub, imported, toast]);

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
          { key: "imported", label: "Imported", screen: "orders", sub: "imported", count: imported ? imported.totalCount.toLocaleString("en-US") : null },
          { key: "labels", label: "Shipping charges", screen: "orders", sub: "labels", count: count(page?.shipCharges.length) },
          { key: "drafts", label: "Draft carts", screen: "orders", sub: "drafts", count: count(page?.drafts.length) },
          { key: "abandoned", label: "Abandoned", screen: "orders", sub: "abandoned", count: count(page?.abandoned.length) },
        ]}
      />

      {sub === "imported" ? (
        <ImportedOrdersView imported={imported} loading={importedLoading} app={app} />
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
