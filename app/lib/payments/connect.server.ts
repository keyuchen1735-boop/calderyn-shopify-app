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
  const acct = await getConnectedAccount(shopId);
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

/** Base origin for the Stripe-hosted onboarding return/refresh redirects. */
export function onboardingOrigin(request: Request): string {
  return (
    process.env.DASHBOARD_PUBLIC_URL ??
    process.env.SHOPIFY_APP_URL ??
    new URL(request.url).origin
  ).replace(/\/$/, "");
}

/**
 * Create-or-reuse the Express account and mint a fresh hosted-onboarding link.
 * Idempotent on the account: one acct_ per shop (unique shop_id).
 * ponytail: two truly concurrent first clicks can orphan one test-mode Stripe
 * account (second insert loses on unique(shop_id)); harmless, not handled.
 */
export async function startOnboarding(shopId: string, origin: string): Promise<{ url: string }> {
  let acct = await getConnectedAccount(shopId);
  if (!acct) {
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
    acct = {
      shop_id: shopId,
      stripe_account_id: created.id,
      account_type: "express",
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      application_fee_bps: 0,
      application_fee_flat_cents: 0,
      country: created.country ?? "US",
      default_currency: created.default_currency ?? "usd",
      onboarded_at: null,
    };
  }
  const link = await getStripe().accountLinks.create({
    account: acct.stripe_account_id,
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
  expressDashboardUrl: string | null;
}

/** Dashboard DTO (never the raw row). Live Stripe reads degrade to null; they never 500 the screen. */
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
      expressDashboardUrl: null,
    };
  }
  let balance: BillingDTO["balance"] = null;
  let expressDashboardUrl: string | null = null;
  if (acct.details_submitted) {
    try {
      const stripe = getStripe();
      const [bal, login] = await Promise.all([
        stripe.balance.retrieve({}, { stripeAccount: acct.stripe_account_id }),
        stripe.accounts.createLoginLink(acct.stripe_account_id),
      ]);
      const shape = (rows: Array<{ amount: number; currency: string }>) =>
        rows.map((r) => ({ amountCents: r.amount, currency: r.currency }));
      balance = { available: shape(bal.available), pending: shape(bal.pending) };
      expressDashboardUrl = login.url;
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
    expressDashboardUrl,
  };
}
