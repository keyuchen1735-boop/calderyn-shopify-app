// Execute a merchant-initiated inventory relocation from the inventory page:
// move N units of a SKU between two Shopify locations. Same audit contract as
// alert-driven reallocate_inventory (app.alerts.$id.tsx) — identical params
// shape, append-only action_audit row, idempotency-key dedup — but the inputs
// arrive from a form, so EVERYTHING that drives the mutation is re-derived
// from shop-scoped records: inventory_item_id from sku_dim, location
// ownership from location_dim, availability re-checked FRESH from
// inventory_level_fact (latest row by observed_at for (sku, from location)).
// Validation failures THROW with no audit row (nothing was attempted);
// Shopify failures record a failed row visibly (rule 12).

import type { SupabaseClient } from "@supabase/supabase-js";
import { type AdminGraphqlClient } from "../shopify/inventory.server";
import { inventoryAdjustQuantitiesForShop } from "../demo/showcase.server";
import {
  insertAuditWithIdempotency,
  priorExecutionForKey,
  type ExecutedAudit,
} from "./execute.server";
import { getOrgMode, writesToOwned, dualWrites, shopHasShopifyConnection } from "../cutover/org-mode.server";
import { applyOwnedInventoryMove } from "./owned-writes.server";

export interface InventoryRelocationInput {
  alertId: string | null;
  skuId: string;
  /** Shopify Location GIDs (location_dim.external_id). */
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  idempotencyKey: string;
  actor?: string;
}

/** Validation failure: thrown BEFORE any side effect; no audit row exists. */
export class RelocationError extends Error {
  constructor(
    public readonly code:
      | "INVALID_QUANTITY"
      | "SAME_LOCATION"
      | "SKU_NOT_FOUND"
      | "INVALID_TRANSFER_PLAN"
      | "QTY_EXCEEDS_AVAILABLE"
      | "SHOPIFY_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "RelocationError";
  }
}

