// Order-management capabilities for the assistant registry (Phase 4 Task 5). issue_refund and
// cancel_order already live in ops-actions.server.ts (do not duplicate here) — this file adds the
// three order-detail write actions that were still missing: fulfill_order (confirm-tier: changes
// order state and can email the customer), add_order_note and add_order_tags (execute-tier,
// low-blast-radius). All three are native-order-only, mirroring the write routes' own guard
// (dashboard.api.orders.$id.notes.tsx): a `shopify:`-prefixed (imported) order_id is refused with
// a friendly error instead of hitting a foreign-key violation on order_note/order_tag.
import { getSupabase } from "../../supabase.server";
import { CalderynError } from "../../calderyn.server";
import { executeFulfillAction } from "../../order/fulfill.server";
import { isImportedOrderId, nativeOrderExists, stripNativeOrderPrefix } from "../../order/detail.server";
import { isValidNoteBody, MAX_NOTE_LENGTH } from "../../order/notes.server";
import { addOrderTags } from "../../order/tags.server";
import type { ActionReceipt, AssistantAction, ValidationResult } from "./registry-types";

const ACTOR = "merchant:assistant";
/** A merchant asking the assistant to add tags in one call is bounded well below the order's
 *  overall MAX_ORDER_TAGS (tags.ts) — this just keeps a single tool call from being asked to
 *  paste in an unreasonably long list; addOrderTags still enforces the real per-order cap. */
const MAX_TAGS_PER_CALL = 10;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Refuses an imported (Shopify-paid, read-only) order id with a friendly error, else strips an
 *  optional `calderyn:` prefix — same guard shape as dashboard.api.orders.$id.notes.tsx, reused
 *  here so every order-mutating surface (route or assistant tool) rejects the same way. */
function requireNativeOrderId(rawOrderId: string, verb: string): string {
  if (isImportedOrderId(rawOrderId)) {
    throw new CalderynError({
      code: "imported_read_only",
      status: 422,
      message: `Imported (Shopify-paid) orders cannot be ${verb} here.`,
    });
  }
  return stripNativeOrderPrefix(rawOrderId);
}

export const ORDER_ACTIONS: AssistantAction[] = [
  {
    name: "fulfill_order",
    description:
      "Mark every remaining unfulfilled unit on a native order as fulfilled (ships everything left on the order; no tracking number is recorded by this tool). order_id is the orders.id from search_orders/get_order (not the Shopify order id) — imported orders are refused. Only a paid or partially-fulfilled order can be fulfilled. Set notify=true to email the customer a shipping confirmation. Changes the order's state and can email the customer, so it requires confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        notify: { type: "boolean", description: "Email the customer a shipping confirmation. Default false." },
      },
      required: ["order_id"],
    },
    tier: "confirm",
    undoable: false,
    validate: (i): ValidationResult => {
      const orderId = str(i.order_id);
      if (!orderId) return { ok: false, message: "order_id is required" };
      if (i.notify !== undefined && typeof i.notify !== "boolean") {
        return { ok: false, message: "notify must be a boolean" };
      }
      return { ok: true, value: { order_id: orderId, notify: i.notify === true } };
    },
    confirmSummary: async (_ctx, i) => {
      const notify = i.notify === true;
      return `Fulfill everything remaining on order ${String(i.order_id)}${notify ? " and email the customer a shipping confirmation" : ""}. This changes the order's status.`;
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const orderId = requireNativeOrderId(String(i.order_id), "fulfilled");
      const notify = i.notify === true;
      const result = await executeFulfillAction(
        ctx.shopId,
        { orderId, notify, idempotencyKey: ctx.idempotencyKey, actor: ACTOR },
        getSupabase(),
      );
      return {
        action: "fulfill_order",
        summary: `Fulfilled ${result.fulfilledUnits} unit${result.fulfilledUnits === 1 ? "" : "s"} on order ${orderId} (now ${result.orderState})`,
        auditId: result.auditId,
        undoable: false,
        detail: {
          order_id: orderId,
          order_state: result.orderState,
          fulfilled_units: result.fulfilledUnits,
          notified: result.notified,
        },
      };
    },
  },
  {
    name: "add_order_note",
    description:
      "Add a staff note to a native order's timeline (merchant-visible only, never sent to the customer). order_id is the orders.id from search_orders/get_order (not the Shopify order id) — imported orders are refused. body is 1-2000 characters.",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" }, body: { type: "string" } },
      required: ["order_id", "body"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const orderId = str(i.order_id);
      if (!orderId) return { ok: false, message: "order_id is required" };
      if (!isValidNoteBody(i.body)) {
        return { ok: false, message: `body must be between 1 and ${MAX_NOTE_LENGTH} characters` };
      }
      return { ok: true, value: { order_id: orderId, body: i.body } };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const orderId = requireNativeOrderId(String(i.order_id), "annotated");
      const sb = getSupabase();
      if (!(await nativeOrderExists(ctx.shopId, orderId, sb))) {
        throw new CalderynError({ code: "order_not_found", status: 404, message: `Order ${orderId} not found.` });
      }
      const body = String(i.body);
      const ins = await sb
        .from("order_note")
        .insert({ shop_id: ctx.shopId, order_id: orderId, author_email: ACTOR, body })
        .select("id")
        .single();
      if (ins.error) throw ins.error;
      return {
        action: "add_order_note",
        summary: "Added a note to the order",
        auditId: null,
        undoable: false,
        detail: { order_id: orderId, note_id: String((ins.data as Record<string, unknown>).id) },
      };
    },
  },
  {
    name: "add_order_tags",
    description:
      "Add tags to a native order WITHOUT removing any tag already on it (additive only, never a replace). order_id is the orders.id from search_orders/get_order (not the Shopify order id) — imported orders are refused. Up to 10 tags per call.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["order_id", "tags"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const orderId = str(i.order_id);
      if (!orderId) return { ok: false, message: "order_id is required" };
      if (
        !Array.isArray(i.tags) ||
        i.tags.length === 0 ||
        i.tags.length > MAX_TAGS_PER_CALL ||
        !i.tags.every((t) => typeof t === "string")
      ) {
        return { ok: false, message: `tags must be an array of 1-${MAX_TAGS_PER_CALL} strings` };
      }
      return { ok: true, value: { order_id: orderId, tags: i.tags } };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const orderId = requireNativeOrderId(String(i.order_id), "tagged");
      const tags = i.tags as string[];
      const allTags = await addOrderTags(ctx.shopId, orderId, tags, getSupabase());
      return {
        action: "add_order_tags",
        summary: `Added ${tags.length} tag${tags.length === 1 ? "" : "s"} to the order`,
        auditId: null,
        undoable: false,
        detail: { order_id: orderId, tags: allTags },
      };
    },
  },
];
