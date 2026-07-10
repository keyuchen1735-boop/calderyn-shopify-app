import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  uploadProductMedia,
  deleteProductMedia,
  setPrimaryMedia,
  setMediaAlt,
  moveMedia,
  ALLOWED_MEDIA_TYPES,
  MAX_MEDIA_BYTES,
} from "~/lib/catalog/media.server";
import { signMediaPath } from "~/lib/catalog/sign-media.server";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);

  if (request.method === "DELETE") {
    let body: { mediaId?: unknown };
    try { body = (await request.json()) as { mediaId?: unknown }; } catch { return jsonError(422, "invalid_json"); }
    const mediaId = typeof body.mediaId === "string" ? body.mediaId : "";
    if (!mediaId) return jsonError(422, "missing_media_id");
    return dashboardJson(async () => { await deleteProductMedia(session.shopId, mediaId); return { ok: true }; });
  }

  // Media management intents (primary / alt / order) share one JSON PUT so the
  // client keeps a single media endpoint; the upload stays multipart POST below.
  if (request.method === "PUT") {
    let body: Record<string, unknown>;
    try { body = (await request.json()) as Record<string, unknown>; } catch { return jsonError(422, "invalid_json"); }
    const mediaId = typeof body.mediaId === "string" ? body.mediaId : "";
    if (!mediaId) return jsonError(422, "missing_media_id");
    const intent = typeof body.intent === "string" ? body.intent : "";
    if (intent === "set_primary") {
      return dashboardJson(async () => { await setPrimaryMedia(session.shopId, mediaId); return { ok: true }; });
    }
    if (intent === "set_alt") {
      if (body.alt != null && typeof body.alt !== "string") return jsonError(422, "invalid_alt");
      const alt = typeof body.alt === "string" ? body.alt : null;
      return dashboardJson(async () => { await setMediaAlt(session.shopId, mediaId, alt); return { ok: true }; });
    }
    if (intent === "move") {
      if (body.dir !== "up" && body.dir !== "down") return jsonError(422, "invalid_dir");
      const dir = body.dir;
      return dashboardJson(async () => { await moveMedia(session.shopId, mediaId, dir); return { ok: true }; });
    }
    return jsonError(422, "unknown_intent");
  }

  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  const form = await request.formData();
  const productId = String(form.get("productId") ?? "");
  const file = form.get("file");
  if (!productId) return jsonError(422, "missing_product_id");
  if (!(file instanceof File) || file.size === 0) return jsonError(422, "missing_file");
  // Reject by declared size/type BEFORE buffering the whole body into memory.
  if (file.size > MAX_MEDIA_BYTES) return jsonError(413, "media_too_large");
  if (!ALLOWED_MEDIA_TYPES.has(file.type)) return jsonError(415, "unsupported_media_type");
  const bytes = new Uint8Array(await file.arrayBuffer());
  return dashboardJson(async () => {
    const { id, storagePath } = await uploadProductMedia(session.shopId, productId, { bytes, filename: file.name, contentType: file.type });
    // Return a render-ready signed URL (private bucket) so the editor can show
    // the new image immediately without a re-fetch.
    return { id, url: (await signMediaPath(storagePath)) ?? "" };
  });
}
