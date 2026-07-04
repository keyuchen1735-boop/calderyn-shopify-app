// app/lib/demo/reset.server.ts
//
// resetDemoShowcase: wipe a DEMO shop back to its opening scene and reseed it
// deterministically (Peak & Pine facts → catalog promote → showcase layer).
// The demo_mode re-read at the top is the hard gate — this function is the
// last line of defense between the reset button and a real merchant's data,
// so it must stay unreachable unless shops.demo_mode is true.
//
// Not transactional (PostgREST batches), matching the seed writer's contract:
// any error aborts loudly, and because the wipe runs first the whole
// operation is idempotent — pressing the button again finishes the job.

import { CalderynError } from "../calderyn.server";
import { generateSeedDataset } from "../seed/dataset";
import { writeSeedDataset, wipeShopTables, insertRowsBatched } from "../seed/writer";
import { generateShowcaseLayer } from "./showcase-seed";
import type { ShowcaseLayer } from "./showcase-seed";

/** Superset of the seed writer's client shape: adds the reads/updates/rpc the
 *  orchestrator needs. Standalone (not `extends SeedWriterClient`) and
 *  satisfied via an explicit cast at the call sites — supabase-js's generics
 *  recurse past TS's instantiation depth when checked structurally here, but
 *  every method below is a plain PostgREST builder the client guarantees. */
export interface ShowcaseResetClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
      };
    };
    delete(): { eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }> };
    insert(rows: Record<string, unknown>[]): PromiseLike<{ error: { message: string } | null }>;
    upsert(
      row: Record<string, unknown>,
      opts?: { onConflict?: string },
    ): PromiseLike<{ error: { message: string } | null }>;
    update(patch: Record<string, unknown>): {
      eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }>;
    };
  };
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/**
 * Demo-activity tables the seed writer does NOT wipe, children before
 * parents. Runs BEFORE writeSeedDataset so rows that FK onto the writer's
 * tables (undo_token → action_audit, order_line → variant/orders, …) are
 * gone by the time the writer deletes its own list.
 */
export const SHOWCASE_WIPE_ORDER = [
  // engine feedback + learned state
  "undo_token",
  "action_feedback",
  "alert_feedback",
  "alert_thresholds",
  "calibration_rule",
  "pair_calibration",
  "autopilot_run_lock",
  "campaign_direction_reason",
  "purchase_order_draft",
  "sku_reorder_belief",
  "creative_screen_run",
  "campaign_draft",
  // assistant
  "assistant_messages",
  "assistant_conversations",
  // owned checkout + money movement
  "acp_session",
  "transaction_ledger",
  "payment_intent",
  "cart_line",
  "checkout_session",
  "cart",
  "order_state_transition",
  "order_line",
  "orders",
  "raw_owned_event",
  "storefront_event",
  "commerce_quote_fact",
  // owned inventory
  "inventory_reservation",
  "inventory_transfer",
  "inventory_ledger",
  "inventory_balance",
  // buyer spine
  "buyer_address",
  "buyer_consent",
  "buyer_dim",
  // store studio
  "store_asset",
  "store_generation_proposal",
  "store_generation",
  "page_document",
  // imported history (sku_id FKs are ON DELETE SET NULL onto sku_dim — left
  // behind they'd survive a reset with NULLed links; children first)
  "imported_order_line",
  "imported_refund",
  "imported_order",
  // owned catalog (import_map bridges onto variant ids — wipe it first).
  // product_media / option tables / product_collection are NOT listed: they
  // have no shop_id column and cascade from product_dim / variant_dim /
  // collection_dim deletes below.
  "import_map",
  "import_run",
  "collection_dim",
  "variant_shipping",
  "variant_dim",
  "product_dim",
  // cutover history
  "cutover_transition",
] as const;

export interface ResetSummary {
  wiped: string[];
  inserted: Record<string, number>;
  promoted: Record<string, unknown>;
}

