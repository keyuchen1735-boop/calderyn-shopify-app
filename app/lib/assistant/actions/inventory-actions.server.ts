// Inventory capabilities — writes go straight through the owned inventory
// engine (app/lib/inventory/engine.server.ts), the same functions the
// Inventory screen calls. There is no audited executor pipeline here (like
// catalog-actions.server.ts), so every receipt carries auditId: null and
// undoable: false; receipts echo the inputs/prior context so a merchant can
// ask the assistant to reverse the change manually. Quantities are whole
// units, never cents.
import { adjustStock, setReorderPoint, createTransfer, receiveTransfer } from "../../inventory/engine.server";
import type { ActionReceipt, AssistantAction, ValidationResult } from "./registry-types";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function nonNegInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
function posInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const ID_HINT =
  "variant_id and location_id come from list_skus / catalog reads — never guess them.";

export const INVENTORY_ACTIONS: AssistantAction[] = [
  {
    name: "set_stock",
    description: `Set a variant's on-hand quantity at a location to on_hand (a whole unit count, >= 0), overwriting the current count. ${ID_HINT}`,
    inputSchema: {
      type: "object",
      properties: {
        variant_id: { type: "string" },
        location_id: { type: "string" },
        on_hand: { type: "number" },
      },
      required: ["variant_id", "location_id", "on_hand"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const variantId = str(i.variant_id);
      const locationId = str(i.location_id);
      const onHand = nonNegInt(i.on_hand);
      if (!variantId) return { ok: false, message: "variant_id is required" };
      if (!locationId) return { ok: false, message: "location_id is required" };
      if (onHand === null) return { ok: false, message: "on_hand must be a whole number >= 0" };
      return { ok: true, value: { variant_id: variantId, location_id: locationId, on_hand: onHand } };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      await adjustStock(ctx.shopId, String(i.variant_id), String(i.location_id), Number(i.on_hand), "assistant");
      return {
        action: "set_stock",
        summary: `Set on-hand stock to ${String(i.on_hand)} units`,
        auditId: null,
        undoable: false,
        detail: { variant_id: i.variant_id, location_id: i.location_id, on_hand: i.on_hand },
      };
    },
  },
  {
    name: "set_reorder_point",
    description: `Set (or clear with reorder_point: null) the low-stock reorder threshold for a variant at a location. ${ID_HINT}`,
    inputSchema: {
      type: "object",
      properties: {
        variant_id: { type: "string" },
        location_id: { type: "string" },
        reorder_point: { type: ["number", "null"] },
      },
      required: ["variant_id", "location_id", "reorder_point"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const variantId = str(i.variant_id);
      const locationId = str(i.location_id);
      if (!variantId) return { ok: false, message: "variant_id is required" };
      if (!locationId) return { ok: false, message: "location_id is required" };
      if (i.reorder_point === null) {
        return { ok: true, value: { variant_id: variantId, location_id: locationId, reorder_point: null } };
      }
      const reorderPoint = posInt(i.reorder_point);
      if (reorderPoint === null) {
        return { ok: false, message: "reorder_point must be a positive whole number, or null to clear it" };
      }
      return { ok: true, value: { variant_id: variantId, location_id: locationId, reorder_point: reorderPoint } };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const reorderPoint = i.reorder_point === null ? null : Number(i.reorder_point);
      await setReorderPoint(ctx.shopId, String(i.variant_id), String(i.location_id), reorderPoint);
      return {
        action: "set_reorder_point",
        summary:
          reorderPoint === null
            ? "Cleared the reorder point"
            : `Set the reorder point to ${reorderPoint} units`,
        auditId: null,
        undoable: false,
        detail: { variant_id: i.variant_id, location_id: i.location_id, reorder_point: reorderPoint },
      };
    },
  },
  {
    name: "create_transfer",
    description: `Move qty whole units of a variant from one location to another. mode "instant" applies both sides immediately; "in_transit" holds the units as incoming at the destination until receive_transfer is called. Fails if the source location doesn't have enough available stock. ${ID_HINT}`,
    inputSchema: {
      type: "object",
      properties: {
        variant_id: { type: "string" },
        from_location_id: { type: "string" },
        to_location_id: { type: "string" },
        qty: { type: "number" },
        mode: { type: "string", enum: ["instant", "in_transit"] },
      },
      required: ["variant_id", "from_location_id", "to_location_id", "qty", "mode"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const variantId = str(i.variant_id);
      const fromLocationId = str(i.from_location_id);
      const toLocationId = str(i.to_location_id);
      const qty = posInt(i.qty);
      if (!variantId) return { ok: false, message: "variant_id is required" };
      if (!fromLocationId || !toLocationId) {
        return { ok: false, message: "from_location_id and to_location_id are required" };
      }
      if (fromLocationId === toLocationId) {
        return { ok: false, message: "from_location_id and to_location_id must be different locations" };
      }
      if (!qty) return { ok: false, message: "qty must be a positive whole number" };
      if (i.mode !== "instant" && i.mode !== "in_transit") {
        return { ok: false, message: "mode must be instant or in_transit" };
      }
      return {
        ok: true,
        value: {
          variant_id: variantId,
          from_location_id: fromLocationId,
          to_location_id: toLocationId,
          qty,
          mode: i.mode,
        },
      };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const { transferId } = await createTransfer(
        ctx.shopId,
        String(i.variant_id),
        String(i.from_location_id),
        String(i.to_location_id),
        Number(i.qty),
        i.mode as "instant" | "in_transit",
      );
      return {
        action: "create_transfer",
        summary: `Transferred ${String(i.qty)} units (${String(i.mode)})`,
        auditId: null,
        undoable: false,
        detail: { transfer_id: transferId },
      };
    },
  },
  {
    name: "receive_transfer",
    description: "Mark an in-transit inventory transfer as received at its destination location. transfer_id comes from create_transfer's receipt.",
    inputSchema: {
      type: "object",
      properties: { transfer_id: { type: "string" } },
      required: ["transfer_id"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const transferId = str(i.transfer_id);
      return transferId ? { ok: true, value: { transfer_id: transferId } } : { ok: false, message: "transfer_id is required" };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      await receiveTransfer(ctx.shopId, String(i.transfer_id));
      return {
        action: "receive_transfer",
        summary: "Received the transfer",
        auditId: null,
        undoable: false,
        detail: { transfer_id: i.transfer_id },
      };
    },
  },
];
