// Typed errors for the payments path. Kept dependency-free (no server-only imports)
// so routes and tests can catch by `instanceof` without pulling in the Stripe/Supabase
// data layer (same stance as app/lib/shipping/errors.ts).

/**
 * Thrown by the payouts-setup path (hosted onboarding, status sync) when Stripe
 * itself refuses the shop's connected account. Carries a merchant-readable
 * `message` so the dashboard can toast what actually went wrong instead of an
 * opaque `internal_error`.
 */
export class PayoutAccountError extends Error {
  readonly code = "PAYOUT_ACCOUNT_UNAVAILABLE" as const;
  constructor(message: string) {
    super(message);
    this.name = "PayoutAccountError";
  }
}

/** Thrown by every charge site when the shop cannot legitimately accept payments yet. */
export class PaymentsNotReadyError extends Error {
  readonly code = "PAYMENTS_NOT_READY" as const;
  readonly reason: "no_account" | "onboarding_incomplete";
  constructor(shopId: string, reason: "no_account" | "onboarding_incomplete") {
    super(`shop ${shopId} cannot accept payments (${reason}): the merchant must finish Stripe onboarding`);
    this.name = "PaymentsNotReadyError";
    this.reason = reason;
  }
}
