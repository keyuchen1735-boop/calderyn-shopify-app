import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { payoutsCardState } from "../view-models";
import { PayoutPanel } from "../PayoutsCard";
import type { BillingStatus } from "~/lib/dashboard/client";

const BASE = {
  connected: false,
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  feeBps: 0,
  feeFlatCents: 0,
};

describe("payoutsCardState", () => {
  it("not connected → setup CTA", () => {
    expect(payoutsCardState(BASE)).toEqual({
      phase: "not_connected",
      pillTone: "neutral",
      pillLabel: "Not set up",
      cta: "setup",
      feeLabel: "Platform fee: 0% — pilot",
    });
  });

  it("connected but incomplete → resume CTA, warn pill", () => {
    expect(payoutsCardState({ ...BASE, connected: true, detailsSubmitted: true })).toMatchObject({
      phase: "onboarding",
      pillTone: "warn",
      pillLabel: "Onboarding incomplete",
      cta: "resume",
    });
  });

  it("fully enabled → active, no CTA", () => {
    expect(
      payoutsCardState({
        ...BASE,
        connected: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
      }),
    ).toMatchObject({ phase: "active", pillTone: "success", pillLabel: "Payouts active", cta: null });
  });

  it("formats a non-zero fee", () => {
    expect(payoutsCardState({ ...BASE, feeBps: 250, feeFlatCents: 30 }).feeLabel).toBe(
      "Platform fee: 2.5% + $0.30",
    );
  });
});

const ACTIVE: BillingStatus = {
  connected: true,
  chargesEnabled: true,
  payoutsEnabled: true,
  detailsSubmitted: true,
  feeBps: 0,
  feeFlatCents: 0,
  balance: {
    available: [{ amountCents: 1_284_072, currency: "usd" }],
    pending: [{ amountCents: 192_640, currency: "usd" }],
  },
};

const actions = {
  onRetryLoad: () => {},
  onCta: () => {},
  onOpenStripe: () => {},
  onRefresh: () => {},
};

function renderPanel(
  billing: BillingStatus | null,
  options: { loadFailed?: boolean; busy?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <PayoutPanel
      billing={billing}
      loadFailed={options.loadFailed ?? false}
      busy={options.busy ?? false}
      {...actions}
    />,
  );
}

describe("PayoutPanel", () => {
  it("prioritizes balances and Stripe actions in the active state", () => {
    const html = renderPanel(ACTIVE);
    expect(html).toContain('data-phase="active"');
    expect(html).toContain("$12,840.72");
    expect(html).toContain("$1,926.40");
    expect(html).toContain("Open Stripe");
    expect(html).toContain("Refresh");
    expect(html).toContain('aria-hidden="true"');
  });

  it("shows an em dash instead of treating a missing balance as zero", () => {
    const html = renderPanel({ ...ACTIVE, balance: null });
    expect(html).toContain("cd-payout-amount");
    expect(html).toContain(">—<");
  });

  it("reduces incomplete onboarding to one message and one CTA", () => {
    const html = renderPanel({
      ...ACTIVE,
      payoutsEnabled: false,
      detailsSubmitted: false,
      balance: null,
    });
    expect(html).toContain('data-phase="onboarding"');
    expect(html).toContain("Finish payout setup");
    expect(html).toContain("Resume onboarding");
    expect(html).not.toContain("Open Stripe");
  });

  it("renders a shaped loading state", () => {
    const html = renderPanel(null);
    expect(html).toContain('data-phase="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("cd-payout-skeleton");
  });

  it("keeps load failures inline with a retry action", () => {
    const html = renderPanel(null, { loadFailed: true });
    expect(html).toContain('data-phase="error"');
    expect(html).toContain("Payout status unavailable");
    expect(html).toContain("Retry");
  });
});
