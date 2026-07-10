import { randomBytes } from "node:crypto";
import { getSupabase } from "../supabase.server";
import { CalderynError } from "../calderyn.server";
import { projectProductToSkuDim } from "./project-sku-dim.server";
import { seedInitialStock } from "../inventory/engine.server";
import { escapeLike } from "./inventory-list.server";
import { collectionHandle, productHandleBase } from "./handle";
import { catalogSortToOrder, type CatalogSort } from "./catalog-sort";
import type { ProductInput, ProductStatus, ProductSummary, ProductDetail, VariantInput } from "./types";

type Supa = ReturnType<typeof getSupabase>;

function notFound(): never {
  throw new CalderynError({ code: "not_found", status: 404, message: "product not found" });
}

/** List row = summary + the price/ship-readiness fields the catalog table shows. */
export interface ProductListItem extends ProductSummary {
  /** Lowest variant price in cents; null when no variant carries a price. */
  priceCents: number | null;
  /** True when every variant passes the same shipping predicate the activation
   * 422 uses (`incomplete_shipping` in validate.ts): digital
   * (requires_shipping=false) or weight + all three dimensions > 0. A variant
   * with no variant_shipping row counts as physical-with-no-dims (the same
   * defaults getProduct applies), so it fails. */
  shipDataOk: boolean;
  /** Heaviest physical-variant weight in grams; null when none recorded. */
  shipWeightGrams: number | null;
}

export async function listProducts(
  shopId: string,
  opts: { search?: string; status?: ProductStatus; limit?: number; offset?: number; sort?: CatalogSort } = {},
): Promise<{ products: ProductListItem[]; total: number }> {
  const sb = getSupabase();
  const limit = Math.min(opts.limit ?? 50, 100);
  // Clamp: a client-supplied negative offset would reach PostgREST .range(-n, ...)
  // and surface as an unhandled 500 instead of a clean empty page.
  const offset = Math.max(0, opts.offset ?? 0);

  let q = sb
    .from("product_dim")
    .select("id, title, status, updated_at", { count: "exact" })
    .eq("shop_id", shopId);
  if (opts.status) q = q.eq("status", opts.status);
  if (opts.search) q = q.ilike("title", `%${escapeLike(opts.search)}%`);
  // Stable tiebreaker after the sort column so offset paging can't skip/duplicate
  // rows that share a value (seeded/imported in the same write).
  const order = catalogSortToOrder(opts.sort ?? "updated");
  const { data: rows, count, error } = await q
    .order(order.column, { ascending: order.ascending })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const ids = (rows ?? []).map((r: { id: string }) => r.id);
  const mediaByProduct = new Map<string, string>();
  const variantCount = new Map<string, number>();
  // Per-product rollups for the catalog table: lowest variant price, heaviest
  // physical-variant weight, and whether every variant is ship-complete.
  const minPriceByProduct = new Map<string, number>();
  const shipOkByProduct = new Map<string, boolean>();
  const maxWeightByProduct = new Map<string, number>();
  if (ids.length) {
    // Bucket-backed primaries only: a promoted mirror image carries an external_url
    // and no storage_path (it renders on the storefront, not this admin thumbnail lane).
    const { data: media, error: mErr } = await sb.from("product_media").select("product_id, storage_path").in("product_id", ids).eq("is_primary", true).not("storage_path", "is", null);
    if (mErr) throw mErr;
    for (const m of media ?? []) mediaByProduct.set(String(m.product_id), String(m.storage_path));
    const { data: variants, error: vcErr } = await sb.from("variant_dim").select("id, product_id, retail_price_cents").in("product_id", ids);
    if (vcErr) throw vcErr;

    const variantIds = (variants ?? []).map((v: { id: string }) => String(v.id));
    const shippingByVariant = new Map<string, Record<string, unknown>>();
    // Chunk the id list: a page of products can carry hundreds of variants and
    // an unbounded .in() blows past PostgREST's URL length limit.
    const SHIP_IN_CHUNK = 200;
    for (let i = 0; i < variantIds.length; i += SHIP_IN_CHUNK) {
      const { data: shipping, error: shErr } = await sb
        .from("variant_shipping")
        .select("variant_id, weight_grams, length_mm, width_mm, height_mm, requires_shipping")
        .eq("shop_id", shopId)
        .in("variant_id", variantIds.slice(i, i + SHIP_IN_CHUNK));
      if (shErr) throw shErr;
      for (const s of (shipping ?? []) as Array<Record<string, unknown>>) {
        shippingByVariant.set(String(s.variant_id), s);
      }
    }

    for (const v of (variants ?? []) as Array<Record<string, unknown>>) {
      const pid = String(v.product_id);
      variantCount.set(pid, (variantCount.get(pid) ?? 0) + 1);

      const price = v.retail_price_cents == null ? null : Number(v.retail_price_cents);
      if (price != null) {
        const cur = minPriceByProduct.get(pid);
        if (cur == null || price < cur) minPriceByProduct.set(pid, price);
      }

      // Mirror of validate.ts's incomplete_shipping check, with getProduct's
      // defaults for a missing variant_shipping row (physical, zero weight).
      const sh = shippingByVariant.get(String(v.id)) ?? {};
      const physical = ((sh.requires_shipping as boolean | null) ?? true) !== false;
      const weight = Number(sh.weight_grams ?? 0);
      const complete =
        !physical ||
        (weight > 0 &&
          Number(sh.length_mm ?? 0) > 0 &&
          Number(sh.width_mm ?? 0) > 0 &&
          Number(sh.height_mm ?? 0) > 0);
      shipOkByProduct.set(pid, (shipOkByProduct.get(pid) ?? true) && complete);
      if (physical && weight > 0 && weight > (maxWeightByProduct.get(pid) ?? 0)) {
        maxWeightByProduct.set(pid, weight);
      }
    }
  }

  const products: ProductListItem[] = (rows ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    title: String(r.title),
    status: r.status as ProductStatus,
    primaryImagePath: mediaByProduct.get(String(r.id)) ?? null,
    variantCount: variantCount.get(String(r.id)) ?? 0,
    updatedAt: String(r.updated_at),
    priceCents: minPriceByProduct.get(String(r.id)) ?? null,
    // A product with zero variants passes vacuously — the same way it passes
    // the activation validator's per-variant loop.
    shipDataOk: shipOkByProduct.get(String(r.id)) ?? true,
    shipWeightGrams: maxWeightByProduct.get(String(r.id)) ?? null,
  }));
  return { products, total: count ?? products.length };
}

