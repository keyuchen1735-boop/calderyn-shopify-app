// app/lib/assets/persist.server.ts
//
// Owned asset storage (#9). Captures an ephemeral third-party image URL
// (generated output, Shopify CDN) into Calderyn's own PUBLIC Storage
// bucket and returns a stable, CDN-fronted owned URL, recording the asset in
// asset_dim. The public URL is served straight off Supabase's CDN — no signing.
//
// FAILURE HONESTY (rule 12): persistExternalImage never throws. On any failure
// it returns { persisted: false, url: <the original ephemeral url> } and logs —
// the caller keeps a working (if ephemeral) image instead of dropping it.
//
// SECURITY: only http(s) URLs are fetched; the host is checked against the same
// private/reserved/loopback deny-list the screener uses (SSRF), redirects are
// followed manually and re-validated per hop, and the download is bounded by a
// timeout AND a streaming byte cap so an attacker-controlled URL cannot OOM the
// function. The stored content-type is sniffed from the actual bytes (magic
// numbers), never trusted from a header.
import { randomUUID } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";
import { isPrivateHost } from "~/lib/screener/media.server";

export const SHOP_ASSETS_BUCKET = "shop-assets";

/** Max bytes we will pull from a remote URL (also the merchant-upload cap). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export type AssetSource = "upload" | "generated" | "mirrored";
export type SniffedMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const EXT_BY_MIME: Record<SniffedMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown by the internal store step; callers of persistExternalImage never see it. */
export class AssetError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = "AssetError";
  }
}

// --- content sniffing (magic numbers, not the response header) -------------

/** Identify a raster image from its leading bytes; null when unrecognized. */
export function sniffImageMime(b: Uint8Array): SniffedMime | null {
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 6 &&
    b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
    (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61
  ) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return "image/webp";
  return null;
}

/** Best-effort intrinsic pixel size. Nullable columns — null when not cheap to read (e.g. WebP). */
export function imageDimensions(b: Uint8Array, mime: SniffedMime): { width: number; height: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (mime === "image/png" && b.length >= 24) {
    const width = dv.getUint32(16);
    const height = dv.getUint32(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (mime === "image/gif" && b.length >= 10) {
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  if (mime === "image/jpeg") return jpegDimensions(b, dv);
  return null;
}

function jpegDimensions(b: Uint8Array, dv: DataView): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    // SOF0..SOF15 carry the frame size; skip DHT(C4), JPG(C8), DAC(CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
    }
    // Standalone markers (SOI/EOI/RSTn) have no length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = dv.getUint16(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

// --- SSRF-guarded, bounded fetch -------------------------------------------

export interface AssetFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}
export type AssetFetch = (
  url: string,
  init: { redirect: "manual"; signal: AbortSignal },
) => Promise<AssetFetchResponse>;

const defaultFetch: AssetFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<AssetFetchResponse>;

/** http(s) only, to a public (non-private/reserved/loopback) host. */
export function isFetchableUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return !isPrivateHost(u.hostname);
}

async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) throw new AssetError("empty_body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new AssetError("too_large", `remote image exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function fetchImageBytes(
  url: string,
  fetchImpl: AssetFetch,
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isFetchableUrl(current)) throw new AssetError("blocked_url", `refused to fetch ${current}`);
    const ac = new AbortController();
    const forwardAbort = () => ac.abort(signal?.reason ?? new DOMException("Asset fetch cancelled", "AbortError"));
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: AssetFetchResponse;
    try {
      res = await fetchImpl(current, { redirect: "manual", signal: ac.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new AssetError("bad_redirect", "3xx without a Location header");
      current = new URL(loc, current).toString(); // re-validated at the top of the next hop
      continue;
    }
    if (!res.ok) throw new AssetError("fetch_failed", `remote returned ${res.status}`);
    const cl = Number(res.headers.get("content-length"));
    if (Number.isFinite(cl) && cl > maxBytes) throw new AssetError("too_large", "content-length over cap");
    return readCapped(res.body, maxBytes);
  }
  throw new AssetError("too_many_redirects");
}

// --- storage + asset_dim ---------------------------------------------------

export interface StoredAsset {
  assetId: string;
  publicUrl: string;
  storageKey: string;
}

/**
 * Upload validated image bytes to the public bucket under a shopId-scoped,
 * uuid (non-enumerable) key and record the asset_dim row. Throws AssetError on
 * a bad shop id or a storage/DB failure. On a row-insert failure it removes the
 * just-uploaded blob so no orphaned public object is left behind.
 */
