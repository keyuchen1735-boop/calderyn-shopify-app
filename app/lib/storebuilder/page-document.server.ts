// app/lib/storebuilder/page-document.server.ts
// Server-only repo over public.page_document. Mirrors the access pattern in
// app/lib/buyer/identity.server.ts: service-role client, shop_id threaded on every query,
// snake_case rows kept out of callers (json columns ARE the BlockDocument, so they pass through).
import { getSupabase } from "~/lib/supabase.server";
import type { BlockDocument, PageKey } from "./types";
// The security boundary for AI/merchant-authored store HTML (the rawHtml block): sanitize at the
// persistence layer so no unsafe html is ever stored. saveDraft is the primary write path; the
// experiment variant_doc write applies the same helper (see store-experiment.server.ts), and
// publishDoc only ever copies an already-sanitized draft.
import { sanitizeDocHtml } from "./sanitize-html.server";

// ponytail: the fixture/demo storefront resolves a non-uuid shop ("demo-shop") and has no DB
// row; a uuid column query would error. Treat non-uuid shops as "no persisted doc" so the
// storefront falls back to the default doc. Real shops (uuid) read normally.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function persistableShop(shopId: string): boolean { return UUID_RE.test(shopId); }

export async function loadPublishedDoc(shopId: string, pageKey: PageKey): Promise<BlockDocument | null> {
  if (!persistableShop(shopId)) return null;
  const { data, error } = await getSupabase()
    .from("page_document").select("published_json").eq("shop_id", shopId).eq("page_key", pageKey).maybeSingle();
  if (error) throw error;
  return (data?.published_json as BlockDocument | null) ?? null;
}

export async function loadDraftDoc(shopId: string, pageKey: PageKey): Promise<BlockDocument | null> {
  if (!persistableShop(shopId)) return null;
  const { data, error } = await getSupabase()
    .from("page_document").select("draft_json").eq("shop_id", shopId).eq("page_key", pageKey).maybeSingle();
  if (error) throw error;
  return (data?.draft_json as BlockDocument | null) ?? null;
}

/** Upsert the editable draft. The doc's own `kind` is the row's kind. */
export async function saveDraft(shopId: string, pageKey: PageKey, doc: BlockDocument): Promise<void> {
  if (!persistableShop(shopId)) throw new Error(`saveDraft requires a real (uuid) shop_id, got ${shopId}`);
  const safe = sanitizeDocHtml(doc); // sanitize any AI/merchant rawHtml before it ever reaches the DB
  const { error } = await getSupabase().from("page_document").upsert(
    { shop_id: shopId, page_key: pageKey, kind: safe.kind, draft_json: safe, updated_at: new Date().toISOString() },
    { onConflict: "shop_id,page_key" },
  );
  if (error) throw error;
}

/**
 * Promote draft → published. Fails visibly if there is no draft (rule 12).
 * CALLER OBLIGATION: validate the draft (validateDocument) before publishing — this repo does NOT
 * re-validate here, so a fabricated catalog id in an unvalidated draft would reach published_json.
 */
export async function publishDoc(shopId: string, pageKey: PageKey): Promise<void> {
  if (!persistableShop(shopId)) throw new Error(`publishDoc requires a real (uuid) shop_id, got ${shopId}`);
  const sb = getSupabase();
  const { data, error } = await sb
    .from("page_document").select("draft_json, kind").eq("shop_id", shopId).eq("page_key", pageKey).maybeSingle();
  if (error) throw error;
  if (!data?.draft_json) throw new Error(`no draft to publish for (${shopId}, ${pageKey})`);
  const { error: upErr } = await sb
    .from("page_document").update({ published_json: data.draft_json, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId).eq("page_key", pageKey);
  if (upErr) throw upErr;
}
