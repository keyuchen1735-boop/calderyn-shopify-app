// app/lib/screener/image-gen-limit.server.ts
// Cost guardrails for the shared Higgsfield account: a per-shop and a global
// daily cap on image generations. The limit DECISION is pure (testable); the
// counting + reservation hit Supabase. Copy generation is unaffected.
import { getSupabase, resolveShopId } from "../supabase.server";

export interface ImageGenLimits {
  perShopDaily: number;
  globalDaily: number;
}

const DEFAULT_PER_SHOP_DAILY = 20;
const DEFAULT_GLOBAL_DAILY = 300;

function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Daily caps, env-tunable (`IMAGE_GEN_DAILY_PER_SHOP`, `IMAGE_GEN_DAILY_GLOBAL`). */
export function imageGenLimits(): ImageGenLimits {
  return {
    perShopDaily: positiveIntEnv("IMAGE_GEN_DAILY_PER_SHOP", DEFAULT_PER_SHOP_DAILY),
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
  | { ok: true; remaining: number }
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
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const day = now.toISOString().slice(0, 10); // UTC day
  const { perShopDaily, globalDaily } = imageGenLimits();

  const shopRes = await sb
    .from(EVENT_TABLE)
    .select("*", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .eq("day", day);
  const globalRes = await sb
    .from(EVENT_TABLE)
    .select("*", { count: "exact", head: true })
    .eq("day", day);

  const shopCount = Number((shopRes as { count?: number | null }).count ?? 0);
  const globalCount = Number((globalRes as { count?: number | null }).count ?? 0);

  const decision = decideImageGenLimit({ shopCount, globalCount, perShopDaily, globalDaily });
  if (!decision.ok) return decision;

  await sb.from(EVENT_TABLE).insert({ shop_id: shopId, day });
  return { ok: true, remaining: Math.max(perShopDaily - shopCount - 1, 0) };
}
