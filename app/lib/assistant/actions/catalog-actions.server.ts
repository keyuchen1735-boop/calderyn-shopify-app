// Catalog + storefront capabilities — writes go through the same catalog/
// studio primitives the Products and Store Studio screens use. There is no
// audited executor pipeline here (unlike campaign-actions.server.ts), so every
// receipt carries auditId: null; set_variant_price instead echoes the prior
// price so the merchant can ask the assistant to revert it. Money is cents.
import { getSupabase } from "../../supabase.server";
import { calderynClient } from "../../calderyn.server";
import {
  createProduct,
  setProductStatus,
  setVariantPrice,
  createCollection,
  getProduct,
} from "../../catalog/catalog.server";
import { validateProductInput } from "../../catalog/validate";
import type { ProductStatus } from "../../catalog/types";
import {
  saveStudioHero,
  saveStudioAccent,
  saveStudioVibe,
  publishStudioStore,
} from "../../storebuilder/studio.server";
import type { StudioVibe } from "../../storebuilder/studio-types";
import { updateLocationDetails, type LocationPatch } from "../../catalog/locations.server";
import {
  startExperiment,
  decideExperiment,
  type StoreExperimentKind,
} from "../../experiments/store-experiment.server";
import type { ActionReceipt, AssistantAction, ValidationResult } from "./registry-types";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function posInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Current variant retail price, read BEFORE any write so the price-change
 *  guardrail can be enforced against the pre-write value. setVariantPrice
 *  itself only reports the prior price AFTER it has already written the new
 *  one, which is too late to block an out-of-bounds change. */
export async function getVariantPriceCents(shopId: string, variantId: string): Promise<number | null> {
  const { data, error } = await getSupabase()
    .from("variant_dim")
    .select("retail_price_cents")
    .eq("shop_id", shopId)
    .eq("id", variantId)
    .maybeSingle();
  if (error) throw error;
  return data?.retail_price_cents == null ? null : Number(data.retail_price_cents);
}

