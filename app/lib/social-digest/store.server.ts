// app/lib/social-digest/store.server.ts
//
// Persists the rendered slide PNGs in a private Supabase Storage bucket so the
// approve/reject handlers (which run long after the cron rendered them) can read
// the bytes (LinkedIn upload) and mint signed preview/download URLs — without
// re-running chromium. Swap target = this file only (e.g. Vercel Blob) since the
// rest of the system deals in storage paths + signed URLs.

import { getSupabase } from "../supabase.server";

const BUCKET = "social-digest";
const SIGNED_URL_TTL_SEC = 7 * 24 * 60 * 60;

function key(id: string, platform: "li" | "ig", i: number): string {
  return `${id}/${platform}-${i}.png`;
}

/** Upload the LinkedIn + Instagram slide PNGs; returns their storage paths. */
export async function storeSlides(
  id: string,
  liShots: Buffer[],
  igShots: Buffer[],
): Promise<{ liPaths: string[]; igPaths: string[] }> {
  const sb = getSupabase();
  const upload = async (platform: "li" | "ig", shots: Buffer[]) => {
    const paths: string[] = [];
    for (let i = 0; i < shots.length; i++) {
      const path = key(id, platform, i);
      const { error } = await sb.storage
        .from(BUCKET)
        .upload(path, shots[i], { contentType: "image/png", upsert: true });
      if (error) throw new Error(`store ${path}: ${error.message}`);
      paths.push(path);
    }
    return paths;
  };
  const liPaths = await upload("li", liShots);
  const igPaths = await upload("ig", igShots);
  return { liPaths, igPaths };
}

/** Signed, time-limited URL for embedding a slide in the email / landing page. */
export async function signedUrl(path: string): Promise<string> {
  const { data, error } = await getSupabase().storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SEC);
  if (error || !data) throw new Error(`signedUrl ${path}: ${error?.message ?? "no url"}`);
  return data.signedUrl;
}

export async function signedUrls(paths: string[]): Promise<string[]> {
  return Promise.all(paths.map(signedUrl));
}

/** Raw PNG bytes for a stored slide (used by the LinkedIn image upload). */
export async function downloadSlide(path: string): Promise<Buffer> {
  const { data, error } = await getSupabase().storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(`download ${path}: ${error?.message ?? "no data"}`);
  return Buffer.from(await data.arrayBuffer());
}
