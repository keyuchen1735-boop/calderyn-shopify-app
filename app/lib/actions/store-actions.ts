// Dormant StoreActionAdapter over the owned write primitives (catalog + inventory).
// This file is NOT imported by any executor, not registered in any action registry,
// and does not affect any live production behavior. It is ready-for-cutover: once
// Step 4 of the platform pivot wires it in, no changes here are needed.

import {
  setVariantPrice,
  setProductStatus,
} from "~/lib/catalog/catalog.server";
import {
  reserveStock,
  commitReservation,
  releaseReservation,
} from "~/lib/inventory/engine.server";
import type { Allocation } from "~/lib/inventory/engine.server";

// ---------------------------------------------------------------------------
// Action kinds
// ---------------------------------------------------------------------------

export type StoreActionKind =
  | "set_price"
  | "reserve_inventory"
  | "commit_inventory"
  | "release_inventory"
  | "publish_product";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown by StoreActionAdapter methods on a write-primitive failure. Mirrors
 * the ad ActionError shape but drops `platform` (store writes have no platform
 * concept) and adds `kind` for structured routing by the future executor.
 *
 * Defaults to retriable:true — finer classification (bad variant id, etc.) is
 * deferred until this adapter is wired into an executor that needs it.
 */
export class StoreActionError extends Error {
  readonly kind: StoreActionKind;
  readonly retriable: boolean;

  constructor(
    kind: StoreActionKind,
    message: string,
    opts?: { retriable?: boolean },
  ) {
    super(`[${kind}] ${message}`);
    this.name = "StoreActionError";
    this.kind = kind;
    this.retriable = opts?.retriable ?? true;
  }
}

// ---------------------------------------------------------------------------
// Retriable classification
// ---------------------------------------------------------------------------

/**
 * Store-scoped retriable classification. Only a StoreActionError explicitly
 * flagged retriable:false is terminal; every other failure is treated as
 * transient. (Cannot reuse the ads isRetriableFailure — it checks
 * instanceof ActionError, which StoreActionError is not.)
 */
export function isRetriableFailure(err: unknown): boolean {
  return err instanceof StoreActionError ? err.retriable : true;
}

// ---------------------------------------------------------------------------
// ReserveResult — imported from the engine (Allocation is exported there)
// ---------------------------------------------------------------------------

export type ReserveResult =
  | { ok: true; allocation: Allocation }
  | { ok: false; reason: "insufficient_stock" };

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/**
 * Owned-store action adapter bound to a single shop by the factory. Methods
 * do NOT take shopId — the factory captures it at construction time, mirroring
 * how the ad ActionAdapter binds platform + shop credentials at construction.
 */
export interface StoreActionAdapter {
  /** Update a variant's retail price. Returns the prior price for undo support. */
  setPrice(
    variantId: string,
    priceCents: number,
  ): Promise<{ priorPriceCents: number | null }>;

  /**
   * Reserve qty units of a variant for a checkout. Returns the allocation on
   * success or { ok:false, reason:"insufficient_stock" } as a normal result
   * (not an error) so callers can handle stockout without try/catch.
   */
  reserveInventory(
    variantId: string,
    qty: number,
    checkoutRef: string,
  ): Promise<ReserveResult>;

  /**
   * Commit (decrement) a previously held reservation at payment success —
   * converts the hold into a sale so on_hand actually drops. This is the seam
   * contract's `decrement`: reserve at checkout, commit on payment, release on
   * abandon/expiry. Idempotent on checkoutRef (the engine SQL is).
   */
  commitInventory(checkoutRef: string): Promise<void>;

  /** Release a previously held reservation (cancel / cart expiry). */
  releaseInventory(checkoutRef: string): Promise<void>;

  /** Publish (set status to "active") an owned product. */
  publishProduct(productId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns a concrete StoreActionAdapter whose methods delegate to the owned
 * catalog and inventory write primitives, with shopId captured in closure.
 */
export function storeActionAdapterForShop(shopId: string): StoreActionAdapter {
  return {
    async setPrice(variantId, priceCents) {
      try {
        return await setVariantPrice(shopId, variantId, priceCents);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new StoreActionError("set_price", msg);
      }
    },

    async reserveInventory(variantId, qty, checkoutRef) {
      try {
        // insufficient_stock comes back as { ok:false } — a normal result, not
        // a thrown error from the engine. Pass it through directly.
        return await reserveStock(shopId, variantId, qty, checkoutRef);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new StoreActionError("reserve_inventory", msg);
      }
    },

    async commitInventory(checkoutRef) {
      try {
        await commitReservation(shopId, checkoutRef);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new StoreActionError("commit_inventory", msg);
      }
    },

    async releaseInventory(checkoutRef) {
      try {
        await releaseReservation(shopId, checkoutRef);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new StoreActionError("release_inventory", msg);
      }
    },

    async publishProduct(productId) {
      try {
        await setProductStatus(shopId, productId, "active");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new StoreActionError("publish_product", msg);
      }
    },
  };
}
