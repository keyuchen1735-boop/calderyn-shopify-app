import type Stripe from "stripe";
import { getStripe } from "./stripe-client.server";
import { getSupabase } from "~/lib/supabase.server";
import { PaymentsNotReadyError, PayoutAccountError } from "./errors";

// Re-exported so charge sites can import error + readiness from one module; the classes
// themselves live in the dependency-free errors module for lightweight instanceof catches.
export { PaymentsNotReadyError, PayoutAccountError };

/**
 * Stripe Connect (#11): per-shop Express connected account, destination-charge
 * params, pull-based status sync, and the dashboard billing DTO. The PI itself
 * stays on the platform account — nothing here touches the webhook/order path.
 *
 * Routing policy (supersedes the spike-era "checkout never fails because of payout
 * plumbing" fallback): buyer money must land in the MERCHANT's Stripe account. A shop
 * whose connected account is missing or not fully enabled cannot take payments — every
 * charge site fails CLOSED with PaymentsNotReadyError (the storefront renders an honest
 * "not accepting payments yet" state) instead of silently settling into the platform
 * account. The single exemption is demo/showcase shops (shops.demo_mode), whose
 * simulated storefronts may charge the platform test account.
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

/** The one fully-enabled definition every payments surface must share. */
export function isFullyEnabledAccount(
  acct: Pick<ConnectedAccountRow, "charges_enabled" | "payouts_enabled" | "details_submitted">,
): boolean {
  return acct.charges_enabled && acct.payouts_enabled && acct.details_submitted;
}

/**
 * Fresh shops.demo_mode read for the MONEY seam. Deliberately NOT isShowcaseShop
 * (showcase.server.ts), whose process-lifetime cache is calibrated for cosmetic
 * action simulation: a demo→real flip must take effect on the next charge, not the
 * next deploy — a stale `true` would route real buyers' money to the platform
 * account. Mirrors the reset orchestrator's hard-gate stance (demo/reset.server.ts).
 * Fails toward "real shop" (false) on any error: unknown state must fail CLOSED.
 */
async function isDemoShopFresh(shopId: string): Promise<boolean> {
  try {
    const { data, error } = await getSupabase().from("shops").select("demo_mode").eq("id", shopId).maybeSingle();
    if (error) {
      console.error(`[stripe-connect] demo_mode lookup failed for shop ${shopId}; treating as real shop`, error);
      return false;
    }
    return Boolean((data as { demo_mode?: boolean } | null)?.demo_mode);
  } catch (err) {
    console.error(`[stripe-connect] demo_mode lookup threw for shop ${shopId}; treating as real shop`, err);
    return false;
  }
}

export type PaymentsReadiness =
  | { ready: true; route: "destination"; account: ConnectedAccountRow }
  | { ready: true; route: "platform" }
  | { ready: false; reason: "no_account" | "onboarding_incomplete" };

function isStripeTestMode(): boolean {
  return /^(?:sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY ?? "");
}

/**
 * Whether the shop can take a buyer's money RIGHT NOW, and where a charge would settle.
 * `destination` = fully-enabled connected account (the only route for real shops);
 * `platform` = demo/showcase shop charging the platform test account. Live and unknown
 * key modes fail closed even for demos. A read error on
 * stripe_connected_account propagates — a charge is never routed on unknown state.
 */
export async function paymentsReadiness(shopId: string): Promise<PaymentsReadiness> {
  const acct = await getConnectedAccount(shopId);
  if (acct && isFullyEnabledAccount(acct)) {
    return { ready: true, route: "destination", account: acct };
  }
  if (isStripeTestMode() && (await isDemoShopFresh(shopId))) return { ready: true, route: "platform" };
  return { ready: false, reason: acct ? "onboarding_incomplete" : "no_account" };
}

export interface DestinationDecision {
  params: Partial<
    Pick<Stripe.PaymentIntentCreateParams, "transfer_data" | "on_behalf_of" | "application_fee_amount">
  >;
  stripeAccountId: string | null;
  applicationFeeCents: number | null; // null = no fee param attached
}

