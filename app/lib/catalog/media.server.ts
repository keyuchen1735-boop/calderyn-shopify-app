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
