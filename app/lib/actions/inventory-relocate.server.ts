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
import {
  inventoryAdjustQuantities,
  type AdminGraphqlClient,
} from "../shopify/inventory.server";
import {
  insertAuditWithIdempotency,
  priorExecutionForKey,
  type ExecutedAudit,
} from "./execute.server";

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
      | "QTY_EXCEEDS_AVAILABLE",
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
  admin: AdminGraphqlClient,
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

  // 6. Execute the Shopify mutation. Failure is recorded visibly (rule 12).
  let outcome: ExecutedAudit["outcome"] = "succeeded";
  let lastError: string | null = null;
  let operationId: string | null = null;
  try {
    ({ operationId } = await inventoryAdjustQuantities(admin, {
      inventoryItemId: inventoryItemId,
      fromLocationId: input.fromLocationId,
      toLocationId: input.toLocationId,
      delta: input.quantity,
    }));
  } catch (err) {
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
      },
      outcome,
      pre_state: { from_location_available: fromAvailable },
      post_state:
        outcome === "succeeded"
          ? { from_location_available: fromAvailable - input.quantity }
          : null,
      last_error: lastError,
      actor_user_id: input.actor ?? "merchant",
    },
    sb,
  );
}
