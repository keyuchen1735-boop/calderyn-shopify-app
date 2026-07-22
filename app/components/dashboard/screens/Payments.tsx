import { useEffect, useMemo, useRef, useState } from "react";
import { Btn, Card, Pan, Placeholder, SectionTitle } from "../ui";
import {
  OrderSortHeader,
  nextSortState,
  useSortedRowsEntrance,
} from "./OrderListFamily";
import { money, timeAgo } from "../format";
import { PayoutsCard } from "../PayoutsCard";
import { DashboardApiError, fetchBilling, type BillingStatus } from "~/lib/dashboard/client";
import {
  fetchPaymentsPage,
  type LedgerRow,
  type PaymentsPage,
} from "~/lib/dashboard/payments-client";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import type { DashboardCtx } from "../context";

// Ledger kind → badge tone. The vocabulary is the transaction_ledger kind set
// (app/lib/payments/summary-types.ts).
const KIND_TONE: Record<LedgerRow["kind"], string> = {
  capture: "var(--green)",
  refund: "var(--orange)",
  fee: "var(--text-3)",
  payout: "var(--accent)",
  auth: "var(--text-2)",
};

const KIND_LABEL: Record<LedgerRow["kind"], string> = {
  capture: "Capture",
  refund: "Refund",
  fee: "Fee",
  payout: "Payout",
  auth: "Auth",
};

/** The ledger's default ordering is the server's: most recent first. No column
 *  represents it, so it is the header cycle's third-click destination. */
const DEFAULT_TXN_SORT = { sort: "default", dir: "desc" } as const;

function compareTransactions(
  a: LedgerRow,
  b: LedgerRow,
  sort: string,
  dir: "asc" | "desc",
): number {
  const mul = dir === "asc" ? 1 : -1;
  // ISO timestamps compare correctly as strings. Most-recent-first is the
  // tiebreak on every column so equal-valued rows hold one stable order.
  const byRecency = b.occurredAt.localeCompare(a.occurredAt);
  // Rows with no order or Stripe reference render an em dash; they sort to the
  // bottom in both directions rather than clustering at the top of an A-Z.
  const byOptionalText = (x: string | null, y: string | null): number => {
    if (!x && !y) return 0;
    if (!x) return 1;
    if (!y) return -1;
    return mul * x.localeCompare(y);
  };
  switch (sort) {
    case "kind":
      return mul * KIND_LABEL[a.kind].localeCompare(KIND_LABEL[b.kind]) || byRecency;
    case "amount":
      return mul * (a.amountCents - b.amountCents) || byRecency;
    case "order":
      return byOptionalText(a.orderRef, b.orderRef) || byRecency;
    case "ref":
      return byOptionalText(a.stripeRef, b.stripeRef) || byRecency;
    case "when":
      return mul * a.occurredAt.localeCompare(b.occurredAt);
    default:
      return 0;
  }
}

const TXN_GRID = "0.9fr 1fr 1fr 1.4fr 1fr";