export async function storeImageBytes(
  shopId: string,
  bytes: Uint8Array,
  meta: { kind: string; source: AssetSource; mime: SniffedMime },
): Promise<StoredAsset> {
  if (!UUID_RE.test(shopId)) throw new AssetError("bad_shop_id", `storeImageBytes needs a uuid shop_id, got ${shopId}`);
  const dims = imageDimensions(bytes, meta.mime);
  const storageKey = `${shopId}/${randomUUID()}.${EXT_BY_MIME[meta.mime]}`;
  const sb = getSupabase();

  const up = await sb.storage
    .from(SHOP_ASSETS_BUCKET)
    .upload(storageKey, bytes, { contentType: meta.mime, upsert: false });
  if (up.error) throw new AssetError("upload_failed", up.error.message);

  const publicUrl = sb.storage.from(SHOP_ASSETS_BUCKET).getPublicUrl(storageKey).data.publicUrl;

  const ins = await sb
    .from("asset_dim")
    .insert({
      shop_id: shopId,
      storage_key: storageKey,
      public_url: publicUrl,
      kind: meta.kind,
      source: meta.source,
      mime: meta.mime,
      bytes: bytes.byteLength,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
    })
    .select("id")
    .single();
  if (ins.error) {
    await sb.storage.from(SHOP_ASSETS_BUCKET).remove([storageKey]).catch(() => {});
    throw new AssetError("insert_failed", ins.error.message);
  }
  return { assetId: String(ins.data.id), publicUrl, storageKey };
}

// --- public API ------------------------------------------------------------

export type PersistOutcome =
  | { persisted: true; url: string; assetId: string; storageKey: string }
  | { persisted: false; url: string; error: string };

export interface PersistOpts {
  fetchImpl?: AssetFetch;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function decodeDataImage(url: string, maxBytes: number): { bytes: Uint8Array; mediaType: SniffedMime } | null {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s.exec(url);
  if (!match) return null;
  if (match[2].length > Math.ceil(maxBytes / 3) * 4) throw new AssetError("too_large");
  const bytes = new Uint8Array(Buffer.from(match[2], "base64"));
  if (bytes.byteLength > maxBytes) throw new AssetError("too_large");
  const mediaType = sniffImageMime(bytes);
  if (!mediaType || mediaType !== match[1]) throw new AssetError("unrecognized_image");
  return { bytes, mediaType };
}

export async function fetchExternalImageBytes(
  url: string,
  opts: PersistOpts = {},
): Promise<{ bytes: Uint8Array; mediaType: SniffedMime }> {
  const inline = decodeDataImage(url, opts.maxBytes ?? MAX_IMAGE_BYTES);
  if (inline) return inline;
  const bytes = await fetchImageBytes(
    url,
    opts.fetchImpl ?? defaultFetch,
    opts.maxBytes ?? MAX_IMAGE_BYTES,
    opts.timeoutMs ?? FETCH_TIMEOUT_MS,
    opts.signal,
  );
  const mediaType = sniffImageMime(bytes);
  if (!mediaType) throw new AssetError("unrecognized_image");
  return { bytes, mediaType };
}

/**
 * Capture an external image URL into owned storage and return a stable owned
 * URL. Never throws: on failure returns { persisted: false, url } with the
 * ORIGINAL url so the caller keeps a working image, and logs the failure.
 */
export async function persistExternalImage(
  shopId: string,
  url: string,
  kind: string,
  source: AssetSource,
  opts: PersistOpts = {},
): Promise<PersistOutcome> {
  try {
    const inline = decodeDataImage(url, opts.maxBytes ?? MAX_IMAGE_BYTES);
    if (inline) {
      const stored = await storeImageBytes(shopId, inline.bytes, { kind, source, mime: inline.mediaType });
      return { persisted: true, url: stored.publicUrl, assetId: stored.assetId, storageKey: stored.storageKey };
    }
    if (!isFetchableUrl(url)) {
      return keep(url, "blocked_url", { shopId, source });
    }
    const bytes = await fetchImageBytes(
      url,
      opts.fetchImpl ?? defaultFetch,
      opts.maxBytes ?? MAX_IMAGE_BYTES,
      opts.timeoutMs ?? FETCH_TIMEOUT_MS,
      opts.signal,
    );
    const mime = sniffImageMime(bytes);
    if (!mime) return keep(url, "unrecognized_image", { shopId, source });
    const stored = await storeImageBytes(shopId, bytes, { kind, source, mime });
    return { persisted: true, url: stored.publicUrl, assetId: stored.assetId, storageKey: stored.storageKey };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return keep(url, error, { shopId, source });
  }
}

/**
 * Optional library helper (#9's "mirror Shopify product images") — pull a
 * Shopify CDN image into owned storage as a 'mirrored' asset. NOT wired into
 * the product_media promote path (owned by the parallel Step-9 agent); exposed
 * so that path can adopt it. Same failure-honest contract as persistExternalImage.
 */
export function mirrorShopifyImage(
  shopId: string,
  shopifyUrl: string,
  kind = "product",
  opts: PersistOpts = {},
): Promise<PersistOutcome> {
  return persistExternalImage(shopId, shopifyUrl, kind, "mirrored", opts);
}

function keep(
  url: string,
  error: string,
  ctx: { shopId: string; source: AssetSource },
): { persisted: false; url: string; error: string } {
  // Never drop the image: log the persistence failure and hand back the
  // ephemeral url so the caller still has something to show/store (rule 12).
  console.error("[assets] persistExternalImage failed; keeping ephemeral url", {
    shopId: ctx.shopId,
    source: ctx.source,
    error,
  });
  return { persisted: false, url, error };
}