export async function getProduct(shopId: string, productId: string): Promise<ProductDetail | null> {
  const sb = getSupabase();
  const { data: p, error } = await sb
    .from("product_dim")
    .select("id, title, status, vendor, category, description, tags, updated_at")
    .eq("shop_id", shopId)
    .eq("id", productId)
    .maybeSingle();
  if (error) throw error;
  if (!p) return null;

  const [{ data: options }, { data: variants }, { data: vov }, { data: media }, { data: pc }] = await Promise.all([
    sb.from("product_option").select("id, name, position, product_option_value(id, value, position)").eq("product_id", productId).order("position"),
    sb.from("variant_dim").select("id, sku, title, retail_price_cents, compare_at_price_cents, unit_cost_cents, inventory_tracked, inventory_on_hand, position").eq("product_id", productId).order("position"),
    sb.from("variant_option_value").select("variant_id, option_value_id"),
    // Bucket-backed media only (see getCatalogProducts): a promoted mirror image
    // has an external_url + no storage_path and is served by the storefront reader.
    sb.from("product_media").select("id, storage_path, alt, position, is_primary").eq("product_id", productId).not("storage_path", "is", null).order("position"),
    sb.from("product_collection").select("collection_id").eq("product_id", productId),
  ]);

  // Fetch variant_shipping rows separately (child of variant_dim, not product_dim).
  const variantIds = (variants ?? []).map((v: { id: string }) => String(v.id));
  const shippingByVariant = new Map<string, Record<string, unknown>>();
  if (variantIds.length) {
    const { data: shippingRows, error: shErr } = await sb
      .from("variant_shipping")
      .select("variant_id, weight_grams, length_mm, width_mm, height_mm, requires_shipping, handling_days, signature_required, restricted_countries")
      .in("variant_id", variantIds);
    if (shErr) throw shErr;
    for (const row of (shippingRows ?? []) as Array<Record<string, unknown>>) {
      shippingByVariant.set(String(row.variant_id), row);
    }
  }

  const valuesByVariant = new Map<string, string[]>();
  for (const row of (vov ?? []) as Array<{ variant_id: string; option_value_id: string }>) {
    const k = String(row.variant_id);
    valuesByVariant.set(k, [...(valuesByVariant.get(k) ?? []), String(row.option_value_id)]);
  }

  // Canonical rank for each option value: option order (outer) then the value's
  // stored position (inner). PostgREST returns the variant_option_value links and
  // embedded option values in an undefined order, but the editor keys variants by
  // the ORDERED option-value labels, so a variant's option values (and the option
  // value lists) must come back in a deterministic option order — otherwise an
  // option edit fails to match an existing variant and drops its id.
  const valueRank = new Map<string, number>();
  for (const [oi, o] of (options ?? []).entries()) {
    const vals = ((o as Record<string, unknown>).product_option_value as Array<{ id: string; position?: number }> | undefined) ?? [];
    vals
      .slice()
      .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
      .forEach((v, vi) => valueRank.set(String(v.id), oi * 1_000_000 + vi));
  }

  return {
    id: String(p.id),
    title: String(p.title),
    status: p.status as ProductStatus,
    vendor: p.vendor ?? null,
    category: p.category ?? null,
    description: p.description ?? null,
    tags: (p.tags as string[]) ?? [],
    options: (options ?? []).map((o: Record<string, unknown>) => ({
      id: String(o.id),
      name: String(o.name),
      values: ((o.product_option_value as Array<{ id: string; value: string; position?: number }>) ?? [])
        .slice()
        .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
        .map((v) => ({ id: String(v.id), value: String(v.value) })),
    })),
    variants: (variants ?? []).map((v: Record<string, unknown>) => {
      const sh = shippingByVariant.get(String(v.id)) ?? {};
      return {
        id: String(v.id),
        sku: (v.sku as string | null) ?? null,
        title: String(v.title),
        retailPriceCents: (v.retail_price_cents as number | null) ?? null,
        compareAtPriceCents: (v.compare_at_price_cents as number | null) ?? null,
        unitCostCents: (v.unit_cost_cents as number | null) ?? null,
        inventoryTracked: (v.inventory_tracked as boolean | null) ?? null,
        inventoryOnHand: Number(v.inventory_on_hand ?? 0),
        optionValueIds: (valuesByVariant.get(String(v.id)) ?? [])
          .slice()
          .sort((a, b) => (valueRank.get(a) ?? 0) - (valueRank.get(b) ?? 0)),
        weightGrams: Number(sh.weight_grams ?? 0),
        lengthMm: (sh.length_mm as number | null) ?? null,
        widthMm: (sh.width_mm as number | null) ?? null,
        heightMm: (sh.height_mm as number | null) ?? null,
        requiresShipping: (sh.requires_shipping as boolean | null) ?? true,
        handlingDays: Number(sh.handling_days ?? 0),
        signatureRequired: Boolean(sh.signature_required ?? false),
        restrictedCountries: (sh.restricted_countries as string[]) ?? [],
      };
    }),
    media: (media ?? []).map((m: Record<string, unknown>) => ({
      id: String(m.id), storagePath: String(m.storage_path), alt: (m.alt as string | null) ?? null,
      position: Number(m.position ?? 0), isPrimary: Boolean(m.is_primary),
    })),
    collectionIds: (pc ?? []).map((r: { collection_id: string }) => String(r.collection_id)),
    updatedAt: String(p.updated_at),
  };
}

