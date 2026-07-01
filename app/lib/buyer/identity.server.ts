// Guest buyer identity (platform pivot #1). Server-only helpers over the buyer-side PII
// store (buyer_dim / buyer_address / buyer_consent) — tables that live DELIBERATELY OUTSIDE
// the analytics warehouse so no buyer PII ever reaches order_fact.
//
// Access pattern mirrors payments/stripe.server.ts and ship-cost/unmatched.server.ts: the
// app reaches Postgres only through the service-role client (getSupabase, BYPASSRLS), and
// EVERY query threads shop_id explicitly so a row can never cross tenants. The migration's
// `shop_id = current_shop_id()` RLS policies are the buyer-scoped guard for the PostgREST
// (anon/authenticated) path; this module is the application path and is shop-scoped here.
//
// Guest-only: no password / login. Flat address schema, no i18n/format validation (pilot
// scope). DTOs are shaped (snake_case rows -> camelCase) so Supabase row shapes don't leak.

import { getSupabase } from "~/lib/supabase.server";

export type AddressKind = "shipping" | "billing";
export type ConsentPolicy = "tos" | "privacy" | "marketing";

export interface Buyer {
  id: string;
  shopId: string;
  emailNormalized: string;
  phone: string | null;
  createdAt: string;
}

export interface BuyerAddressInput {
  kind: AddressKind;
  name?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postal?: string | null;
  country?: string | null;
  phone?: string | null;
  isDefault?: boolean;
}

export interface BuyerAddress {
  id: string;
  buyerId: string;
  kind: AddressKind;
  name: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postal: string | null;
  country: string | null;
  phone: string | null;
  isDefault: boolean;
}

export interface ConsentInput {
  policy: ConsentPolicy;
  version: string;
  accepted: boolean;
  /** Captured as legal proof of who/where accepted. */
  sourceIp?: string | null;
  ua?: string | null;
  /** Defaults to now() in the DB when omitted. */
  capturedAt?: string;
}

export interface BuyerConsent {
  id: string;
  buyerId: string;
  policy: ConsentPolicy;
  version: string;
  accepted: boolean;
  sourceIp: string | null;
  ua: string | null;
  capturedAt: string;
}

const ADDRESS_KINDS = new Set<AddressKind>(["shipping", "billing"]);
const CONSENT_POLICIES = new Set<ConsentPolicy>(["tos", "privacy", "marketing"]);

/** Lowercase + trim. The single normalization point so the unique(shop_id, email) key holds. */
export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  // Minimal presence/shape check — NOT full RFC validation (out of scope for the PII store).
  if (!email || !email.includes("@")) {
    throw new Error("A valid email is required to identify a buyer.");
  }
  return email;
}

function trimOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Upsert a guest buyer, keyed by (shop_id, normalized email). Idempotent: the same email +
 * shop always resolves to the same buyer row. phone is only written when the caller provides
 * it, so a later call without a phone never clobbers one captured earlier.
 */
export async function upsertGuestBuyer(
  shopId: string,
  input: { email: string; phone?: string | null },
): Promise<Buyer> {
  if (!shopId) throw new Error("shopId is required");
  const emailNormalized = normalizeEmail(input.email);

  const payload: Record<string, unknown> = { shop_id: shopId, email_normalized: emailNormalized };
  if (input.phone !== undefined) payload.phone = trimOrNull(input.phone);

  const { data, error } = await getSupabase()
    .from("buyer_dim")
    .upsert(payload, { onConflict: "shop_id,email_normalized" })
    .select("id, shop_id, email_normalized, phone, created_at")
    .single();
  if (error) throw error;
  if (!data) throw new Error("buyer_dim upsert returned no row");
  return mapBuyer(data as Record<string, unknown>);
}

/**
 * Add a shipping or billing address for a buyer. Flat schema, no i18n/format validation —
 * only a presence guard (kind enum + line1 + country) so an unusable address fails visibly
 * (rule 12). When isDefault is set, the prior default for the same (buyer, kind) is cleared
 * first; the buyer_address_one_default partial unique index is the hard guarantee.
 */
export async function addBuyerAddress(
  shopId: string,
  buyerId: string,
  input: BuyerAddressInput,
): Promise<BuyerAddress> {
  if (!shopId) throw new Error("shopId is required");
  if (!buyerId) throw new Error("buyerId is required");
  if (!ADDRESS_KINDS.has(input.kind)) {
    throw new Error(`address kind must be 'shipping' or 'billing', got ${String(input.kind)}`);
  }
  const line1 = input.line1?.trim() ?? "";
  const country = input.country?.trim() ?? "";
  if (!line1) throw new Error("address line1 is required");
  if (!country) throw new Error("address country is required");

  const sb = getSupabase();
  const isDefault = input.isDefault === true;
  // ponytail: clear+insert is two non-tx PostgREST calls — transient zero-default if the
  // insert fails after the clear (benign, self-heals on retry; partial-unique index still
  // blocks two defaults). Upgrade: fold into a security-definer RPC like record_stripe_event
  // if atomicity is needed.
  if (isDefault) {
    const clr = await sb
      .from("buyer_address")
      .update({ is_default: false })
      .eq("shop_id", shopId)
      .eq("buyer_id", buyerId)
      .eq("kind", input.kind)
      .eq("is_default", true);
    if (clr.error) throw clr.error;
  }

  const { data, error } = await sb
    .from("buyer_address")
    .insert({
      shop_id: shopId,
      buyer_id: buyerId,
      kind: input.kind,
      name: trimOrNull(input.name),
      line1,
      line2: trimOrNull(input.line2),
      city: trimOrNull(input.city),
      region: trimOrNull(input.region),
      postal: trimOrNull(input.postal),
      country,
      phone: trimOrNull(input.phone),
      is_default: isDefault,
    })
    .select("id, buyer_id, kind, name, line1, line2, city, region, postal, country, phone, is_default")
    .single();
  if (error) throw error;
  if (!data) throw new Error("buyer_address insert returned no row");
  return mapAddress(data as Record<string, unknown>);
}