/** Owned-layer tables in insert order (parents → children). */
function layerInserts(layer: ShowcaseLayer): [string, Record<string, unknown>[]][] {
  return [
    ["buyer_dim", layer.buyers],
    ["buyer_address", layer.buyerAddresses],
    ["buyer_consent", layer.buyerConsents],
    ["orders", layer.ownedOrders],
    ["order_line", layer.ownedOrderLines],
    ["order_state_transition", layer.orderTransitions],
    ["alerts", layer.alerts],
    ["alert_context", layer.alertContexts],
    ["pair_calibration", layer.pairCalibration],
    ["action_audit", layer.auditRows],
    ["variant_shipping", layer.variantShipping],
  ];
}

export async function resetDemoShowcase(
  shopId: string,
  sb: ShowcaseResetClient,
  opts?: { today?: string },
): Promise<ResetSummary> {
  // Hard gate: re-read demo_mode here, not at the caller.
  const { data: shop, error: shopErr } = await sb
    .from("shops")
    .select("demo_mode")
    .eq("id", shopId)
    .maybeSingle();
  if (shopErr) throw new Error(`demo reset: shops read failed: ${shopErr.message}`);
  if (shop?.demo_mode !== true) {
    throw new CalderynError({
      code: "not_demo_shop",
      status: 409,
      message: "Demo reset is only available on demo shops.",
    });
  }

  const today = opts?.today ?? new Date().toISOString().slice(0, 10);

  // 1) Extended wipe (children of the writer's tables must go first).
  const wiped = await wipeShopTables(sb, SHOWCASE_WIPE_ORDER, shopId);

  // 2) Deterministic facts (wipes + reinserts the warehouse/alert tables).
  const dataset = generateSeedDataset({ shopId, today });
  const writerSummary = await writeSeedDataset(dataset, shopId, sb);

  // 3) Materialize the owned catalog + inventory balances from the mirror.
  const { data: promoted, error: promoteErr } = await sb.rpc("promote_shop_from_mirror", {
    p_shop_id: shopId,
  });
  if (promoteErr) throw new Error(`demo reset: promote failed: ${promoteErr.message}`);

  // 4) Showcase layer on top (owned commerce, alerts, calibration, audit).
  // Real wall-clock now so freshest rows are never stamped in the future
  // (the 2pm-anchor default only holds after 14:00 UTC).
  const layer = generateShowcaseLayer({ shopId, today, dataset, now: new Date().toISOString() });
  const inserted: Record<string, number> = { ...writerSummary.inserted };
  for (const [table, rows] of layerInserts(layer)) {
    await insertRowsBatched(sb, table, rows);
    inserted[table] = rows.length;
  }

  // 5) Branding + config restore.
  const { error: settingsErr } = await sb
    .from("store_settings")
    .upsert(layer.storeSettings, { onConflict: "shop_id" });
  if (settingsErr) throw new Error(`demo reset: store_settings upsert: ${settingsErr.message}`);
  // Upsert, not update: owned-signup shops may have no guardrail_config row
  // yet (every other column has a sane default), and an update matching zero
  // rows would silently skip the autopilot-off restore.
  const { error: guardrailErr } = await sb
    .from("guardrail_config")
    .upsert({ shop_id: shopId, ...layer.guardrailPatch }, { onConflict: "shop_id" });
  if (guardrailErr) throw new Error(`demo reset: guardrail upsert: ${guardrailErr.message}`);
  const { error: shopUpdateErr } = await sb.from("shops").update(layer.shopPatch).eq("id", shopId);
  if (shopUpdateErr) throw new Error(`demo reset: shops update: ${shopUpdateErr.message}`);

  return {
    // Both wipe passes — this list is what operators audit after a reset.
    wiped: [...wiped, ...writerSummary.wiped],
    inserted,
    promoted: (promoted as Record<string, unknown>) ?? {},
  };
}