function productHandle(title: string): string {
  return `${productHandleBase(title)}-${randomBytes(3).toString("hex")}`;
}

// Writes a product's options + their values, returning ONE label->value-id map
// PER OPTION (in option order). A variant's optionValues are positional (value[i]
// belongs to option[i]), so the link path resolves value[i] against perOption[i] —
// this lets the same label repeat across options (Color:Red + Trim:Red) without the
// second option's value clobbering the first in a single flat map (which produced a
// duplicate variant_option_value PK and a 500). Extracted so createProduct (via
// writeProductChildren) and updateProduct share one implementation.
async function writeOptions(
  sb: Supa,
  productId: string,
  options: NonNullable<ProductInput["options"]>,
): Promise<Array<Map<string, string>>> {
  const perOption: Array<Map<string, string>> = [];
  for (const [i, opt] of options.entries()) {
    const { data: o, error: oErr } = await sb.from("product_option").insert({ product_id: productId, name: opt.name, position: i }).select("id").single();
    if (oErr) throw oErr;
    const valueIdByLabel = new Map<string, string>();
    for (const [j, val] of opt.values.entries()) {
      const { data: ov, error: ovErr } = await sb.from("product_option_value").insert({ option_id: o.id, value: val, position: j }).select("id").single();
      if (ovErr) throw ovErr;
      valueIdByLabel.set(val, String(ov.id));
    }
    perOption.push(valueIdByLabel);
  }
  return perOption;
}

