// Merchant ship-rules storage (ship_rules table): the per-shop knobs the engine's
// rule layer (rules.ts) applies — markup %, flat handling fee, free-shipping
// threshold, and the origin handling window for delivery dates. Absent row =
// neutral defaults (no markup, no fee, no free-ship, 1-day handling), so a shop
// that never touched the settings quotes exactly as before.
import { getSupabase } from "~/lib/supabase.server";
import type { MerchantShipRules } from "./quote";
import { DEFAULT_HANDLING_DAYS } from "./delivery-window";

export interface ShipRulesDto {
  markupPct: number;
  handlingCents: number;
  freeShipThresholdCents: number | null;
  handlingDays: number;
  /** Offer a free "Pick up" option at checkout, fulfilled from shop_origin (one location v1). */
  pickupEnabled: boolean;
  /** Optional buyer-facing pickup instructions (hours, entrance, …), shown under the option. */
  pickupNote: string | null;
}

export const DEFAULT_SHIP_RULES: ShipRulesDto = {
  markupPct: 0,
  handlingCents: 0,
  freeShipThresholdCents: null,
  handlingDays: DEFAULT_HANDLING_DAYS,
  pickupEnabled: false,
  pickupNote: null,
};

export async function loadShipRules(shopId: string): Promise<ShipRulesDto> {
  if (!shopId) throw new Error("shopId is required");
  const { data, error } = await getSupabase()
    .from("ship_rules")
    .select("markup_pct, handling_cents, free_ship_threshold_cents, handling_days, pickup_enabled, pickup_note")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw new Error(`ship_rules read failed: ${error.message}`);
  if (!data) return { ...DEFAULT_SHIP_RULES };
  return {
    markupPct: Number(data.markup_pct ?? 0),
    handlingCents: Number(data.handling_cents ?? 0),
    freeShipThresholdCents:
      data.free_ship_threshold_cents == null ? null : Number(data.free_ship_threshold_cents),
    handlingDays: Number(data.handling_days ?? DEFAULT_HANDLING_DAYS),
    pickupEnabled: data.pickup_enabled === true,
    pickupNote: data.pickup_note == null ? null : String(data.pickup_note),
  };
}

export async function saveShipRules(shopId: string, rules: ShipRulesDto): Promise<void> {
  if (!shopId) throw new Error("shopId is required");
  const { error } = await getSupabase()
    .from("ship_rules")
    .upsert(
      {
        shop_id: shopId,
        markup_pct: rules.markupPct,
        handling_cents: rules.handlingCents,
        free_ship_threshold_cents: rules.freeShipThresholdCents,
        handling_days: rules.handlingDays,
        pickup_enabled: rules.pickupEnabled,
        pickup_note: rules.pickupNote,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "shop_id" },
    );
  if (error) throw new Error(`ship_rules write failed: ${error.message}`);
}

/**
 * The engine-facing rules for a quote. `variantHandlingDaysMax` lets callers fold
 * per-variant handling (variant_shipping.handling_days) into the window: the
 * slowest item in the cart sets the shipment's handling time, floored by the
 * shop-level rule. Zero-value knobs are omitted so the engine cache key for an
 * untouched shop stays identical to passing no rules at all.
 */
export function toMerchantShipRules(
  dto: ShipRulesDto,
  variantHandlingDaysMax = 0,
): MerchantShipRules {
  const rules: MerchantShipRules = {};
  if (dto.markupPct !== 0) rules.markupPct = dto.markupPct;
  if (dto.handlingCents > 0) rules.handlingCents = dto.handlingCents;
  if (dto.freeShipThresholdCents != null) rules.freeShipThresholdCents = dto.freeShipThresholdCents;
  const handlingDays = Math.max(dto.handlingDays, variantHandlingDaysMax);
  if (handlingDays !== DEFAULT_HANDLING_DAYS) rules.handlingDays = handlingDays;
  return rules;
}