/**
 * The single routing decision, shared by EVERY charge site (storefront PI, hosted
 * Checkout Session, ACP). Routes to a fully-onboarded account, permits a platform
 * charge only for demo shops, and FAILS CLOSED (PaymentsNotReadyError) for any real
 * shop that is not fully onboarded — buyer money is never silently stranded in the
 * platform account.
 *
 * `pre` lets a call site that already gated on paymentsReadiness (checkout, go-live
 * probe) reuse that decision instead of paying a second stripe_connected_account
 * read — ONE decision per charge, with Stripe's own destination validation as the
 * authoritative backstop if the account changes between the gate and the create.
 */
export async function destinationParamsFor(
  shopId: string,
  amountCents: number,
  pre?: PaymentsReadiness,
): Promise<DestinationDecision> {
  const readiness = pre ?? (await paymentsReadiness(shopId));
  if (!readiness.ready) throw new PaymentsNotReadyError(shopId, readiness.reason);
  if (readiness.route === "platform") {
    return { params: {}, stripeAccountId: null, applicationFeeCents: null };
  }
  const acct = readiness.account;
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
  /** null = demo-shop platform charge; acct_... = destination-routed to the merchant. */
  stripeAccountId: string | null;
  /** Fee actually attached at create; null = none. */
  applicationFeeCents: number | null;
}

/**
 * THE single PI-creation seam for routed charges — every PaymentIntent site
 * (storefront checkout, ACP agentic checkout, future sites) calls this so the
 * routing decision, the destination-rejection handling, and the row-stamping
 * values cannot drift apart per call site.
 *
 * Destination-rejection contract: ONLY a routed create rejected as a
 * StripeInvalidRequestError whose code/param implicates the destination account
 * (stale flags — the account was de-onboarded after our row said enabled) is
 * converted to PaymentsNotReadyError, with the stored flags re-synced so the next
 * load shows the honest state. No money has moved (a 400 is strictly
 * pre-authorization) and NOTHING retries as a platform charge — buyer money never
 * lands outside the merchant's account. A card decline (StripeCardError, 402),
 * an invalid-request WE caused, or any network/API error propagates untouched.
 *
 * ponytail: a keyed create (opts.idempotencyKey — the ACP path) that hits the
 * destination rejection burns its key on the cached 400 for ~24h, so that one
 * order cannot be re-charged until the key expires even after onboarding
 * completes. Accepted: a fresh-key retry could double-charge if the first
 * attempt actually succeeded, and correctness beats availability on a dormant path.
 */
