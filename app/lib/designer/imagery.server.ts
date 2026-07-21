// Generated imagery for the designer. Uses the shared cheap Gemini image
// pipeline (flash-lite tier, quota-metered by the existing image ledger) and
// persists results into owned storage so both the preview CSP (img-src https:)
// and the live storefront CSP (supabase origin) allow them. Everything here is
// FAIL-SOFT: no image only means the design keeps template art or neutral
// placeholders — a build must never die on an image.
import { getSupabase } from "~/lib/supabase.server";
import { generateGeminiImages, geminiImageGenerationEnabled, ImageGenerationQuotaError } from "~/lib/storegen/imagery/gemini.server";
import { persistExternalImage } from "~/lib/assets/persist.server";

/** Fetch every generated asset for a shop as a {key: url} map. */
export async function loadDesignerAssets(shopId: string): Promise<Record<string, string>> {
  const { data, error } = await getSupabase()
    .from("designer_assets")
    .select("key, url")
    .eq("shop_id", shopId);
  if (error) {
    console.error("[designer/imagery] asset load failed", error);
    return {};
  }
  const map: Record<string, string> = {};
  for (const row of data ?? []) map[String(row.key)] = String(row.url);
  return map;
}

/** Adopt an EXISTING image (a product photo, a ready store asset, the store
 *  logo) as a named designer asset — zero generation quota (spec D4's
 *  "reuse before generate"). Persists an owned copy and records the
 *  designer_assets row. Fail-soft: null means the caller moves on to the
 *  next fallback in its chain. */
export async function adoptDesignerAsset(input: {
  shopId: string;
  key: string;
  url: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  try {
    const persisted = await persistExternalImage(input.shopId, input.url, "designer", "mirrored", { signal: input.signal });
    if (!persisted.url || persisted.url.startsWith("data:")) return null;
    const { error } = await getSupabase()
      .from("designer_assets")
      .upsert(
        {
          shop_id: input.shopId,
          key: input.key,
          url: persisted.url,
          prompt: "adopted from the store's existing imagery",
          created_at: new Date().toISOString(),
        },
        { onConflict: "shop_id,key" },
      );
    if (error) throw error;
    return persisted.url;
  } catch (err) {
    console.error("[designer/imagery] asset adoption failed (continuing without)", err);
    return null;
  }
}

/** Generate one named asset (e.g. "hero") and persist it. Returns the owned
 *  https URL, or null when generation is disabled, over quota, or failed —
 *  with quotaBlocked flagged so callers can tell the merchant honestly why
 *  their imagery is placeholders instead of failing silently. */
export async function generateDesignerAsset(input: {
  shopId: string;
  key: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<{ url: string | null; quotaBlocked: boolean }> {
  if (!geminiImageGenerationEnabled()) return { url: null, quotaBlocked: false };
  try {
    const [dataUrl] = await generateGeminiImages({
      shopId: input.shopId,
      purpose: "storefront_design",
      prompt: input.prompt,
      count: 1,
      signal: input.signal,
    });
    if (!dataUrl) return { url: null, quotaBlocked: false };
    const persisted = await persistExternalImage(input.shopId, dataUrl, "designer", "generated", { signal: input.signal });
    if (!persisted.url || persisted.url.startsWith("data:")) return { url: null, quotaBlocked: false };
    const { error } = await getSupabase()
      .from("designer_assets")
      .upsert(
        { shop_id: input.shopId, key: input.key, url: persisted.url, prompt: input.prompt.slice(0, 2000), created_at: new Date().toISOString() },
        { onConflict: "shop_id,key" },
      );
    if (error) throw error;
    return { url: persisted.url, quotaBlocked: false };
  } catch (err) {
    console.error("[designer/imagery] asset generation failed (continuing without)", err);
    return { url: null, quotaBlocked: err instanceof ImageGenerationQuotaError };
  }
}