// Resolve a variant's positional option-value labels to their value ids using the
// per-option maps (value[i] -> perOption[i]). Unresolved positions are dropped.
function variantLinks(
  variantId: string,
  optionValues: string[] | undefined,
  perOption: Array<Map<string, string>>,
): Array<{ variant_id: string; option_value_id: string }> {
  return (optionValues ?? [])
    .map((label, i) => perOption[i]?.get(label))
    .filter((x): x is string => Boolean(x))
    .map((option_value_id) => ({ variant_id: variantId, option_value_id }));
}

// Intersect client-supplied collection ids with the SHOP's own collections, deduped.
// Without this a stale id throws an FK 500 (partial write), a duplicate id throws a
// PK 500, and a foreign id would cross-tenant-attach this shop's product to another
// shop's collection (and leak its title into sku_dim via the projection).
async function ownedCollectionIds(sb: Supa, shopId: string, ids: string[] | undefined): Promise<string[]> {
  const unique = [...new Set(ids ?? [])];
  if (!unique.length) return [];
  const { data, error } = await sb.from("collection_dim").select("id").eq("shop_id", shopId).in("id", unique);
  if (error) throw error;
  return (data ?? []).map((r: { id: string }) => String(r.id));
}

// Whether a NEW variant should be inventory-tracked. Tracked means entered stock
// gates storefront availability (a tracked variant is sold out at 0). We track a
// physical variant the merchant gave a stock number (including 0); a digital
// product (requiresShipping === false) or one left with blank stock stays
// untracked = always available (make-to-order / digital). An explicit
// inventoryTracked from the caller always wins. Applied only to newly-created
// variants — an existing variant keeps its stored flag (never silently flipped).
function trackedForNewVariant(v: VariantInput): boolean {
  if (v.inventoryTracked !== undefined) return v.inventoryTracked;
  if (v.requiresShipping === false) return false;
  return v.inventoryOnHand !== undefined;
}

// A newly-inserted variant's starting stock, applied to the inventory ledger only
// AFTER sku_dim is projected (inventory_level_fact.sku_id has an FK to sku_dim.id).
interface StockSeed { variantId: string; onHand: number }

// Back each new variant's starting stock with a real ledger balance so the
// cannot-oversell engine can reserve against it — a "live" product with an
// unbacked inventory_on_hand can't actually be sold. seedInitialStock no-ops when
// stock is 0. Must run only after projectProductToSkuDim, or the level-fact write
// fails the sku_id FK.
async function applyStockSeeds(shopId: string, seeds: StockSeed[]): Promise<void> {
  for (const s of seeds) await seedInitialStock(shopId, s.variantId, s.onHand);
}

async function writeProductChildren(shopId: string, productId: string, input: ProductInput): Promise<StockSeed[]> {
  const sb = getSupabase();
  const perOption = await writeOptions(sb, productId, input.options ?? []);
  const seeds: StockSeed[] = [];

  // Variants + their option-value links.
  for (const [i, v] of input.variants.entries()) {
    const { data: variant, error: vErr } = await sb
      .from("variant_dim")
      .insert({
        shop_id: shopId, product_id: productId, sku: v.sku ?? null, title: v.title ?? "Default",
        retail_price_cents: v.retailPriceCents ?? null, compare_at_price_cents: v.compareAtPriceCents ?? null,
        unit_cost_cents: v.unitCostCents ?? null,
        inventory_policy: v.inventoryPolicy ?? null, inventory_tracked: trackedForNewVariant(v),
        inventory_on_hand: v.inventoryOnHand ?? 0, position: i,
      })
      .select("id")
      .single();
    if (vErr) throw vErr;
    const variantId = String(variant.id);
    // Persist shipping dimensions + requirements alongside the variant row.
    const { error: shErr } = await sb.from("variant_shipping").upsert({
      variant_id: variantId, shop_id: shopId,
      weight_grams: v.weightGrams ?? 0,
      length_mm: v.lengthMm ?? null, width_mm: v.widthMm ?? null, height_mm: v.heightMm ?? null,
      requires_shipping: v.requiresShipping ?? true,
      restricted_countries: v.restrictedCountries ?? [],
      handling_days: v.handlingDays ?? 0,
      signature_required: v.signatureRequired ?? false,
      updated_at: new Date().toISOString(),
    }, { onConflict: "variant_id" });
    if (shErr) throw shErr;
    const links = variantLinks(variantId, v.optionValues, perOption);
    if (links.length) {
      const { error: lErr } = await sb.from("variant_option_value").insert(links);
      if (lErr) throw lErr;
    }
    // Defer backing the variant's starting stock with a real ledger balance:
    // seeding writes inventory_level_fact (sku_id -> sku_dim.id FK), and sku_dim
    // isn't projected until AFTER this whole write completes, so seeding here
    // would violate the FK. The caller seeds once sku_dim exists.
    seeds.push({ variantId, onHand: v.inventoryOnHand ?? 0 });
  }

  // Collections — only the shop's own (filters out stale/duplicate/foreign ids).
  const collectionIds = await ownedCollectionIds(sb, shopId, input.collectionIds);
  if (collectionIds.length) {
    const { error: cErr } = await sb.from("product_collection").insert(collectionIds.map((collection_id) => ({ product_id: productId, collection_id })));
    if (cErr) throw cErr;
  }

  return seeds;
}