/**
 * Record one consent decision (append-only). version + captured_at are the proof of which
 * policy text was accepted; source_ip + ua are the proof of who/where. A withdrawal is a new
 * row with accepted=false — never an update.
 */
export async function recordConsent(
  shopId: string,
  buyerId: string,
  input: ConsentInput,
): Promise<BuyerConsent> {
  if (!shopId) throw new Error("shopId is required");
  if (!buyerId) throw new Error("buyerId is required");
  if (!CONSENT_POLICIES.has(input.policy)) {
    throw new Error(`consent policy must be tos|privacy|marketing, got ${String(input.policy)}`);
  }
  const version = input.version?.trim();
  if (!version) {
    throw new Error("consent version is required (proof of which policy text was accepted)");
  }

  const row: Record<string, unknown> = {
    shop_id: shopId,
    buyer_id: buyerId,
    policy: input.policy,
    version,
    accepted: input.accepted,
    source_ip: trimOrNull(input.sourceIp),
    ua: trimOrNull(input.ua),
  };
  if (input.capturedAt) row.captured_at = input.capturedAt;

  const { data, error } = await getSupabase()
    .from("buyer_consent")
    .insert(row)
    .select("id, buyer_id, policy, version, accepted, source_ip, ua, captured_at")
    .single();
  if (error) throw error;
  if (!data) throw new Error("buyer_consent insert returned no row");
  return mapConsent(data as Record<string, unknown>);
}

/**
 * Checkout consent capture: ToS + privacy are required acceptances; marketing is an explicit
 * opt-in boolean. One call records all three with the same version + proof (source_ip / ua).
 */
export async function recordCheckoutConsent(
  shopId: string,
  buyerId: string,
  input: {
    version: string;
    marketingOptIn: boolean;
    sourceIp?: string | null;
    ua?: string | null;
    capturedAt?: string;
  },
): Promise<BuyerConsent[]> {
  const proof = {
    version: input.version,
    sourceIp: input.sourceIp,
    ua: input.ua,
    capturedAt: input.capturedAt,
  };
  // ponytail: three sequential non-tx PostgREST inserts — a mid-sequence failure can leave a
  // partial consent set (each row is append-only and independently valid, so it self-heals on
  // retry). Upgrade: fold into a security-definer RPC like record_stripe_event if atomicity is needed.
  const tos = await recordConsent(shopId, buyerId, { ...proof, policy: "tos", accepted: true });
  const privacy = await recordConsent(shopId, buyerId, { ...proof, policy: "privacy", accepted: true });
  const marketing = await recordConsent(shopId, buyerId, {
    ...proof,
    policy: "marketing",
    accepted: input.marketingOptIn,
  });
  return [tos, privacy, marketing];
}

function mapBuyer(row: Record<string, unknown>): Buyer {
  return {
    id: String(row.id),
    shopId: String(row.shop_id),
    emailNormalized: String(row.email_normalized),
    phone: row.phone == null ? null : String(row.phone),
    createdAt: String(row.created_at),
  };
}

function mapAddress(row: Record<string, unknown>): BuyerAddress {
  return {
    id: String(row.id),
    buyerId: String(row.buyer_id),
    kind: row.kind as AddressKind,
    name: row.name == null ? null : String(row.name),
    line1: row.line1 == null ? null : String(row.line1),
    line2: row.line2 == null ? null : String(row.line2),
    city: row.city == null ? null : String(row.city),
    region: row.region == null ? null : String(row.region),
    postal: row.postal == null ? null : String(row.postal),
    country: row.country == null ? null : String(row.country),
    phone: row.phone == null ? null : String(row.phone),
    isDefault: row.is_default === true,
  };
}

function mapConsent(row: Record<string, unknown>): BuyerConsent {
  return {
    id: String(row.id),
    buyerId: String(row.buyer_id),
    policy: row.policy as ConsentPolicy,
    version: String(row.version),
    accepted: row.accepted === true,
    sourceIp: row.source_ip == null ? null : String(row.source_ip),
    ua: row.ua == null ? null : String(row.ua),
    capturedAt: String(row.captured_at),
  };
}
