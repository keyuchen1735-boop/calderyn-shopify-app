import { useEffect, useState } from "react";
import { Btn, Card, Placeholder, SectionTitle } from "../ui";
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
                <>
                  <div className="cd-tablehd" style={{ gridTemplateColumns: TXN_GRID }}>
                    <span>Kind</span>
                    <span style={{ textAlign: "right" }}>Amount</span>
                    <span>Order</span>
                    <span>Stripe ref</span>
                    <span>When</span>
                  </div>
                  {page.transactions.map((t) => (
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
                </>
              )}
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
