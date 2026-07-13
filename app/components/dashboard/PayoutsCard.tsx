import { useEffect, useState } from "react";
import { Btn } from "./ui";
import { money } from "./format";
import {
  fetchBilling,
  fetchPayoutLoginLink,
  startPayoutOnboarding,
  refreshPayoutStatus,
  DashboardApiError,
  type BillingStatus,
} from "~/lib/dashboard/client";
import { payoutsCardState } from "./view-models";
import type { DashboardCtx } from "./context";

interface PayoutPanelProps {
  billing: BillingStatus | null;
  loadFailed: boolean;
  busy: boolean;
  onRetryLoad: () => void;
  onCta: () => void;
  onOpenStripe: () => void;
  onRefresh: () => void;
}

/** Pure payout surface: every visual state is renderable without network effects. */
export function PayoutPanel({
  billing,
  loadFailed,
  busy,
  onRetryLoad,
  onCta,
  onOpenStripe,
  onRefresh,
}: PayoutPanelProps) {
  const vm = billing ? payoutsCardState(billing) : null;
  const phase = loadFailed ? "error" : vm?.phase ?? "loading";
  const active = vm?.phase === "active";
  const available = billing?.balance?.available?.[0];
  const pending = billing?.balance?.pending?.[0];
  const feeValue = vm?.feeLabel.replace(/^Platform fee:\s*/, "") ?? "—";

  return (
    <section className="cd-payout-section" aria-labelledby="cd-payout-title">
      <div
        className="cd-payout-panel"
        data-phase={phase}
        aria-busy={phase === "loading" ? "true" : undefined}
      >
        <div className="cd-payout-visual">
          <div className="cd-payout-head">
            <h2 id="cd-payout-title" className="cd-payout-title">
              Payouts
            </h2>
            {vm && (
              <span className="cd-payout-status" data-tone={vm.pillTone}>
                <i aria-hidden="true" />
                {vm.pillLabel}
              </span>
            )}
          </div>

          {phase === "loading" ? (
            <div className="cd-payout-skeleton cd-payout-skeleton--amount" />
          ) : active ? (
            <div className="cd-payout-balance">
              <span>Available balance</span>
              <strong className="cd-payout-amount tabular-nums">
                {available ? money(available.amountCents) : "—"}
              </strong>
            </div>
          ) : (
            <div className="cd-payout-balance cd-payout-balance--setup">
              <span>Stripe Connect</span>
              <strong>Money routed to your bank</strong>
            </div>
          )}

          <div className="cd-payout-card-art" aria-hidden="true">
            <span className="cd-payout-card-chip" />
            <span className="cd-payout-card-mark">PAYOUT</span>
            <span className="cd-payout-card-lines">
              <i />
              <i />
            </span>
          </div>
        </div>

        <div className="cd-payout-details">
          {phase === "loading" ? (
            <>
              <div className="cd-payout-skeleton cd-payout-skeleton--row" />
              <div className="cd-payout-skeleton cd-payout-skeleton--row" />
              <div className="cd-payout-skeleton cd-payout-skeleton--button" />
            </>
          ) : phase === "error" ? (
            <div className="cd-payout-state-copy">
              <h3>Payout status unavailable</h3>
              <p>We couldn&apos;t read your Stripe payout status just now.</p>
              <Btn onClick={onRetryLoad}>Retry</Btn>
            </div>
          ) : active ? (
            <>
              <div className="cd-payout-detail-row">
                <span>Pending</span>
                <strong className="tabular-nums">
                  {pending ? money(pending.amountCents) : "—"}
                </strong>
              </div>
              <div className="cd-payout-detail-row">
                <span>Platform fee</span>
                <strong>{feeValue}</strong>
              </div>
              <div className="cd-payout-actions">
                <Btn kind="primary" onClick={onOpenStripe} disabled={busy}>
                  Open Stripe <span aria-hidden="true">↗</span>
                </Btn>
                <button
                  type="button"
                  className="cd-payout-refresh"
                  onClick={onRefresh}
                  disabled={busy}
                  aria-label="Refresh payout status"
                >
                  <span aria-hidden="true">↻</span> Refresh
                </button>
              </div>
            </>
          ) : (
            <div className="cd-payout-state-copy">
              <h3>Finish payout setup</h3>
              <p>
                {vm?.phase === "onboarding"
                  ? "Complete Stripe onboarding to send buyer payments to your bank."
                  : "Connect Stripe so buyer payments can land in your bank automatically."}
              </p>
              <span className="cd-payout-fee">{vm?.feeLabel}</span>
              <Btn kind="primary" onClick={onCta} disabled={busy}>
                {vm?.cta === "setup" ? "Set up payouts" : "Resume onboarding"}
              </Btn>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Payouts (Stripe Connect, #11): onboarding CTA, status pill, live balance, fee line. */
export function PayoutsCard({ app }: { app: DashboardCtx }) {
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadFailed(false);
    fetchBilling()
      .then((d) => {
        if (active) setBilling(d);
      })
      .catch(() => {
        // Surface the failure (rule 12) — a swallowed error would pin the card
        // on the loading state forever with no recovery.
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const onRetryLoad = async () => {
    setLoadFailed(false);
    try {
      setBilling(await fetchBilling());
    } catch {
      setLoadFailed(true);
    }
  };

  const onCta = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { url } = await startPayoutOnboarding();
      window.location.assign(url); // top-level hop to Stripe-hosted onboarding
    } catch (err) {
      const message = err instanceof DashboardApiError ? err.message : "Couldn't start payout setup.";
      app.toast(message, "x", "critical");
      setBusy(false);
    }
  };

  const onOpenStripe = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { url } = await fetchPayoutLoginLink();
      window.location.assign(url);
    } catch (err) {
      const message = err instanceof DashboardApiError ? err.message : "Couldn't open the Stripe dashboard.";
      app.toast(message, "x", "critical");
      setBusy(false);
    }
  };

  const onRefresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setBilling(await refreshPayoutStatus());
      app.toast("Payout status refreshed", "check");
    } catch (err) {
      const message = err instanceof DashboardApiError ? err.message : "Couldn't refresh payout status.";
      app.toast(message, "x", "critical");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PayoutPanel
      billing={billing}
      loadFailed={loadFailed}
      busy={busy}
      onRetryLoad={onRetryLoad}
      onCta={onCta}
      onOpenStripe={onOpenStripe}
      onRefresh={onRefresh}
    />
  );
}
