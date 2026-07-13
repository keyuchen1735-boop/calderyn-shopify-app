// app/lib/catalog/media.server.ts
import { randomBytes } from "node:crypto";
import { getSupabase } from "../supabase.server";

export const PRODUCT_MEDIA_BUCKET = "product-media";
export const ALLOWED_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

export async function uploadProductMedia(
  shopId: string,
  productId: string,
  file: { bytes: Uint8Array; filename: string; contentType: string },
): Promise<{ id: string; storagePath: string }> {
  if (!ALLOWED_MEDIA_TYPES.has(file.contentType)) throw new Error("unsupported_media_type");
  if (file.bytes.byteLength > MAX_MEDIA_BYTES) throw new Error("media_too_large");

  const sb = getSupabase();
  // Authorize before touching Storage: the productId comes from the client, so
  // confirm it belongs to this shop — one shop must not attach media to another's
  // product. (Done first so a rejected request leaves no orphan blob.)
  const { data: owner, error: oErr } = await sb.from("product_dim").select("id").eq("id", productId).eq("shop_id", shopId).maybeSingle();
  if (oErr) throw oErr;
  if (!owner) throw new Error("product_not_found");

  const ext = file.contentType.split("/")[1] || "bin";
  const storagePath = `${shopId}/${productId}/${randomBytes(8).toString("hex")}.${ext}`;
  const { error: upErr } = await sb.storage.from(PRODUCT_MEDIA_BUCKET).upload(storagePath, file.bytes, { contentType: file.contentType, upsert: false });
  if (upErr) throw upErr;

  // First BUCKET image of a product is primary. Count only rows with a
  // storage_path: an imported product also carries hidden external-URL rows
  // (storage_path NULL, is_primary=true) that getProduct/the editor never show,
  // so counting them would persist the merchant's first uploaded image as
  // non-primary while the editor badges it "Main".
  const { count } = await sb
    .from("product_media")
    .select("id", { count: "exact", head: true })
    .eq("product_id", productId)
    .not("storage_path", "is", null);
  const isPrimary = (count ?? 0) === 0;
  // When this upload becomes primary, demote any prior primary (e.g. the imported
  // external image) so there is exactly one primary and it matches what the editor
  // shows — otherwise the storefront keeps serving the old external image first.
  if (isPrimary) {
    const { error: demoteErr } = await sb
      .from("product_media")
      .update({ is_primary: false })
      .eq("product_id", productId)
      .eq("is_primary", true);
    if (demoteErr) throw demoteErr;
  }
  const { data, error } = await sb
    .from("product_media")
    .insert({ product_id: productId, storage_path: storagePath, position: count ?? 0, is_primary: isPrimary })
    .select("id")
    .single();
  if (error) throw error;
  return { id: String(data.id), storagePath };
}

// Shared shop-scoping for the media management writes below: resolve the media
// row to its owning product and confirm that product belongs to this shop. The
// mediaId comes from the client, so a foreign/unknown id must be a clean no-op
// (null), never a cross-tenant write or an existence leak — the same contract
// deleteProductMedia applies.
async function ownedMediaRow(
  sb: ReturnType<typeof getSupabase>,
  shopId: string,
  mediaId: string,
): Promise<{ productId: string } | null> {
  const { data: row, error } = await sb.from("product_media").select("product_id").eq("id", mediaId).maybeSingle();
  if (error) throw error;
  if (!row) return null;
  const { data: owner, error: oErr } = await sb
    .from("product_dim")
    .select("id")
    .eq("id", String(row.product_id))
    .eq("shop_id", shopId)
    .maybeSingle();
  if (oErr) throw oErr;
  if (!owner) return null;
  return { productId: String(row.product_id) };
}

/** Make this image the product's primary: demote every current primary on the
 *  product (including a promoted external/mirror image), then flag this one, so
 *  there is always exactly one primary and the storefront lead image matches
 *  what the editor badges "Main". */
