// app/lib/catalog/sign-media.server.ts
// Product images live in the PRIVATE `product-media` bucket, so the dashboard
// (and, later, the SSR storefront) renders them through short-lived signed URLs
// minted per request. A null path passes through as null.
import { getSupabase } from "../supabase.server";
import { PRODUCT_MEDIA_BUCKET } from "./media.server";

const TTL_SECONDS = 60 * 60;

export async function signMediaPath(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data } = await getSupabase()
    .storage.from(PRODUCT_MEDIA_BUCKET)
    .createSignedUrl(path, TTL_SECONDS);
  return data?.signedUrl ?? null;
}

/** Batch-sign distinct paths into a path->url map in ONE request (Storage's
 *  createSignedUrls), deduping first; unsignable paths are omitted. Avoids the
 *  N+1 of one signing round-trip per image on a storefront grid render. */
export async function signMediaPaths(paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const distinct = [...new Set(paths.filter(Boolean))];
  if (!distinct.length) return out;
  const { data } = await getSupabase()
    .storage.from(PRODUCT_MEDIA_BUCKET)
    .createSignedUrls(distinct, TTL_SECONDS);
  for (const row of data ?? []) {
    if (row?.path && row.signedUrl) out.set(row.path, row.signedUrl);
  }
  return out;
}