export async function createRoutedPaymentIntent(
  shopId: string,
  base: Stripe.PaymentIntentCreateParams,
  opts: { logLabel?: string; idempotencyKey?: string; readiness?: PaymentsReadiness } = {},
): Promise<RoutedPaymentIntent> {
  const label = opts.logLabel ? `${opts.logLabel} ` : "";
  const dest = await destinationParamsFor(shopId, base.amount as number, opts.readiness);

  let pi: Stripe.PaymentIntent;
  const routedParams = { ...base, ...dest.params };
  try {
    // Callers without a key get the exact one-argument call (no trailing
    // undefined) so request shapes stay byte-stable for Stripe and tests.
    pi = opts.idempotencyKey
      ? await getStripe().paymentIntents.create(routedParams, { idempotencyKey: opts.idempotencyKey })
      : await getStripe().paymentIntents.create(routedParams);
  } catch (err) {
    const e = err as { type?: string; code?: string; param?: string };
    const destinationRejected =
      e.type === "StripeInvalidRequestError" &&
      (e.code === "account_invalid" || /transfer_data|on_behalf_of/.test(e.param ?? ""));
    if (dest.stripeAccountId && destinationRejected) {
      console.warn(
        `[stripe-connect] ${label}destination charge for shop ${shopId} rejected (${(err as Error).message}); stored flags are stale — failing closed`,
      );
      void syncAccountStatus(shopId).catch((e2) =>
        console.warn(`[stripe-connect] status re-sync failed for shop ${shopId}: ${(e2 as Error).message}`),
      );
      throw new PaymentsNotReadyError(shopId, "onboarding_incomplete");
    }
    throw err;
  }
  return { pi, stripeAccountId: dest.stripeAccountId, applicationFeeCents: dest.applicationFeeCents };
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

/** Anything the Stripe SDK raised (all its error classes tag `type: "Stripe…"`). */
function isStripeError(err: unknown): err is { type: string; message: string; raw?: { message?: string } } {
  const type = (err as { type?: unknown } | null)?.type;
  return typeof type === "string" && type.startsWith("Stripe");
}

/**
 * Stripe's unambiguous "this acct_ is not mine" rejection. Means the stored id was
 * minted under a DIFFERENT platform account (secret key rotated or switched between
 * test/live platforms) or the account was deleted in Stripe. Such a row is dead
 * weight: no link can be minted from it and no payout can ever route to it.
 */
function isUnknownAccountError(err: unknown): boolean {
  if (!isStripeError(err) || err.type !== "StripeInvalidRequestError") return false;
  if ((err as { code?: string }).code === "account_invalid") return true;
  return /not connected to your platform|does not exist|no such account/i.test(err.raw?.message ?? err.message ?? "");
}

/** Stripe failures reach the merchant as their own message; everything else keeps its type. */
function asPayoutError(err: unknown, what: string): unknown {
  return isStripeError(err) ? new PayoutAccountError(`${what}: ${err.raw?.message ?? err.message}`) : err;
}

async function mintOnboardingLink(stripeAccountId: string, origin: string): Promise<{ url: string }> {
  const link = await getStripe().accountLinks.create({
    account: stripeAccountId,
    type: "account_onboarding",
    return_url: `${origin}/dashboard/payouts/stripe/return`,
    refresh_url: `${origin}/dashboard/payouts/stripe/refresh`,
  });
  return { url: link.url };
}

/**
 * Create the Express account and either insert the shop's row or, when `replacing`
 * a dead id, overwrite it in place — shop_id is unique, so a second insert would
 * fail. Every status flag resets: the new account has submitted nothing, and
 * inheriting the old row's flags would tell the money seam it can route charges.
 */
async function provisionExpressAccount(shopId: string, replacing: string | null): Promise<string> {
  const created = await getStripe().accounts.create({
    type: "express",
    country: "US",
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    metadata: { shop_id: shopId },
  });
  const table = getSupabase().from("stripe_connected_account");
  const written = replacing
    ? await table
        .update({
          stripe_account_id: created.id,
          account_type: "express",
          country: created.country ?? "US",
          default_currency: created.default_currency ?? "usd",
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: false,
          onboarded_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("shop_id", shopId)
    : await table.insert({
        shop_id: shopId,
        stripe_account_id: created.id,
        account_type: "express",
        country: created.country ?? "US",
        default_currency: created.default_currency ?? "usd",
      });
  if (written.error) throw written.error;
  return created.id;
}

/**
 * Create-or-reuse the Express account and mint a fresh hosted-onboarding link.
 * Idempotent on the account: one acct_ per shop (unique shop_id).
 *
 * Self-heal: the stored id is a cache of Stripe's state, not the truth. If Stripe
 * says it doesn't own that account, a shop that never finished onboarding is
 * re-provisioned onto a fresh account — otherwise the row bricks the CTA forever
 * (every click 500s, with no merchant-reachable way out). A row that DID onboard
 * is never replaced: that case means the platform key is wrong, and minting a new
 * account would strand a real merchant's payouts behind an account nobody watches.
 *
 * ponytail: two truly concurrent first clicks can orphan one test-mode Stripe
 * account (second insert loses on unique(shop_id)); harmless, not handled.
 */
export async function startOnboarding(shopId: string, origin: string): Promise<{ url: string }> {
  const acct = await getConnectedAccount(shopId);
  if (!acct) {
    const created = await provisionExpressAccount(shopId, null);
    try {
      return await mintOnboardingLink(created, origin);
    } catch (err) {
      throw asPayoutError(err, "Stripe couldn't start payout setup");
    }
  }

  try {
    return await mintOnboardingLink(acct.stripe_account_id, origin);
  } catch (err) {
    if (!isUnknownAccountError(err)) throw asPayoutError(err, "Stripe couldn't start payout setup");

    if (acct.onboarded_at || isFullyEnabledAccount(acct)) {
      console.error(
        `[stripe-connect] onboarded account ${acct.stripe_account_id} for shop ${shopId} is unknown to the current platform key — refusing to re-provision`,
        err,
      );
      throw new PayoutAccountError(
        "Your payout account can't be reached with the current Stripe setup. Contact support — starting over here would disconnect the account your payouts run through.",
      );
    }

    console.warn(
      `[stripe-connect] stored account ${acct.stripe_account_id} for shop ${shopId} is unknown to the platform and never onboarded — re-provisioning`,
    );
    const replacement = await provisionExpressAccount(shopId, acct.stripe_account_id);
    try {
      return await mintOnboardingLink(replacement, origin);
    } catch (retryErr) {
      throw asPayoutError(retryErr, "Stripe couldn't start payout setup");
    }
  }
}

/** Pull API truth into the row (return URL / Settings load / explicit refresh / self-heal). */
export async function syncAccountStatus(
  shopId: string,
): Promise<{ chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean } | null> {
  const acct = await getConnectedAccount(shopId);
  if (!acct) return null;
  let remote: Stripe.Account;
  try {
    remote = await getStripe().accounts.retrieve(acct.stripe_account_id);
  } catch (err) {
    // Same orphaned-row cause startOnboarding self-heals from. Status sync must
    // never provision, so it names the state and points at the CTA that can.
    if (isUnknownAccountError(err)) {
      console.warn(
        `[stripe-connect] status sync for shop ${shopId} hit an account (${acct.stripe_account_id}) the platform doesn't recognize`,
      );
      throw new PayoutAccountError(
        "Stripe no longer recognizes this payout account. Choose Resume onboarding to set payouts up again.",
      );
    }
    throw asPayoutError(err, "Stripe couldn't read your payout status");
  }
  const flags = {
    charges_enabled: Boolean(remote.charges_enabled),
    payouts_enabled: Boolean(remote.payouts_enabled),
    details_submitted: Boolean(remote.details_submitted),
  };
  const fullyEnabled = isFullyEnabledAccount(flags);
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

/**
 * Apply a fresh Stripe Account snapshot (from an `account.updated` webhook) to the stored
 * connected-account row, keyed by the Stripe account id. This is the async-enablement path: a
 * Stripe Express account whose charges/payouts flip to enabled AFTER the buyer returns from
 * onboarding emits account.updated, and without handling it the stored row stays
 * charges_enabled=false forever — so destinationParamsFor keeps routing every storefront/ACP
 * PaymentIntent to the PLATFORM account instead of the merchant's now-live account, and Settings
 * shows "Onboarding incomplete" indefinitely. Trusts the event's account object (its current flags)
 * rather than an extra accounts.retrieve. Returns true if a connected-account row was updated,
 * false if no row matched the account id (the event is for an account we don't track — not ours).
 */
export async function applyAccountUpdate(account: Stripe.Account): Promise<boolean> {
  const flags = {
    charges_enabled: Boolean(account.charges_enabled),
    payouts_enabled: Boolean(account.payouts_enabled),
    details_submitted: Boolean(account.details_submitted),
  };
  const existing = await getSupabase()
    .from("stripe_connected_account")
    .select("shop_id, onboarded_at")
    .eq("stripe_account_id", account.id)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (!existing.data) return false; // account not linked to any shop — not ours to sync
  const fullyEnabled = isFullyEnabledAccount(flags);
  const alreadyOnboarded = (existing.data as { onboarded_at: string | null }).onboarded_at;
  const upd = await getSupabase()
    .from("stripe_connected_account")
    .update({
      ...flags,
      updated_at: new Date().toISOString(),
      // Stamp onboarded_at the first time the account becomes fully enabled (mirrors syncAccountStatus).
      ...(fullyEnabled && !alreadyOnboarded ? { onboarded_at: new Date().toISOString() } : {}),
    })
    .eq("stripe_account_id", account.id);
  if (upd.error) throw upd.error;
  return true;
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
  try {
    const login = await getStripe().accounts.createLoginLink(acct.stripe_account_id);
    return { url: login.url };
  } catch (err) {
    // Same orphaned-row cause startOnboarding/syncAccountStatus surface: a row we
    // think is onboarded whose account Stripe no longer recognizes. Convert to a
    // merchant-readable PayoutAccountError so the caller shows what actually went
    // wrong instead of an opaque internal_error, matching the sibling intents.
    if (isUnknownAccountError(err)) {
      throw new PayoutAccountError(
        "Stripe no longer recognizes this payout account. Choose Resume onboarding to set payouts up again.",
      );
    }
    throw asPayoutError(err, "Stripe couldn't open your payout dashboard");
  }
}
