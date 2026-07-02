import { useEffect, useState } from "react";
import { Card, SectionTitle, Pill, Btn } from "./ui";
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

  const vm = billing ? payoutsCardState(billing) : null;
  const available = billing?.balance?.available?.[0];
  const pending = billing?.balance?.pending?.[0];

  return (
    <section>
      <SectionTitle>Payouts</SectionTitle>
      <Card>
        {loadFailed ? (
          <div className="cd-caption">
            Couldn't load payout status.{" "}
            <button type="button" className="cd-link" onClick={onRetryLoad}>
              Retry
            </button>
          </div>
        ) : !vm || !billing ? (
          <div className="cd-caption">Loading payout status…</div>
        ) : (
          <>
            <div className="cd-setting">
              <div className="min-w-0 flex-1">
                <div className="cd-row-title">
                  Stripe payouts <Pill tone={vm.pillTone}>{vm.pillLabel}</Pill>
                </div>
                <div className="cd-caption" style={{ maxWidth: "46ch" }}>
                  {vm.phase === "active"
                    ? "Buyer payments route to your Stripe account and pay out automatically."
                    : "Connect a payout account so buyer payments land in your bank automatically."}
                </div>
                <div className="cd-caption">{vm.feeLabel}</div>
                {vm.phase === "active" && available && (
                  <div className="cd-caption">
                    Balance: {money(available.amountCents)} available
                    {pending ? ` · ${money(pending.amountCents)} pending` : ""}
                  </div>
                )}
              </div>
              {vm.cta ? (
                <Btn kind="primary" onClick={onCta} disabled={busy}>
                  {vm.cta === "setup" ? "Set up payouts" : "Resume onboarding"}
                </Btn>
              ) : (
                <Btn onClick={onRefresh} disabled={busy} small>
                  Refresh
                </Btn>
              )}
            </div>
            {vm.phase === "active" && (
              <div className="cd-caption">
                {/* Login links are single-use; mint on click (in-tab nav — an async
                    window.open would trip popup blockers). */}
                <button type="button" className="cd-link" onClick={onOpenStripe} disabled={busy}>
                  Open Stripe payout dashboard
                </button>
              </div>
            )}
          </>
        )}
      </Card>
    </section>
  );
}