// Writes the full product graph, then projects sku_dim. Supabase has no client
// transaction, so writes are ordered parent->child; a failure throws and the
// route surfaces it (no projection runs on a failed write).
export async function createProduct(shopId: string, input: ProductInput): Promise<{ id: string }> {
  const sb = getSupabase();
  // Insert the product; retry with a fresh handle on the rare unique(shop_id,
  // handle) collision (productHandle appends random bytes, so a clash is
  // unlikely but possible). Throw on any other error or after 3 tries.
  let productId = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: prod, error: pErr } = await sb
      .from("product_dim")
      .insert({
        shop_id: shopId, handle: productHandle(input.title), title: input.title, status: input.status,
        vendor: input.vendor ?? null, category: input.category ?? null, description: input.description ?? null,
        tags: input.tags ?? [],
      })
      .select("id")
      .single();
    if (!pErr) { productId = String(prod.id); break; }
    if ((pErr as { code?: string }).code !== "23505" || attempt === 2) throw pErr;
  }

  const seeds = await writeProductChildren(shopId, productId, input);
  await projectProductToSkuDim(productId);
  await applyStockSeeds(shopId, seeds);
  return { id: productId };
}

// Updates a product. Options + collections have no external references, so they
// are wiped + rewritten. VARIANTS are referenced by order_line_fact (and by
// sku_dim via the id==id invariant), so they are RECONCILED BY ID — never wiped
// and re-inserted (that would mint new ids, orphan past orders, and break the
// projection). Media is managed separately (Task 5) so it survives an edit.
export async function updateProduct(shopId: string, productId: string, input: ProductInput): Promise<void> {
  const sb = getSupabase();
  // Authoritative parent update: a Supabase update matching 0 rows returns no
  // error, so without checking the affected rows a caller could target another
  // shop's product id and still have all the child writes below (which are only
  // product_id-scoped) wipe + rewrite that product. Require a matched row first.
  const { data: updated, error } = await sb
    .from("product_dim")
    .update({
      title: input.title, status: input.status, vendor: input.vendor ?? null, category: input.category ?? null,
      description: input.description ?? null, tags: input.tags ?? [], updated_at: new Date().toISOString(),
    })
    .eq("shop_id", shopId).eq("id", productId).select("id");
  if (error) throw error;
  if (!updated?.length) notFound();

  // Guard BEFORE any destructive child write: inventory_balance.variant_id (and
  // buyer holds) reference variant_dim ON DELETE CASCADE, so removing a variant
  // that still has on-hand or reserved units would silently wipe live stock and
  // orphan held reservations. Refuse the edit and tell the merchant to clear that
  // stock first. Runs first so a block leaves options/collections/variants intact.
  const keepIds = input.variants.map((v) => v.id).filter((id): id is string => Boolean(id));
  const removedSel = sb.from("variant_dim").select("id").eq("shop_id", shopId).eq("product_id", productId);
  const { data: removedRows, error: remErr } = keepIds.length ? await removedSel.notIn("id", keepIds) : await removedSel;
  if (remErr) throw remErr;
  const removedIds = (removedRows ?? []).map((r: Record<string, unknown>) => String(r.id));
  if (removedIds.length) {
    const { data: balances, error: balErr } = await sb
      .from("inventory_balance")
      .select("variant_id, on_hand, reserved")
      .eq("shop_id", shopId)
      .in("variant_id", removedIds);
    if (balErr) throw balErr;
    const hasLiveStock = (balances ?? []).some(
      (b: Record<string, unknown>) => Number(b.on_hand ?? 0) > 0 || Number(b.reserved ?? 0) > 0,
    );
    if (hasLiveStock) {
      throw new CalderynError({
        code: "variant_has_stock",
        status: 409,
        message: "Clear on-hand and reserved stock before removing a variant.",
      });
    }
  }

  // Options/values + collections: safe to wipe + rewrite (no external refs).
  await sb.from("product_option").delete().eq("product_id", productId); // cascades option_values
  await sb.from("product_collection").delete().eq("product_id", productId);
  const perOption = await writeOptions(sb, productId, input.options ?? []);

  // Variants: delete only the ones the merchant removed; keep the rest by id.
  const baseDel = sb.from("variant_dim").delete().eq("product_id", productId);
  const { error: delErr } = keepIds.length ? await baseDel.notIn("id", keepIds) : await baseDel;
  if (delErr) throw delErr;

  const seeds: StockSeed[] = [];
  for (const [i, v] of input.variants.entries()) {
    // inventory_policy is intentionally NOT written here: the editor never surfaces
    // it (getProduct doesn't select it; VariantDraft has no field), so writing
    // `v.inventoryPolicy ?? null` would null a stored/Shopify-imported value on every
    // edit and break the stockout-pause autopilot precondition. Omitting it preserves
    // the stored value on update; a brand-new variant defaults to null.
    const fields = {
      sku: v.sku ?? null, title: v.title ?? "Default", retail_price_cents: v.retailPriceCents ?? null,
      compare_at_price_cents: v.compareAtPriceCents ?? null, unit_cost_cents: v.unitCostCents ?? null,
      inventory_tracked: v.inventoryTracked ?? null, inventory_on_hand: v.inventoryOnHand ?? 0, position: i,
    };
    let variantId = v.id ?? null;
    if (variantId) {
      // Scope by product_id too, AND require the UPDATE to match a row. A Supabase
      // update of 0 rows returns no error, so without checking the affected rows a
      // crafted variants[].id belonging to ANOTHER shop would no-op here and then
      // have its option-value links (variant_option_value has no shop column)
      // deleted + rewritten below — a cross-tenant write. Skip any unmatched id.
      const { data: upd, error: uErr } = await sb.from("variant_dim").update(fields).eq("shop_id", shopId).eq("product_id", productId).eq("id", variantId).select("id");
      if (uErr) throw uErr;
      if (!upd?.length) continue;
    } else {
      // New variant added during an edit: derive the tracked flag (fields keeps
      // v.inventoryTracked ?? null, which preserves an existing variant's stored
      // flag on the update branch above but would wrongly leave a new one untracked).
      const { data: ins, error: iErr } = await sb
        .from("variant_dim")
        .insert({ shop_id: shopId, product_id: productId, ...fields, inventory_tracked: trackedForNewVariant(v) })
        .select("id")
        .single();
      if (iErr) throw iErr;
      variantId = String(ins.id);
      // A brand-new variant added during an edit needs its starting stock backed
      // in the ledger too (existing variants keep their own balances — never
      // re-seeded from the flat column here). Deferred until after sku_dim is
      // projected below, since the ledger seed writes inventory_level_fact whose
      // sku_id FKs sku_dim.id. No-op when stock is 0.
      seeds.push({ variantId, onHand: v.inventoryOnHand ?? 0 });
    }
    // Persist shipping dimensions + requirements for this variant (update path).
    const { error: shErr } = await sb.from("variant_shipping").upsert({
      variant_id: variantId, shop_id: shopId,
      weight_grams: v.weightGrams ?? 0,
      length_mm: v.lengthMm ?? null, width_mm: v.widthMm ?? null, height_mm: v.heightMm ?? null,
      requires_shipping: v.requiresShipping ?? true,
      restricted_countries: v.restrictedCountries ?? [],
      handling_days: v.handlingDays ?? 0,
      signature_required: v.signatureRequired ?? false,
      updated_at: new Date().toISOString(),
    }, { onConflict: "variant_id" });
    if (shErr) throw shErr;
    // Rebuild this variant's option-value links (option-value ids changed above).
    await sb.from("variant_option_value").delete().eq("variant_id", variantId);
    const links = variantLinks(variantId, v.optionValues, perOption);
    if (links.length) { const { error: lErr } = await sb.from("variant_option_value").insert(links); if (lErr) throw lErr; }
  }

  // Collections — only the shop's own (filters out stale/duplicate/foreign ids).
  const collectionIds = await ownedCollectionIds(sb, shopId, input.collectionIds);
  if (collectionIds.length) {
    const { error: cErr } = await sb.from("product_collection").insert(collectionIds.map((collection_id) => ({ product_id: productId, collection_id })));
    if (cErr) throw cErr;
  }

  await projectProductToSkuDim(productId);
  await applyStockSeeds(shopId, seeds);
}

