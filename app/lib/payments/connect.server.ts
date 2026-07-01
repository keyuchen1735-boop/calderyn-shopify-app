import type Stripe from "stripe";
import { getStripe } from "./stripe-client.server";
import { getSupabase } from "~/lib/supabase.server";

/**
 * Stripe Connect (#11): per-shop Express connected account, destination-charge
 * params, pull-based status sync, and the dashboard billing DTO. The PI itself
 * stays on the platform account — nothing here touches the webhook/order path.
 */

export interface ConnectedAccountRow {
  shop_id: string;
  stripe_account_id: string;
  account_type: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  application_fee_bps: number;
  application_fee_flat_cents: number;
  country: string;
  default_currency: string;
  onboarded_at: string | null;
}

export async function getConnectedAccount(shopId: string): Promise<ConnectedAccountRow | null> {
  const { data, error } = await getSupabase()
    .from("stripe_connected_account")
    .select("*")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw error;
  return (data as ConnectedAccountRow | null) ?? null;
}

/** bps + flat, rounded half-up, clamped to [0, amount] (Stripe rejects fee > amount). */
export function computeApplicationFeeCents(amountCents: number, bps: number, flatCents: number): number {
  const fee = Math.round((amountCents * bps) / 10000) + flatCents;
  return Math.min(Math.max(fee, 0), amountCents);
}

export interface DestinationDecision {
  params: Partial<
    Pick<Stripe.PaymentIntentCreateParams, "transfer_data" | "on_behalf_of" | "application_fee_amount">
  >;
  stripeAccountId: string | null;
  applicationFeeCents: number | null; // null = no fee param attached
}

/**
 * The single routing decision, shared by BOTH PI-creation sites (storefront +
 * ACP). Routes ONLY to a fully-onboarded account — never strand buyer money in
 * a half-onboarded one; anything else charges the platform (today's behavior).
 */
export async function destinationParamsFor(shopId: string, amountCents: number): Promise<DestinationDecision> {
  let acct: ConnectedAccountRow | null;
  try {
    acct = await getConnectedAccount(shopId);
  } catch (err) {
    // Routing is best-effort (spec §7: checkout never fails because of payout
    // plumbing). A stripe_connected_account read error falls OPEN to a platform
    // charge — today's manually-settleable behavior — instead of aborting a
    // checkout that has already written its order rows. Logged, never silent.
    console.warn(
      `[stripe-connect] connected-account lookup failed for shop ${shopId} (${(err as Error).message}); using platform charge`,
    );
    return { params: {}, stripeAccountId: null, applicationFeeCents: null };
  }
  if (!acct || !acct.charges_enabled || !acct.payouts_enabled || !acct.details_submitted) {
    return { params: {}, stripeAccountId: null, applicationFeeCents: null };
  }
  const fee = computeApplicationFeeCents(amountCents, acct.application_fee_bps, acct.application_fee_flat_cents);
  return {
    params: {
      transfer_data: { destination: acct.stripe_account_id },
      on_behalf_of: acct.stripe_account_id,
      ...(fee > 0 ? { application_fee_amount: fee } : {}),
    },
    stripeAccountId: acct.stripe_account_id,
    applicationFeeCents: fee > 0 ? fee : null,
  };
}

export interface RoutedPaymentIntent {
  pi: Stripe.PaymentIntent;
  /** null = platform charge (manual settlement); acct_... = destination-routed. */
  stripeAccountId: string | null;
  /** Fee actually attached at create; null = none. */
  applicationFeeCents: number | null;
}

/**
 * THE single PI-creation seam for routed charges — every PaymentIntent site
 * (storefront checkout, ACP agentic checkout, future sites) calls this so the
 * routing decision, the destination→platform fallback, and the row-stamping
 * values cannot drift apart per call site.
 *
 * Fallback contract: ONLY a routed create rejected as StripeInvalidRequestError
 * (HTTP 400/404 parameter validation — strictly pre-authorization, so a
 * confirm:true create has moved no money) retries as a platform charge.
 * A card decline (StripeCardError, 402) or any network/API error propagates
 * untouched — NEVER retried, so a confirmed charge can never double-attempt.
 */
export async function createRoutedPaymentIntent(
  shopId: string,
  base: Stripe.PaymentIntentCreateParams,
  opts: { logLabel?: string; idempotencyKey?: string } = {},
): Promise<RoutedPaymentIntent> {
  const label = opts.logLabel ? `${opts.logLabel} ` : "";
  const dest = await destinationParamsFor(shopId, base.amount as number);

  let stripeAccountId = dest.stripeAccountId;
  let applicationFeeCents = dest.applicationFeeCents;
  let pi: Stripe.PaymentIntent;
  try {
    pi = await getStripe().paymentIntents.create(
      { ...base, ...dest.params },
      opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined,
    );
  } catch (err) {
    // Destination-specific rejection (half-onboarded/restricted account) must not
    // break checkout: retry as a platform charge (= manually settleable) and
    // re-sync the stale flags. The guard is deliberately NARROW — only invalid-
    // requests whose code/param implicates the account/destination params fall
    // back; an invalid-request WE caused (malformed fee/amount/etc.) propagates
    // visibly (rule 12) instead of silently becoming a feeless platform charge.
    const e = err as { type?: string; code?: string; param?: string };
    const destinationRejected =
      e.type === "StripeInvalidRequestError" &&
      (e.code === "account_invalid" || /transfer_data|on_behalf_of/.test(e.param ?? ""));
    if (stripeAccountId && destinationRejected) {
      console.warn(
        `[stripe-connect] ${label}destination charge for shop ${shopId} rejected (${(err as Error).message}); falling back to platform charge`,
      );
      void syncAccountStatus(shopId).catch((e) =>
        console.warn(`[stripe-connect] status re-sync failed for shop ${shopId}: ${(e as Error).message}`),
      );
      stripeAccountId = null;
      applicationFeeCents = null;
      // The platform fallback needs its OWN idempotency key: reusing the
      // destination attempt's key with different params would make Stripe
      // reject the retry with idempotency_error instead of charging.
      pi = await getStripe().paymentIntents.create(
        base,
        opts.idempotencyKey ? { idempotencyKey: `${opts.idempotencyKey}_platform` } : undefined,
      );
    } else {
      throw err;
    }
  }
  return { pi, stripeAccountId, applicationFeeCents };
}