export async function executeInventoryRelocation(
  shopId: string,
  input: InventoryRelocationInput,
  sb: SupabaseClient,
  /** Shopify Admin client, or null for an owned-native shop (no connected store).
   *  Only used on the Shopify write branch; the owned (`live`) branch never touches it. */
  admin: AdminGraphqlClient | null,
): Promise<ExecutedAudit> {
  // 1. Idempotency — replayed key returns the REAL prior outcome with no side effects.
  const prior = await priorExecutionForKey(shopId, input.idempotencyKey, sb);
  if (prior) return prior;

  // 2. Input validation. Throw with no audit row — nothing was attempted.
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new RelocationError("INVALID_QUANTITY", "Quantity must be a positive whole number.");
  }
  if (input.fromLocationId === input.toLocationId) {
    throw new RelocationError("SAME_LOCATION", "Source and destination must be different locations.");
  }

  // 3. Resolve inventory_item_id from sku_dim (shop-scoped ownership check).
  const { data: sku, error: sErr } = await sb
    .from("sku_dim")
    .select("id, title, sku, inventory_item_id")
    .eq("shop_id", shopId)
    .eq("id", input.skuId)
    .maybeSingle();
  if (sErr) throw sErr;
  if (!sku) {
    throw new RelocationError("SKU_NOT_FOUND", "SKU not found for this shop.");
  }
  if (!sku.inventory_item_id) {
    throw new RelocationError(
      "INVALID_TRANSFER_PLAN",
      "This SKU has no Shopify inventory item, so stock can't be moved.",
    );
  }
  const inventoryItemId = String(sku.inventory_item_id);

  // 4. Validate location ownership via location_dim (shop-scoped).
  const { data: locs, error: lErr } = await sb
    .from("location_dim")
    .select("id, external_id, name, active")
    .eq("shop_id", shopId)
    .in("external_id", [input.fromLocationId, input.toLocationId]);
  if (lErr) throw lErr;
  const rows = (locs ?? []) as Array<{
    id: string;
    external_id: string;
    name: string;
    active: boolean;
  }>;
  const from = rows.find((l) => l.external_id === input.fromLocationId);
  const to = rows.find((l) => l.external_id === input.toLocationId);
  if (!from || !to) {
    throw new RelocationError("INVALID_TRANSFER_PLAN", "Location does not belong to this shop.");
  }
  if (!to.active) {
    throw new RelocationError("INVALID_TRANSFER_PLAN", "The destination location is inactive.");
  }

  // 5. Fresh availability check — the page's loader snapshot may be stale.
  // Use the latest row by observed_at for (sku, from location).
  const { data: inv, error: iErr } = await sb
    .from("inventory_level_fact")
    .select("available, observed_at")
    .eq("shop_id", shopId)
    .eq("sku_id", input.skuId)
    .eq("location_id", from.id)
    .order("observed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (iErr) throw iErr;
  const fromAvailable = Number(inv?.available ?? 0);
  if (!Number.isFinite(fromAvailable) || input.quantity > fromAvailable) {
    const displayQty = Number.isFinite(fromAvailable) ? fromAvailable : 0;
    throw new RelocationError(
      "QTY_EXCEEDS_AVAILABLE",
      `Only ${displayQty} unit${displayQty === 1 ? "" : "s"} available at ${from.name}.`,
    );
  }

  // 6. Execute the move on the routed target. At org_mode=live the move lands in the owned
  // inventory engine (atomic, cannot-oversell) keyed by owned variant + owned location ids;
  // every other mode adjusts Shopify exactly as before, and dual_run ALSO mirrors the move
  // into the owned engine best-effort. A failure on the authoritative branch is recorded
  // visibly as a failed audit row (rule 12), never a fake success; a dual_run mirror failure
  // never fails the action — it is recorded on the audit row instead.
  // A NATIVE shop (no connected Shopify store) is always owned-authoritative — Shopify is
  // import-only for it. A Shopify-connected shop follows the cutover state machine.
  const orgMode = await getOrgMode(shopId);
  const hasShopify = await shopHasShopifyConnection(shopId);
  const owned = !hasShopify || writesToOwned(orgMode);
  const dual = hasShopify && dualWrites(orgMode);
  let outcome: ExecutedAudit["outcome"] = "succeeded";
  let lastError: string | null = null;
  let operationId: string | null = null;
  // Owned-side markers for the audit row: `owned` routes undo to the owned engine at live;
  // `dual_write` (+ owned ids) lets undo mirror the reversal after a dual_run move.
  const ownedParams: Record<string, unknown> = {};
  try {
    if (owned) {
      const { transferId } = await applyOwnedInventoryMove({
        shopId,
        variantId: input.skuId,
        fromLocationId: from.id,
        toLocationId: to.id,
        quantity: input.quantity,
      });
      operationId = transferId;
      ownedParams.owned = true;
      ownedParams.owned_transfer_id = transferId;
      ownedParams.owned_variant_id = input.skuId;
      ownedParams.owned_from_location_id = from.id;
      ownedParams.owned_to_location_id = to.id;
    } else {
      if (!admin) {
        // Shopify-authoritative mode but no connected store; owned-native shops route
        // to the owned branch above. Throw a validation error (the catch below rethrows
        // RelocationError, so this records no audit row — rule 12), not a failed move.
        throw new RelocationError("SHOPIFY_REQUIRED", "Connect a Shopify store to relocate inventory.");
      }
      ({ operationId } = await inventoryAdjustQuantitiesForShop(shopId, admin, {
        inventoryItemId: inventoryItemId,
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        delta: input.quantity,
      }, sb));
      if (dual) {
        try {
          const { transferId } = await applyOwnedInventoryMove({
            shopId,
            variantId: input.skuId,
            fromLocationId: from.id,
            toLocationId: to.id,
            quantity: input.quantity,
          });
          ownedParams.dual_write = "ok";
          ownedParams.owned_transfer_id = transferId;
          ownedParams.owned_variant_id = input.skuId;
          ownedParams.owned_from_location_id = from.id;
          ownedParams.owned_to_location_id = to.id;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ownedParams.dual_write = `failed: ${msg}`;
          console.error("[inventory-relocate] dual_run owned mirror move failed", err);
        }
      }
    }
  } catch (err) {
    // A RelocationError is a validation/config failure (e.g. no connected store), not a
    // move that was attempted and failed — surface it with no audit row, like the checks
    // above the try, rather than recording a fake failed move (rule 12).
    if (err instanceof RelocationError) throw err;
    outcome = "failed";
    lastError = err instanceof Error ? err.message : String(err);
  }

  // 7. ONE append-only audit row + idempotency marker.
  // params shape matches alert-driven reallocate_inventory so the audit UI
  // and undo path (Task 6) treat both identically.
  return insertAuditWithIdempotency(
    shopId,
    input.idempotencyKey,
    {
      alert_id: input.alertId,
      action_kind: "reallocate_inventory",
      params: {
        target: String(sku.title ?? sku.sku ?? input.skuId),
        sku: sku.sku,
        sku_id: input.skuId,
        inventory_item_id: inventoryItemId,
        from_location_id: input.fromLocationId,
        from_location_name: from.name,
        to_location_id: input.toLocationId,
        to_location_name: to.name,
        delta: input.quantity,
        shopify_operation_id: operationId,
        ...ownedParams,
      },
      outcome,
      pre_state: { from_location_available: fromAvailable },
      post_state:
        outcome === "succeeded"
          ? { from_location_available: fromAvailable - input.quantity }
          : null,
      last_error: lastError,
      actor_user_id: input.actor ?? "merchant",
      // At `live` the move landed in the owned inventory engine; every other mode
      // (mirror/importing/dual_run) wrote Shopify authoritatively.
      write_target: owned ? "owned_sot" : "shopify_admin",
    },
    sb,
  );
}