export async function setProductStatus(shopId: string, productId: string, status: ProductStatus): Promise<void> {
  const sb = getSupabase();
  const { data: updated, error } = await sb.from("product_dim").update({ status, updated_at: new Date().toISOString() }).eq("shop_id", shopId).eq("id", productId).select("id");
  if (error) throw error;
  if (!updated?.length) notFound();
  await projectProductToSkuDim(productId);
}

export async function listCollections(
  shopId: string,
): Promise<Array<{ id: string; title: string; handle: string; productCount: number }>> {
  const sb = getSupabase();
  const { data, error } = await sb.from("collection_dim").select("id, title, handle").eq("shop_id", shopId).order("title");
  if (error) throw error;
  const rows = (data ?? []).map((c: Record<string, unknown>) => ({ id: String(c.id), title: String(c.title), handle: String(c.handle) }));

  // Membership counts folded from a paged select over this page's collection
  // ids — never a per-collection query (N+1 on every Collections paint).
  // Paged because PostgREST clamps every response at 1000 rows: a single
  // select would silently truncate past that and undercount.
  const countById = new Map<string, number>();
  if (rows.length) {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: memberships, error: mErr } = await sb
        .from("product_collection")
        .select("collection_id")
        .in("collection_id", rows.map((r) => r.id))
        .order("collection_id")
        .order("product_id")
        .range(from, from + PAGE - 1);
      if (mErr) throw mErr;
      const page = (memberships ?? []) as Array<{ collection_id: string }>;
      for (const m of page) {
        const k = String(m.collection_id);
        countById.set(k, (countById.get(k) ?? 0) + 1);
      }
      if (page.length < PAGE) break;
    }
  }
  return rows.map((r) => ({ ...r, productCount: countById.get(r.id) ?? 0 }));
}

