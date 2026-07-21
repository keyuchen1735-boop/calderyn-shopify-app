// SEO/AEO move applies. Fully deterministic: the meta is composed from the
// product's own words + the focus query through the seo writer's building
// blocks and gated by the shared validator bounds - "through existing
// validated pipelines", zero Claude spend. prior_state + applied_state_hash
// give one-click revert with a staleness guard (a merchant edit after apply
// demands an explicit confirm instead of being silently clobbered).
import { createHash } from "node:crypto";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings, type StoreSettings } from "~/lib/storefront/settings.server";
import type { StoreProduct } from "~/lib/storefront/catalog";
import {
  deleteSeoOverride,
  getSeoOverride,
  getSeoSettings,
  upsertSeoOverride,
  upsertSeoSettings,
} from "~/lib/seo/seo-store.server";
import { buildStoreDescription } from "~/lib/seo/writer.server";
import { clampText, clampTitle, plainText } from "~/lib/seo/text";
import { validateMeta } from "~/lib/seo/validator.server";
import type { RadarMoveRow } from "./types";

export class RadarApplyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
  ) {
    super(message);
    this.name = "RadarApplyError";
  }
}

export interface ApplyOutcome {
  priorState: Record<string, unknown> | null;
  appliedStateHash: string | null;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

const DESC_MAX = 155; // mirrors the writer's product-description clamp
const DESC_MIN_SAFE = 50; // validator floor

/** Deterministic query-focused meta from the product's own words. Guaranteed
 *  inside validator bounds: the title folds in the focus query (writer-style
 *  store-name suffix), the description pads with an honest availability line
 *  when the product copy is thin. */
export function deterministicMeta(
  product: StoreProduct,
  focusQuery: string,
  store: StoreSettings,
): { title: string; description: string } {
  const base = product.title.toLowerCase().includes(focusQuery.toLowerCase())
    ? product.title
    : `${product.title}: ${focusQuery}`;
  let title = clampTitle(base, store.storeName);
  if (title.trim().length < 10) title = clampText(`${base} | ${store.storeName}`, 60);
  const body = plainText(product.description);
  let description = clampText(
    body ? `${focusQuery[0].toUpperCase()}${focusQuery.slice(1)}: ${body}` : `${base} from ${store.storeName}.`,
    DESC_MAX,
  );
  if (description.trim().length < DESC_MIN_SAFE) {
    description = clampText(
      `${description} See details, prices and current availability, then order online from ${store.storeName}.`,
      DESC_MAX,
    );
  }
  return { title, description };
}

export async function applySeoMeta(
  shopId: string,
  move: RadarMoveRow,
  actorId: string | null,
): Promise<ApplyOutcome> {
  const handle = String(move.payload.handle ?? "");
  const focusQuery = String(move.payload.focusQuery ?? "");
  if (!handle || !focusQuery) {
    throw new RadarApplyError("bad_payload", "This move is missing its target page.", 422);
  }
  const [product, store] = await Promise.all([
    getCatalog().getProduct(shopId, handle),
    getStoreSettings(shopId),
  ]);
  if (!product) {
    throw new RadarApplyError("product_missing", "That product is no longer in your catalog.", 409);
  }
  const prior = await getSeoOverride(shopId, "product", product.id);
  const meta = deterministicMeta(product, focusQuery, store);
  const issues = validateMeta(meta.title, meta.description);
  if (issues.length > 0) {
    // Should be unreachable given deterministicMeta's guarantees; surfacing
    // beats publishing invalid meta (rule: invalid output never publishes).
    throw new RadarApplyError("meta_invalid", issues.map((i) => i.message).join("; "), 422);
  }
  await upsertSeoOverride(shopId, {
    entityType: "product",
    entityId: product.id,
    metaTitle: meta.title,
    metaDescription: meta.description,
    updatedBy: actorId,
  });
  return {
    priorState: {
      kind: "seo_meta",
      entityId: product.id,
      prior: prior ? { metaTitle: prior.metaTitle, metaDescription: prior.metaDescription } : null,
    },
    // meta_title/meta_description are flat text columns, and both sides hash a hand-built
    // { metaTitle, metaDescription } literal in this same key order - never a whole jsonb blob
    // round-tripped through Postgres - so there's no canonicalization for the apply-time hash and
    // the revert-time re-read to go asymmetric on.
    appliedStateHash: sha256({ metaTitle: meta.title, metaDescription: meta.description }),
  };
}

export async function revertSeoMeta(
  shopId: string,
  move: RadarMoveRow,
  opts: { confirm: boolean },
  actorId: string | null,
): Promise<void> {
  const ps = move.priorState as
    | { entityId?: string; prior?: { metaTitle: string | null; metaDescription: string | null } | null }
    | null;
  const entityId = ps?.entityId;
  if (!entityId) throw new RadarApplyError("nothing_to_revert", "This move has nothing to undo.", 422);
  const current = await getSeoOverride(shopId, "product", entityId);
  const currentHash = current
    ? sha256({ metaTitle: current.metaTitle, metaDescription: current.metaDescription })
    : sha256(null);
  if (currentHash !== move.appliedStateHash && !opts.confirm) {
    throw new RadarApplyError(
      "revert_conflict",
      "This page's search text was edited after the move was applied. Reverting will overwrite that edit.",
      409,
    );
  }
  if (ps?.prior) {
    await upsertSeoOverride(shopId, {
      entityType: "product",
      entityId,
      metaTitle: ps.prior.metaTitle,
      metaDescription: ps.prior.metaDescription,
      updatedBy: actorId,
    });
  } else {
    await deleteSeoOverride(shopId, "product", entityId);
  }
}

/** AEO refresh: give AI assistants a store description to quote. Same
 *  deterministic composition Preferences suggests; the serve paths (llms.txt,
 *  org JSON-LD) pick it up on the next request because they render live. */
export async function applyOrgRefresh(shopId: string, _move: RadarMoveRow): Promise<ApplyOutcome> {
  const seo = await getSeoSettings(shopId);
  const [store, collections, products] = await Promise.all([
    getStoreSettings(shopId),
    getCatalog().listCollections(shopId),
    getCatalog().listProducts(shopId),
  ]);
  const subjects = collections.length
    ? collections.map((c) => c.title)
    : products.slice(0, 3).map((p) => p.title);
  const description = buildStoreDescription(store, subjects);
  await upsertSeoSettings(shopId, { orgDescription: description });
  return {
    priorState: { kind: "org", prior: seo.orgDescription ?? null },
    // Scalar string in, scalar string out (org_description is a flat text column) - no object to
    // canonicalize, so this is symmetric with revertOrgRefresh's read by construction.
    appliedStateHash: sha256(description),
  };
}

export async function revertOrgRefresh(
  shopId: string,
  move: RadarMoveRow,
  opts: { confirm: boolean },
): Promise<void> {
  const ps = move.priorState as { prior?: string | null } | null;
  const seo = await getSeoSettings(shopId);
  if (sha256(seo.orgDescription ?? null) !== move.appliedStateHash && !opts.confirm) {
    throw new RadarApplyError(
      "revert_conflict",
      "Your store description was edited after this move was applied. Reverting will overwrite that edit.",
      409,
    );
  }
  await upsertSeoSettings(shopId, { orgDescription: ps?.prior ?? null });
}