export async function setPrimaryMedia(shopId: string, mediaId: string): Promise<void> {
  const sb = getSupabase();
  const owned = await ownedMediaRow(sb, shopId, mediaId);
  if (!owned) return;
  const { error: demoteErr } = await sb
    .from("product_media")
    .update({ is_primary: false })
    .eq("product_id", owned.productId)
    .eq("is_primary", true);
  if (demoteErr) throw demoteErr;
  const { error } = await sb.from("product_media").update({ is_primary: true }).eq("id", mediaId);
  if (error) throw error;
}

export const MAX_MEDIA_ALT_CHARS = 300;

/** Set an image's alt text. Trimmed; empty clears to null; capped so a pasted
 *  wall of text can't bloat the row (alt is echoed on every storefront render). */
export async function setMediaAlt(shopId: string, mediaId: string, alt: string | null): Promise<void> {
  const sb = getSupabase();
  const owned = await ownedMediaRow(sb, shopId, mediaId);
  if (!owned) return;
  const trimmed = (alt ?? "").trim().slice(0, MAX_MEDIA_ALT_CHARS);
  const { error } = await sb.from("product_media").update({ alt: trimmed || null }).eq("id", mediaId);
  if (error) throw error;
}

/** Move an image one step up/down in the product's gallery order. Operates on
 *  the BUCKET-backed rows only (the set the editor shows — external mirror rows
 *  are invisible there), ordered by position with id as tiebreaker. Rather than
 *  a bare value swap (which no-ops when two rows share a position, e.g. legacy
 *  imports), the whole list is renumbered to its post-move index so order is
 *  self-healing. Moving past either edge is a no-op. */
export async function moveMedia(shopId: string, mediaId: string, dir: "up" | "down"): Promise<void> {
  const sb = getSupabase();
  const owned = await ownedMediaRow(sb, shopId, mediaId);
  if (!owned) return;
  const { data: rows, error } = await sb
    .from("product_media")
    .select("id, position")
    .eq("product_id", owned.productId)
    .not("storage_path", "is", null)
    .order("position")
    .order("id");
  if (error) throw error;
  const ordered = (rows ?? []).map((r) => ({ id: String(r.id), position: Number(r.position ?? 0) }));
  const idx = ordered.findIndex((r) => r.id === mediaId);
  if (idx < 0) return;
  const j = dir === "up" ? idx - 1 : idx + 1;
  if (j < 0 || j >= ordered.length) return; // edge — nothing to swap with
  [ordered[idx], ordered[j]] = [ordered[j], ordered[idx]];
  for (const [i, r] of ordered.entries()) {
    if (r.position === i) continue;
    const { error: upErr } = await sb.from("product_media").update({ position: i }).eq("id", r.id);
    if (upErr) throw upErr;
  }
}

export async function deleteProductMedia(shopId: string, mediaId: string): Promise<void> {
  const sb = getSupabase();
  const { data: row, error } = await sb.from("product_media").select("storage_path, product_id").eq("id", mediaId).maybeSingle();
  if (error) throw error;
  if (!row) return;
  // Scope to the shop: the mediaId comes from the client, so confirm the owning
  // product belongs to this shop before deleting — one shop must not be able to
  // delete another's image by guessing/knowing an id.
  const { data: owner, error: oErr } = await sb
    .from("product_dim")
    .select("id")
    .eq("id", String(row.product_id))
    .eq("shop_id", shopId)
    .maybeSingle();
  if (oErr) throw oErr;
  if (!owner) return; // not this shop's media — no-op, no leak
  // Delete the row BEFORE the blob: if the blob-remove then fails, we orphan an
  // invisible storage blob (harmless, reclaimable) rather than leaving a stale
  // product_media row that points at a now-deleted path and re-surfaces a
  // broken, 404-ing image in the gallery.
  const { error: delErr } = await sb.from("product_media").delete().eq("id", mediaId);
  if (delErr) throw delErr;
  const { error: rmErr } = await sb.storage.from(PRODUCT_MEDIA_BUCKET).remove([String(row.storage_path)]);
  if (rmErr) throw rmErr;
}
