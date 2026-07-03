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
import { writeSeedDataset } from "../seed/writer";
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
  // owned catalog (import_map bridges onto variant ids — wipe it first)
  "import_map",
  "import_run",
  "product_media",
  "variant_option_value",
  "product_option_value",
  "product_option",
  "product_collection",
  "collection_dim",
  "variant_shipping",
  "variant_dim",
  "product_dim",
  // cutover history
  "cutover_transition",
] as const;

const BATCH_SIZE = 500;

export interface ResetSummary {
  wiped: string[];
  inserted: Record<string, number>;
  promoted: Record<string, unknown>;
}

async function insertBatched(
  sb: ShowcaseResetClient,
  table: string,
  rows: Record<string, unknown>[],
  inserted: Record<string, number>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await sb.from(table).insert(batch);
    if (error) throw new Error(`showcase insert ${table}: ${error.message}`);
  }
  inserted[table] = rows.length;
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
  const wiped: string[] = [];
  for (const table of SHOWCASE_WIPE_ORDER) {
    const { error } = await sb.from(table).delete().eq("shop_id", shopId);
    if (error) throw new Error(`showcase wipe ${table}: ${error.message}`);
    wiped.push(table);
  }

  // 2) Deterministic facts (wipes + reinserts the warehouse/alert tables).
  const dataset = generateSeedDataset({ shopId, today });
  const writerSummary = await writeSeedDataset(dataset, shopId, sb);

  // 3) Materialize the owned catalog + inventory balances from the mirror.
  const { data: promoted, error: promoteErr } = await sb.rpc("promote_shop_from_mirror", {
    p_shop_id: shopId,
  });
  if (promoteErr) throw new Error(`demo reset: promote failed: ${promoteErr.message}`);

  // 4) Showcase layer on top (owned commerce, alerts, calibration, audit).
  const layer = generateShowcaseLayer({ shopId, today, dataset });
  const inserted: Record<string, number> = { ...writerSummary.inserted };
  for (const [table, rows] of layerInserts(layer)) {
    await insertBatched(sb, table, rows, inserted);
  }

  // 5) Branding + config restore.
  const { error: settingsErr } = await sb
    .from("store_settings")
    .upsert({ ...layer.storeSettings }, { onConflict: "shop_id" });
  if (settingsErr) throw new Error(`demo reset: store_settings upsert: ${settingsErr.message}`);
  const { error: guardrailErr } = await sb
    .from("guardrail_config")
    .update(layer.guardrailPatch)
    .eq("shop_id", shopId);
  if (guardrailErr) throw new Error(`demo reset: guardrail update: ${guardrailErr.message}`);
  const { error: shopUpdateErr } = await sb.from("shops").update(layer.shopPatch).eq("id", shopId);
  if (shopUpdateErr) throw new Error(`demo reset: shops update: ${shopUpdateErr.message}`);

  return {
    wiped: [...wiped],
    inserted,
    promoted: (promoted as Record<string, unknown>) ?? {},
  };
}