export const CATALOG_ACTIONS: AssistantAction[] = [
  {
    name: "create_product",
    description:
      "Create a new product as a single-variant listing in draft status. After creation, use set_product_status to activate it. price_cents is required, in cents.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        price_cents: { type: "number" },
        description: { type: "string" },
      },
      required: ["title", "price_cents"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const title = str(i.title);
      const priceCents = posInt(i.price_cents);
      if (!title || title.length > 200) return { ok: false, message: "title is required (max 200 chars)" };
      if (!priceCents) return { ok: false, message: "price_cents must be a positive integer (cents)" };
      if (i.description !== undefined && (typeof i.description !== "string" || i.description.length > 2000)) {
        return { ok: false, message: "description must be a string of at most 2000 chars" };
      }
      return {
        ok: true,
        value: { title, price_cents: priceCents, description: str(i.description) ?? undefined },
      };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const built = validateProductInput({
        title: i.title,
        status: "draft",
        description: i.description,
        variants: [{ retailPriceCents: i.price_cents }],
      });
      if (!built.ok) throw new Error(`Could not build a valid product (${built.code})`);
      const { id } = await createProduct(ctx.shopId, built.value);
      return {
        action: "create_product",
        summary: `Created "${String(i.title)}" as a draft product`,
        auditId: null,
        undoable: false,
        detail: { product_id: id },
      };
    },
  },
  {
    name: "set_product_status",
    description:
      "Set a product's status to active or draft. To archive a product, use archive_product instead (requires confirmation).",
    inputSchema: {
      type: "object",
      properties: { product_id: { type: "string" }, status: { type: "string", enum: ["active", "draft"] } },
      required: ["product_id", "status"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const id = str(i.product_id);
      if (!id) return { ok: false, message: "product_id is required" };
      if (i.status !== "active" && i.status !== "draft") {
        return { ok: false, message: "status must be active or draft (use archive_product to archive)" };
      }
      return { ok: true, value: { product_id: id, status: i.status } };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const status = i.status as ProductStatus;
      await setProductStatus(ctx.shopId, String(i.product_id), status);
      return {
        action: "set_product_status",
        summary: `Set the product status to ${String(i.status)}`,
        auditId: null,
        undoable: false,
        detail: { product_id: i.product_id, status: i.status },
      };
    },
  },
  {
    name: "archive_product",
    description: "Archive a product, removing it from the storefront. Requires confirmation.",
    inputSchema: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] },
    tier: "confirm",
    undoable: false,
    validate: (i): ValidationResult => {
      const id = str(i.product_id);
      return id ? { ok: true, value: { product_id: id } } : { ok: false, message: "product_id is required" };
    },
    confirmSummary: async (ctx, i) => {
      const productId = String(i.product_id);
      let title = productId;
      try {
        const detail = await getProduct(ctx.shopId, productId);
        if (detail?.title) title = detail.title;
      } catch {
        // Title lookup is a nicety for the confirm card; fall back to the id.
      }
      return `Archive "${title}" — it disappears from the storefront`;
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      await setProductStatus(ctx.shopId, String(i.product_id), "archived");
      return {
        action: "archive_product",
        summary: "Archived the product",
        auditId: null,
        undoable: false,
        detail: { product_id: i.product_id },
      };
    },
  },
  {
    name: "set_variant_price",
    description:
      "Change a product variant's retail price to price_cents (in cents). Capped by the shop's max price-change guardrail relative to the current price.",
    inputSchema: {
      type: "object",
      properties: { variant_id: { type: "string" }, price_cents: { type: "number" } },
      required: ["variant_id", "price_cents"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const id = str(i.variant_id);
      const cents = posInt(i.price_cents);
      if (!id) return { ok: false, message: "variant_id is required" };
      if (!cents) return { ok: false, message: "price_cents must be a positive integer (cents)" };
      return { ok: true, value: { variant_id: id, price_cents: cents } };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const variantId = String(i.variant_id);
      const priceCents = Number(i.price_cents);
      const priorPriceCents = await getVariantPriceCents(ctx.shopId, variantId);
      if (priorPriceCents != null && priorPriceCents > 0) {
        const guardrails = await calderynClient(ctx.shopId).guardrails.get();
        const changePct = (Math.abs(priceCents - priorPriceCents) / priorPriceCents) * 100;
        if (changePct > guardrails.max_price_change_pct) {
          throw new Error(
            `That's a ${changePct.toFixed(0)}% change — above this shop's max_price_change_pct guardrail of ${guardrails.max_price_change_pct}%. Ask the merchant to raise the guardrail or choose a smaller change.`,
          );
        }
      }
      const { priorPriceCents: confirmedPrior } = await setVariantPrice(ctx.shopId, variantId, priceCents);
      return {
        action: "set_variant_price",
        summary: `Changed the variant price to $${(priceCents / 100).toFixed(2)}`,
        auditId: null,
        undoable: false,
        detail: { prior_price_cents: confirmedPrior },
      };
    },
  },
  {
    name: "create_collection",
    description: "Create a new product collection with the given title.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const title = str(i.title);
      if (!title || title.length > 120) return { ok: false, message: "title is required (max 120 chars)" };
      return { ok: true, value: { title } };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const { id } = await createCollection(ctx.shopId, String(i.title));
      return {
        action: "create_collection",
        summary: `Created the collection "${String(i.title)}"`,
        auditId: null,
        undoable: false,
        detail: { collection_id: id },
      };
    },
  },
  {
    name: "save_hero_copy",
    description:
      "Update the storefront home page hero headline/subhead copy (draft; publish_store makes it live).",
    inputSchema: {
      type: "object",
      properties: { headline: { type: "string" }, subhead: { type: "string" } },
      required: ["headline"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const headline = str(i.headline);
      if (!headline || headline.length > 300) return { ok: false, message: "headline is required (max 300 chars)" };
      if (i.subhead !== undefined && (typeof i.subhead !== "string" || i.subhead.length > 300)) {
        return { ok: false, message: "subhead must be a string of at most 300 chars" };
      }
      return { ok: true, value: { headline, subhead: str(i.subhead) ?? "" } };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      await saveStudioHero(ctx.shopId, { headline: String(i.headline), subhead: String(i.subhead ?? "") });
      return {
        action: "save_hero_copy",
        summary: "Updated the home page hero copy",
        auditId: null,
        undoable: false,
      };
    },
  },
  {
    name: "save_accent_color",
    description: "Set the storefront's accent/brand color as a 6-digit hex code, e.g. #1c8a55.",
    inputSchema: { type: "object", properties: { color: { type: "string" } }, required: ["color"] },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const color = str(i.color);
      if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
        return { ok: false, message: "color must be a 6-digit hex code, e.g. #1c8a55" };
      }
      return { ok: true, value: { color } };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      await saveStudioAccent(ctx.shopId, String(i.color));
      return {
        action: "save_accent_color",
        summary: `Set the accent color to ${String(i.color)}`,
        auditId: null,
        undoable: false,
      };
    },
  },
  {
    name: "save_vibe",
    description: "Set the storefront's design vibe: minimal, bold, or warm.",
    inputSchema: {
      type: "object",
      properties: { vibe: { type: "string", enum: ["minimal", "bold", "warm"] } },
      required: ["vibe"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      if (i.vibe !== "minimal" && i.vibe !== "bold" && i.vibe !== "warm") {
        return { ok: false, message: "vibe must be minimal, bold, or warm" };
      }
      return { ok: true, value: { vibe: i.vibe } };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      await saveStudioVibe(ctx.shopId, i.vibe as StudioVibe);
      return {
        action: "save_vibe",
        summary: `Set the storefront vibe to ${String(i.vibe)}`,
        auditId: null,
        undoable: false,
      };
    },
  },
  {
    name: "publish_store",
    description: "Publish every drafted storefront page (home/collection/pdp). Requires confirmation.",
    inputSchema: { type: "object", properties: {}, required: [] },
    tier: "confirm",
    undoable: false,
    validate: (): ValidationResult => ({ ok: true, value: {} }),
    confirmSummary: async () => "Publish the draft store — changes go live to buyers immediately",
    run: async (ctx): Promise<ActionReceipt> => {
      await publishStudioStore(ctx.shopId);
      return {
        action: "publish_store",
        summary: "Published the store",
        auditId: null,
        undoable: false,
      };
    },
  },
  {
    name: "set_location_details",
    description:
      "Update a fulfillment location's address, priority, or geocoordinates. location_id comes from catalog/location reads. priority is an integer (lower ranks first for allocation); lat/lng are numbers, or null to clear them; street1/street2/city/region/postal_code/country are plain strings. At least one field besides location_id is required.",
    inputSchema: {
      type: "object",
      properties: {
        location_id: { type: "string" },
        priority: { type: "number" },
        lat: { type: "number" },
        lng: { type: "number" },
        street1: { type: "string" },
        street2: { type: "string" },
        city: { type: "string" },
        region: { type: "string" },
        postal_code: { type: "string" },
        country: { type: "string" },
      },
      required: ["location_id"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const locationId = str(i.location_id);
      if (!locationId) return { ok: false, message: "location_id is required" };

      const patch: LocationPatch = {};
      if (i.priority !== undefined && i.priority !== null) {
        const p = Number(i.priority);
        if (!Number.isInteger(p)) return { ok: false, message: "priority must be an integer" };
        patch.priority = p;
      }
      if (i.lat !== undefined) {
        if (i.lat !== null && typeof i.lat !== "number") return { ok: false, message: "lat must be a number or null" };
        patch.lat = i.lat === null ? null : i.lat;
      }
      if (i.lng !== undefined) {
        if (i.lng !== null && typeof i.lng !== "number") return { ok: false, message: "lng must be a number or null" };
        patch.lng = i.lng === null ? null : i.lng;
      }
      const stringKeys = ["street1", "street2", "city", "region", "postal_code", "country"] as const;
      for (const key of stringKeys) {
        if (i[key] !== undefined) {
          if (typeof i[key] !== "string") return { ok: false, message: `${key} must be a string` };
          patch[key] = i[key];
        }
      }

      if (Object.keys(patch).length === 0) {
        return { ok: false, message: "at least one field to update is required (besides location_id)" };
      }
      return { ok: true, value: { location_id: locationId, patch } };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const locationId = String(i.location_id);
      const patch = i.patch as LocationPatch;
      await updateLocationDetails(getSupabase(), ctx.shopId, locationId, patch);
      return {
        action: "set_location_details",
        summary: "Updated the location",
        auditId: null,
        undoable: false,
        detail: { location_id: locationId, patch },
      };
    },
  },
  {
    name: "start_experiment",
    description:
      "Start a home-page A/B experiment (headline copy or design vibe) against the currently published store. Only one experiment can run at a time; decide_experiment or ship_experiment closes it.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["headline", "vibe"] },
        name: { type: "string" },
      },
      required: ["kind"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      if (i.kind !== "headline" && i.kind !== "vibe") {
        return { ok: false, message: "kind must be headline or vibe" };
      }
      if (i.name !== undefined && (typeof i.name !== "string" || i.name.length > 80)) {
        return { ok: false, message: "name must be a string of at most 80 chars" };
      }
      return { ok: true, value: { kind: i.kind, name: str(i.name) ?? undefined } };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const kind = i.kind as StoreExperimentKind;
      await startExperiment(ctx.shopId, { kind, name: i.name as string | undefined });
      return {
        action: "start_experiment",
        summary: `Started a ${kind} experiment`,
        auditId: null,
        undoable: false,
      };
    },
  },
  {
    name: "decide_experiment",
    description:
      "Close a running home-page experiment by keeping the current published page (keep) or discarding the challenger (stop). To publish the winning variant live, use ship_experiment instead (requires confirmation).",
    inputSchema: {
      type: "object",
      properties: {
        experiment_id: { type: "string" },
        decision: { type: "string", enum: ["keep", "stop"] },
      },
      required: ["experiment_id", "decision"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const experimentId = str(i.experiment_id);
      if (!experimentId) return { ok: false, message: "experiment_id is required" };
      if (i.decision !== "keep" && i.decision !== "stop") {
        return { ok: false, message: "decision must be keep or stop (use ship_experiment to publish live)" };
      }
      return { ok: true, value: { experiment_id: experimentId, decision: i.decision } };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const decision = i.decision as "keep" | "stop";
      await decideExperiment(ctx.shopId, String(i.experiment_id), decision);
      return {
        action: "decide_experiment",
        summary: `Closed the experiment (${decision})`,
        auditId: null,
        undoable: false,
      };
    },
  },
  {
    name: "ship_experiment",
    description:
      "Publish the winning variant of a home-page experiment live to the storefront. Requires confirmation.",
    inputSchema: { type: "object", properties: { experiment_id: { type: "string" } }, required: ["experiment_id"] },
    tier: "confirm",
    undoable: false,
    validate: (i): ValidationResult => {
      const experimentId = str(i.experiment_id);
      return experimentId
        ? { ok: true, value: { experiment_id: experimentId } }
        : { ok: false, message: "experiment_id is required" };
    },
    confirmSummary: async () => "Ship the winning variant — publishes it live to your storefront",
    run: async (ctx, i): Promise<ActionReceipt> => {
      await decideExperiment(ctx.shopId, String(i.experiment_id), "ship");
      return {
        action: "ship_experiment",
        summary: "Shipped the experiment — the winning variant is now live",
        auditId: null,
        undoable: false,
      };
    },
  },
];