// Shop-scoped existence check shared by every membership/rename/delete path:
// a foreign or missing collection id is a clean 404, never a cross-tenant write.
async function requireOwnedCollection(sb: Supa, shopId: string, collectionId: string): Promise<void> {
  const { data, error } = await sb
    .from("collection_dim")
    .select("id")
    .eq("shop_id", shopId)
    .eq("id", collectionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new CalderynError({ code: "collection_not_found", status: 404, message: "collection not found" });
}

/** Rename only — the handle stays unchanged so storefront links keep working. */
export async function updateCollection(shopId: string, collectionId: string, title: string): Promise<void> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("collection_dim")
    .update({ title: title.trim() })
    .eq("shop_id", shopId)
    .eq("id", collectionId)
    .select("id");
  if (error) throw error;
  if (!data?.length) throw new CalderynError({ code: "collection_not_found", status: 404, message: "collection not found" });
}

/** Delete a collection: memberships first (no FK orphans), then the row itself.
 *  Products are untouched — they simply leave the collection. */
export async function deleteCollection(shopId: string, collectionId: string): Promise<void> {
  const sb = getSupabase();
  await requireOwnedCollection(sb, shopId, collectionId);
  const { error: mErr } = await sb.from("product_collection").delete().eq("collection_id", collectionId);
  if (mErr) throw mErr;
  const { error } = await sb.from("collection_dim").delete().eq("shop_id", shopId).eq("id", collectionId);
  if (error) throw error;
}

/** Members of a collection, with the storage path of each product's primary
 *  image so the route can batch-sign thumbnails (mirrors listProducts). */