/**
 * Base origin for the Stripe-hosted onboarding return/refresh redirects.
 * First NON-EMPTY env wins (`??` alone would accept ""); strips ALL trailing
 * slashes. Mirrors appOrigin (pilot-invite/origin.server.ts) — kept local
 * because the primary env knob differs per surface (dashboard vs pilot links).
 */
export function onboardingOrigin(request: Request): string {
  const base =
    [process.env.DASHBOARD_PUBLIC_URL, process.env.SHOPIFY_APP_URL].find(Boolean) ??
    new URL(request.url).origin;
  return base.replace(/\/+$/, "");
}

/**
 * Create-or-reuse the Express account and mint a fresh hosted-onboarding link.
 * Idempotent on the account: one acct_ per shop (unique shop_id).
 * ponytail: two truly concurrent first clicks can orphan one test-mode Stripe
 * account (second insert loses on unique(shop_id)); harmless, not handled.
 */
export async function startOnboarding(shopId: string, origin: string): Promise<{ url: string }> {
  const acct = await getConnectedAccount(shopId);
  let stripeAccountId = acct?.stripe_account_id ?? null;
  if (!stripeAccountId) {
    const created = await getStripe().accounts.create({
      type: "express",
      country: "US",
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { shop_id: shopId },
    });
    const ins = await getSupabase().from("stripe_connected_account").insert({
      shop_id: shopId,
      stripe_account_id: created.id,
      account_type: "express",
      country: created.country ?? "US",
      default_currency: created.default_currency ?? "usd",
    });
    if (ins.error) throw ins.error;
    stripeAccountId = created.id;
  }
  const link = await getStripe().accountLinks.create({
    account: stripeAccountId,
    type: "account_onboarding",
    return_url: `${origin}/dashboard/payouts/stripe/return`,
    refresh_url: `${origin}/dashboard/payouts/stripe/refresh`,
  });
  return { url: link.url };
}

/** Pull API truth into the row (return URL / Settings load / explicit refresh / self-heal). */
export async function syncAccountStatus(
  shopId: string,
): Promise<{ chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean } | null> {
  const acct = await getConnectedAccount(shopId);
  if (!acct) return null;
  const remote = await getStripe().accounts.retrieve(acct.stripe_account_id);
  const flags = {
    charges_enabled: Boolean(remote.charges_enabled),
    payouts_enabled: Boolean(remote.payouts_enabled),
    details_submitted: Boolean(remote.details_submitted),
  };
  const fullyEnabled = flags.charges_enabled && flags.payouts_enabled && flags.details_submitted;
  const upd = await getSupabase()
    .from("stripe_connected_account")
    .update({
      ...flags,
      updated_at: new Date().toISOString(),
      ...(fullyEnabled && !acct.onboarded_at ? { onboarded_at: new Date().toISOString() } : {}),
    })
    .eq("shop_id", shopId);
  if (upd.error) throw upd.error;
  return {
    chargesEnabled: flags.charges_enabled,
    payoutsEnabled: flags.payouts_enabled,
    detailsSubmitted: flags.details_submitted,
  };
}

export interface BillingDTO {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  feeBps: number;
  feeFlatCents: number;
  balance: {
    available: Array<{ amountCents: number; currency: string }>;
    pending: Array<{ amountCents: number; currency: string }>;
  } | null;
}

/** Dashboard DTO (never the raw row). The live balance read degrades to null; it never 500s the screen. */
export async function billingStatus(shopId: string): Promise<BillingDTO> {
  const acct = await getConnectedAccount(shopId);
  if (!acct) {
    return {
      connected: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      feeBps: 0,
      feeFlatCents: 0,
      balance: null,
    };
  }
  let balance: BillingDTO["balance"] = null;
  if (acct.details_submitted) {
    try {
      const bal = await getStripe().balance.retrieve({}, { stripeAccount: acct.stripe_account_id });
      const shape = (rows: Array<{ amount: number; currency: string }>) =>
        rows.map((r) => ({ amountCents: r.amount, currency: r.currency }));
      balance = { available: shape(bal.available), pending: shape(bal.pending) };
    } catch (err) {
      console.warn(`[stripe-connect] live balance read failed for shop ${shopId}: ${(err as Error).message}`);
    }
  }
  return {
    connected: true,
    chargesEnabled: acct.charges_enabled,
    payoutsEnabled: acct.payouts_enabled,
    detailsSubmitted: acct.details_submitted,
    feeBps: acct.application_fee_bps,
    feeFlatCents: acct.application_fee_flat_cents,
    balance,
  };
}

/**
 * Single-use Express-dashboard login link, minted ONLY on demand (a link is
 * consumed by one click; minting it on every Settings load wasted a live
 * Stripe call per view). null = no fully-submitted connected account.
 */
export async function expressLoginLink(shopId: string): Promise<{ url: string } | null> {
  const acct = await getConnectedAccount(shopId);
  if (!acct || !acct.details_submitted) return null;
  const login = await getStripe().accounts.createLoginLink(acct.stripe_account_id);
  return { url: login.url };
}
