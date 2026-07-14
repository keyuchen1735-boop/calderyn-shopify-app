import { getSupabase } from "~/lib/supabase.server";

export const FIRST_RUN_GENERATION_LIMIT = 3;
export const FIRST_RUN_SHOP_DAILY_LIMIT = 30;

export type FirstRunGenerationReservation =
  | {
      ok: true;
      kind: "reserved";
      id: string;
      regenerationsLeft: number;
    }
  | {
      ok: true;
      kind: "replay";
      result: unknown;
      regenerationsLeft: number;
    }
  | {
      ok: false;
      regenerationsLeft: number;
      reason: "in_progress" | "daily_limit";
    };

type AtomicReservation =
  | { outcome: "reserved"; id: string; regenerationsLeft: number }
  | { outcome: "replay"; result: unknown; regenerationsLeft: number }
  | {
      outcome: "in_progress" | "daily_limit";
      regenerationsLeft: number;
    };

interface GenerationAttemptDeps {
  reserve: (input: {
    shopId: string;
    runId: string;
    productId: string;
    attempt: number;
  }) => Promise<AtomicReservation>;
  markStarted: (
    shopId: string,
    id: string,
    failureResult: unknown,
  ) => Promise<void>;
  complete: (shopId: string, id: string, result: unknown) => Promise<void>;
  remove: (shopId: string, id: string) => Promise<void>;
}

const defaultDeps: GenerationAttemptDeps = {
  async reserve(input) {
    const { data, error } = await getSupabase()
      .rpc("reserve_campaign_wizard_generation_attempt", {
        p_shop_id: input.shopId,
        p_run_id: input.runId,
        p_product_id: input.productId,
        p_attempt: input.attempt,
      })
      .single();
    if (error) throw error;
    const row = data as {
      reservation_id: string | null;
      outcome: "reserved" | "replay" | "in_progress" | "daily_limit";
      regenerations_left: number;
      saved_result: unknown;
    };
    if (row.outcome === "reserved" && row.reservation_id) {
      return {
        outcome: "reserved",
        id: row.reservation_id,
        regenerationsLeft: Number(row.regenerations_left),
      };
    }
    if (row.outcome === "replay") {
      return {
        outcome: "replay",
        result: row.saved_result,
        regenerationsLeft: Number(row.regenerations_left),
      };
    }
    if (row.outcome === "in_progress" || row.outcome === "daily_limit") {
      return {
        outcome: row.outcome,
        regenerationsLeft: Number(row.regenerations_left),
      };
    }
    throw new Error("generation reservation returned an invalid result");
  },
  async markStarted(shopId, id, failureResult) {
    const { data, error } = await getSupabase()
      .from("campaign_wizard_generation_attempt")
      .update({
        provider_started_at: new Date().toISOString(),
        failure_result: failureResult,
      })
      .eq("shop_id", shopId)
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("generation reservation no longer exists");
  },
  async complete(shopId, id, result) {
    const { data, error } = await getSupabase()
      .from("campaign_wizard_generation_attempt")
      .update({ result, completed_at: new Date().toISOString() })
      .eq("shop_id", shopId)
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("generation reservation no longer exists");
  },
  async remove(shopId, id) {
    const { error } = await getSupabase()
      .from("campaign_wizard_generation_attempt")
      .delete()
      .eq("shop_id", shopId)
      .eq("id", id)
      .is("provider_started_at", null);
    if (error) throw error;
  },
};

/**
 * Persist the safe fallback before the first paid provider call. From this
 * point the attempt is cost-bearing and must never be released or re-billed.
 */
export async function markFirstRunGenerationStarted(
  shopId: string,
  reservationId: string,
  failureResult: unknown,
  deps: GenerationAttemptDeps = defaultDeps,
): Promise<void> {
  await deps.markStarted(shopId, reservationId, failureResult);
}

/**
 * Atomically reserve one exact request slot. The database function serializes
 * reservations per shop, applies the rolling daily ceiling, and replays a
 * completed duplicate so navigation or a lost HTTP response never burns a set.
 */
export async function reserveFirstRunGeneration(
  shopId: string,
  runId: string,
  productId: string,
  attempt: number,
  deps: GenerationAttemptDeps = defaultDeps,
): Promise<FirstRunGenerationReservation> {
  const reserved = await deps.reserve({ shopId, runId, productId, attempt });
  if (reserved.outcome === "reserved") {
    return {
      ok: true,
      kind: "reserved",
      id: reserved.id,
      regenerationsLeft: reserved.regenerationsLeft,
    };
  }
  if (reserved.outcome === "replay") {
    return {
      ok: true,
      kind: "replay",
      result: reserved.result,
      regenerationsLeft: reserved.regenerationsLeft,
    };
  }
  return {
    ok: false,
    regenerationsLeft: reserved.regenerationsLeft,
    reason: reserved.outcome,
  };
}

/** Store the complete browser response for idempotent request replay. */
export async function completeFirstRunGeneration(
  shopId: string,
  reservationId: string,
  result: unknown,
  deps: GenerationAttemptDeps = defaultDeps,
): Promise<void> {
  await deps.complete(shopId, reservationId, result);
}

/** Release a request only when no paid provider was invoked. */
export async function releaseFirstRunGeneration(
  shopId: string,
  reservationId: string,
  deps: GenerationAttemptDeps = defaultDeps,
): Promise<void> {
  await deps.remove(shopId, reservationId);
}