function KindBadge({ kind }: { kind: LedgerRow["kind"] }) {
  return (
    <span
      className="cd-badge"
      style={{ color: KIND_TONE[kind], background: "var(--gray-bg)" }}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

export default function Payments({ app }: { app: DashboardCtx }) {
  // Seeded from the session cache so a return visit paints instantly; the
  // mount fetches below revalidate and write back through. The billing key is
  // shared with Settings' Stripe row — same endpoint, one entry.
  const [page, setPage] = useState<PaymentsPage | null>(() =>
    cachedScreenData<PaymentsPage>(SCREEN_CACHE_KEYS.payments),
  );
  const [billing, setBilling] = useState<BillingStatus | null>(() =>
    cachedScreenData<BillingStatus>(SCREEN_CACHE_KEYS.billing),
  );
  const [billingFailed, setBillingFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [txnSort, setTxnSort] = useState<{ sort: string; dir: "asc" | "desc" }>(
    DEFAULT_TXN_SORT,
  );
  const toast = app.toast;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const pagePromise = fetchPaymentsPage()
      .then((p) => {
        cacheScreenData(SCREEN_CACHE_KEYS.payments, p);
        if (alive) setPage(p);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const msg = err instanceof DashboardApiError ? err.message : "Could not load payments.";
        toast(msg, "warn", "critical");
      });
    // Billing status feeds the not-connected banner and the payout caption. A
    // failed read is treated as not-connected (the banner is the visible
    // surface); the ledger stats above still render from real data.
    const billingPromise = fetchBilling()
      .then((b) => {
        cacheScreenData(SCREEN_CACHE_KEYS.billing, b);
        if (alive) setBilling(b);
      })
      .catch(() => {
        if (alive) setBillingFailed(true);
      });
    Promise.allSettled([pagePromise, billingPromise]).then(() => {
      if (alive) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [toast]);

  const notConnected = billingFailed || (billing != null && !billing.connected);
  const available = billing?.balance?.available?.[0];
  const pending = billing?.balance?.pending?.[0];
  const payoutCaption =
    available || pending
      ? [
          available ? `available ${money(available.amountCents)}` : null,
          pending ? `pending ${money(pending.amountCents)}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "Sent to your bank via Stripe";

  const s = page?.summary;

  const shownTxns = useMemo(() => {
    const transactions = page?.transactions ?? [];
    if (txnSort.sort === "default") return transactions;
    return [...transactions].sort((a, b) =>
      compareTransactions(a, b, txnSort.sort, txnSort.dir),
    );
  }, [page, txnSort]);

  const txnHeaderSort = {
    sort: txnSort.sort,
    dir: txnSort.dir,
    onSort: (col: string) => setTxnSort((cur) => nextSortState(cur, col, DEFAULT_TXN_SORT)),
  };

  const txnListRef = useRef<HTMLDivElement>(null);
  useSortedRowsEntrance(txnListRef, shownTxns.map((t) => t.id).join("|"), [page, txnSort]);

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Payments">
        <div>
          <h1 className="cd-h1">Payments</h1>
        </div>
      </header>

      {notConnected && (
        <Card>
          <div className="cd-setting">
            <div className="min-w-0 flex-1">
              <div className="cd-row-title">Stripe isn't connected yet</div>
              <div className="cd-caption" style={{ maxWidth: "52ch" }}>
                Connect Stripe to accept card payments. Volume, refunds, fees, and
                payouts appear here as payments start landing.
              </div>
            </div>
            <Btn kind="primary" onClick={() => app.navigate("settings", null, "connectors")}>
              Connect Stripe
            </Btn>
          </div>
        </Card>
      )}

      {!page ? (
        <Card>
          <Placeholder
            icon="card"
            title={loading ? "Loading payments" : "Payments unavailable"}
            sub={
              loading
                ? "Reading your payment ledger."
                : "Could not load payments just now. Refresh to try again."
            }
          />
        </Card>
      ) : (
        <>
          <div className="cd-stat-grid">
            <Card className="cd-stat">
              <span className="cd-stat-label">Gross volume · 30d</span>
              <span className="cd-stat-value tabular-nums">
                {money(s?.grossVolumeCents30d ?? 0)}
              </span>
              <span className="cd-caption">{s?.txnCount30d ?? 0} transactions</span>
            </Card>
            <Card className="cd-stat">
              <span className="cd-stat-label">Payouts · 30d</span>
              <span className="cd-stat-value tabular-nums">
                {money(s?.payoutCents30d ?? 0)}
              </span>
              <span className="cd-caption">{payoutCaption}</span>
            </Card>
            <Card className="cd-stat">
              <span className="cd-stat-label">Refund rate</span>
              <span className="cd-stat-value tabular-nums">
                {s?.refundRatePct == null ? "—" : `${s.refundRatePct.toFixed(1)}%`}
              </span>
              <span className="cd-caption">{money(s?.refundCents30d ?? 0)} refunded</span>
            </Card>
            <Card className="cd-stat">
              <span className="cd-stat-label">Processing fees · 30d</span>
              <span className="cd-stat-value tabular-nums">{money(s?.feeCents30d ?? 0)}</span>
              <span className="cd-caption">Stripe platform fees</span>
            </Card>
          </div>

          <PayoutsCard
            app={app}
            onBillingUpdate={(b) => {
              setBilling(b);
              setBillingFailed(false);
            }}
          />

          <section>
            <SectionTitle>Recent transactions</SectionTitle>
            <Card pad={false}>
              {page.transactions.length === 0 ? (
                <Placeholder
                  icon="card"
                  title="No transactions yet"
                  sub="They appear here as Stripe events land."
                />
              ) : (
                <Pan min={560}>
                  <div className="cd-tablehd" style={{ gridTemplateColumns: TXN_GRID }}>
                    <OrderSortHeader label="Kind" col="kind" {...txnHeaderSort} />
                    <OrderSortHeader label="Amount" col="amount" align="right" {...txnHeaderSort} />
                    <OrderSortHeader label="Order" col="order" {...txnHeaderSort} />
                    <OrderSortHeader label="Stripe ref" col="ref" {...txnHeaderSort} />
                    <OrderSortHeader label="When" col="when" {...txnHeaderSort} />
                  </div>
                  <div ref={txnListRef}>
                  {shownTxns.map((t) => (
                    <div key={t.id} className="cd-trow" style={{ gridTemplateColumns: TXN_GRID }}>
                      <div>
                        <KindBadge kind={t.kind} />
                      </div>
                      <div className="cd-row-num tabular-nums" style={{ textAlign: "right" }}>
                        {money(t.amountCents)}
                      </div>
                      <div className="truncate">{t.orderRef ?? "—"}</div>
                      <div className="cd-caption tabular-nums truncate">{t.stripeRef ?? "—"}</div>
                      <div className="cd-caption">{timeAgo(t.occurredAt)}</div>
                    </div>
                  ))}
                  </div>
                </Pan>
              )}
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