export async function listCollectionProducts(
  shopId: string,
  collectionId: string,
): Promise<Array<{ id: string; title: string; status: ProductStatus; primaryImagePath: string | null }>> {
  const sb = getSupabase();
  await requireOwnedCollection(sb, shopId, collectionId);
  // Paged: PostgREST clamps every response at 1000 rows, so a single select
  // would silently drop members of a >1000-product collection.
  const memberIds: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: memberships, error: mErr } = await sb
      .from("product_collection")
      .select("product_id")
      .eq("collection_id", collectionId)
      .order("product_id")
      .range(from, from + PAGE - 1);
    if (mErr) throw mErr;
    const page = (memberships ?? []) as Array<{ product_id: string }>;
    for (const m of page) memberIds.push(String(m.product_id));
    if (page.length < PAGE) break;
  }
  if (!memberIds.length) return [];

  const { data: products, error: pErr } = await sb
    .from("product_dim")
    .select("id, title, status")
    .eq("shop_id", shopId)
    .in("id", memberIds)
    .order("title");
  if (pErr) throw pErr;
  const ids = (products ?? []).map((p: { id: string }) => String(p.id));

  // Bucket-backed primaries only, same rule as listProducts: a promoted mirror
  // image carries an external_url and no storage_path.
  const mediaByProduct = new Map<string, string>();
  if (ids.length) {
    const { data: media, error: medErr } = await sb
      .from("product_media")
      .select("product_id, storage_path")
      .in("product_id", ids)
      .eq("is_primary", true)
      .not("storage_path", "is", null);
    if (medErr) throw medErr;
    for (const m of media ?? []) mediaByProduct.set(String(m.product_id), String(m.storage_path));
  }

  return (products ?? []).map((p: Record<string, unknown>) => ({
    id: String(p.id),
    title: String(p.title),
    status: p.status as ProductStatus,
    primaryImagePath: mediaByProduct.get(String(p.id)) ?? null,
  }));
}

// Both membership writes verify ownership on BOTH sides — collection and
// product — before touching product_collection, so a guessed foreign id can
// neither attach to nor detach from another shop's data.
async function requireOwnedProduct(sb: Supa, shopId: string, productId: string): Promise<void> {
  const { data, error } = await sb
    .from("product_dim")
    .select("id")
    .eq("shop_id", shopId)
    .eq("id", productId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new CalderynError({ code: "product_not_found", status: 404, message: "product not found" });
}

export async function addProductToCollection(shopId: string, collectionId: string, productId: string): Promise<void> {
  const sb = getSupabase();
  await requireOwnedCollection(sb, shopId, collectionId);
  await requireOwnedProduct(sb, shopId, productId);
  // Re-adding an existing member is a clean no-op, not a PK 500.
  const { error } = await sb
    .from("product_collection")
    .upsert(
      { product_id: productId, collection_id: collectionId },
      { onConflict: "product_id,collection_id", ignoreDuplicates: true },
    );
  if (error) throw error;
}

export async function removeProductFromCollection(shopId: string, collectionId: string, productId: string): Promise<void> {
  const sb = getSupabase();
  await requireOwnedCollection(sb, shopId, collectionId);
  await requireOwnedProduct(sb, shopId, productId);
  const { error } = await sb
    .from("product_collection")
    .delete()
    .eq("collection_id", collectionId)
    .eq("product_id", productId);
  if (error) throw error;
}

export async function createCollection(shopId: string, title: string): Promise<{ id: string }> {
  const sb = getSupabase();
  const base = collectionHandle(title);
  // Distinct titles can slugify to the same handle (e.g. "Summer Sale" and
  // "summer sale!"), which collides with unique(shop_id, handle). Retry with a
  // random suffix on 23505 (mirroring productHandle) instead of an opaque 500.
  for (let attempt = 0; attempt < 3; attempt++) {
    const handle = attempt === 0 ? base : `${base}-${randomBytes(3).toString("hex")}`;
    const { data, error } = await sb.from("collection_dim").insert({ shop_id: shopId, title: title.trim(), handle }).select("id").single();
    if (!error) return { id: String(data.id) };
    if ((error as { code?: string }).code !== "23505" || attempt === 2) throw error;
  }
  throw new CalderynError({ code: "handle_conflict", status: 409, message: "could not allocate a unique collection handle" });
}

export async function setVariantPrice(
  shopId: string,
  variantId: string,
  priceCents: number,
): Promise<{ priorPriceCents: number | null }> {
  const sb = getSupabase();
  const { data: v, error } = await sb
    .from("variant_dim")
    .select("product_id, retail_price_cents")
    .eq("shop_id", shopId)
    .eq("id", variantId)
    .maybeSingle();
  if (error) throw error;
  if (!v) throw new Error(`variant ${variantId} not found for shop`);
  const priorPriceCents = v.retail_price_cents == null ? null : Number(v.retail_price_cents);

  const { error: upErr } = await sb
    .from("variant_dim")
    .update({ retail_price_cents: priceCents, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", variantId);
  if (upErr) throw upErr;

  await projectProductToSkuDim(String(v.product_id));
  return { priorPriceCents };
}
