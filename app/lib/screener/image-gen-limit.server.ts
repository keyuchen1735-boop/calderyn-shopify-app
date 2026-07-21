// app/lib/screener/image-gen-limit.server.ts
// Cost guardrails for image generation: a per-shop and a global
// daily cap on image generations. The limit DECISION is pure (testable); the
// counting + reservation hit Supabase. Copy generation is unaffected.
import { randomUUID } from "node:crypto";
import { getSupabase, resolveShopId } from "../supabase.server";

export interface ImageGenLimits {
  perShopDaily: number;
  globalDaily: number;
}

const DEFAULT_PER_SHOP_DAILY = 9;
const DEFAULT_GLOBAL_DAILY = 30;

export interface ImageGenerationMetadata {
  generationId?: string;
  provider: string;
  model: string;
  purpose: string;
}

export interface ImageGenerationUsage {
  providerRequestId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  thoughtTokens?: number | null;
  estimatedCostUsdMicros: number;
}

function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Daily caps, env-tunable (`IMAGE_GEN_DAILY_PER_SHOP`, `IMAGE_GEN_DAILY_GLOBAL`). */
export function imageGenLimits(): ImageGenLimits {
  return {
    perShopDaily: positiveIntEnv(
      "IMAGE_GEN_DAILY_PER_SHOP",
      DEFAULT_PER_SHOP_DAILY,
    ),
    globalDaily: positiveIntEnv("IMAGE_GEN_DAILY_GLOBAL", DEFAULT_GLOBAL_DAILY),
  };
}

export type LimitDecision =
  | { ok: true }
  | { ok: false; scope: "shop" | "global"; limit: number };

/** Pure: per-shop cap is checked before the global backstop. */
export function decideImageGenLimit(args: {
  shopCount: number;
  globalCount: number;
  perShopDaily: number;
  globalDaily: number;
}): LimitDecision {
  if (args.shopCount >= args.perShopDaily) {
    return { ok: false, scope: "shop", limit: args.perShopDaily };
  }
  if (args.globalCount >= args.globalDaily) {
    return { ok: false, scope: "global", limit: args.globalDaily };
  }
  return { ok: true };
}

export type ReserveResult =
  | { ok: true; remaining: number; eventId: string | null }
  | { ok: false; scope: "shop" | "global"; limit: number };

const EVENT_TABLE = "image_gen_event";

/**
 * Count today's image generations (this shop + global) and, if both caps allow,
 * reserve a slot by inserting one event row. A blocked attempt inserts nothing,
 * so spam can't inflate the global counter. `now` is injectable for tests.
 */
export async function checkAndReserveImageGen(
  shop: string,
  now: Date = new Date(),
): Promise<ReserveResult> {
  const reserved = await reserveImageGenSlots(shop, 1, now);
  if (!reserved.ok) return reserved;
  return {
    ok: true,
    remaining: reserved.remaining,
    eventId: reserved.eventIds[0] ?? null,
  };
}

export type ReserveSlotsResult =
  | { ok: true; eventIds: string[]; generationId: string; remaining: number }
  | { ok: false; scope: "shop" | "global"; limit: number };

const LEGACY_METADATA: ImageGenerationMetadata = {
  provider: "gemini",
  model: "gemini-3.1-flash-lite-image",
  purpose: "legacy",
};

/**
 * Atomically reserve a complete batch. Database advisory locks cover the
 * count-and-insert decision so concurrent instances cannot overshoot either
 * the per-shop ceiling or the global backstop.
 *
 * `limits` overrides the env-derived daily caps for THIS reservation only —
 * limits are parameters into the reservation RPC, so a caller with a reserved
 * allowance (the designer's first build) raises its own ceiling without
 * touching the RPC's counting semantics or any other caller's budget.
 */
export async function reserveImageGenSlots(
  shop: string,
  count: number,
  now: Date = new Date(),
  metadata: ImageGenerationMetadata = LEGACY_METADATA,
  limits?: Partial<ImageGenLimits>,
): Promise<ReserveSlotsResult> {
  if (!Number.isInteger(count) || count < 1 || count > 12) {
    throw new Error("image generation count must be between 1 and 12");
  }
  const shopId = await resolveShopId(shop);
  const generationId = metadata.generationId ?? randomUUID();
  const day = now.toISOString().slice(0, 10);
  const { perShopDaily, globalDaily } = { ...imageGenLimits(), ...limits };
  const { data, error } = await getSupabase()
    .rpc("reserve_image_generation_slots", {
      p_shop_id: shopId,
      p_count: count,
      p_per_shop_daily: perShopDaily,
      p_global_daily: globalDaily,
      p_day: day,
      p_generation_id: generationId,
      p_provider: metadata.provider,
      p_model: metadata.model,
      p_purpose: metadata.purpose,
    })
    .single();
  if (error) throw error;
  const row = data as {
    event_ids: string[] | null;
    blocked_scope: "shop" | "global" | null;
    limit_value: number | null;
    remaining: number;
  };
  if (row.blocked_scope) {
    return {
      ok: false,
      scope: row.blocked_scope,
      limit: Number(row.limit_value ?? 0),
    };
  }
  const eventIds = Array.isArray(row.event_ids) ? row.event_ids : [];
  if (eventIds.length !== count) {
    throw new Error(
      "image generation reservation returned the wrong slot count",
    );
  }
  return {
    ok: true,
    eventIds,
    generationId,
    remaining: Number(row.remaining),
  };
}

/** Mark the exact point at which a provider request becomes cost-bearing. */
export async function markImageGenStarted(eventId: string): Promise<void> {
  const { data, error } = await getSupabase()
    .from(EVENT_TABLE)
    .update({ provider_started_at: new Date().toISOString() })
    .eq("id", eventId)
    .eq("status", "reserved")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("image generation reservation no longer exists");
}

/** Persist provider usage and the estimated USD cost for one image request. */
export async function completeImageGen(
  eventId: string,
  result:
    | { status: "succeeded"; usage: ImageGenerationUsage }
    | { status: "failed"; errorCode: string; usage?: ImageGenerationUsage },
): Promise<void> {
  const usage = result.usage;
  const { data, error } = await getSupabase()
    .from(EVENT_TABLE)
    .update({
      status: result.status,
      completed_at: new Date().toISOString(),
      provider_request_id: usage?.providerRequestId ?? null,
      input_tokens: usage?.inputTokens ?? null,
      output_tokens: usage?.outputTokens ?? null,
      thought_tokens: usage?.thoughtTokens ?? null,
      estimated_cost_usd_micros: usage?.estimatedCostUsdMicros ?? 0,
      error_code: result.status === "failed" ? result.errorCode : null,
    })
    .eq("id", eventId)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("image generation event no longer exists");
}

/**
 * Release only a reservation that never reached the provider. A cost-bearing
 * request stays in the daily ceiling even if it fails, preventing retry storms.
 */
export async function releaseImageGen(eventId: string | null): Promise<void> {
  if (!eventId) return;
  try {
    await getSupabase()
      .from(EVENT_TABLE)
      .delete()
      .eq("id", eventId)
      .eq("status", "reserved")
      .is("provider_started_at", null);
  } catch {
    /* best-effort */
  }
}
