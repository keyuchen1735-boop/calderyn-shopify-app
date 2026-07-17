// app/routes/dashboard.api.assets.upload.tsx
// POST multipart form-data { file, purpose? } -> stores the image in the owned
// public bucket (#9) and returns a stable owned URL + asset id. Dashboard cookie
// auth + same-origin CSRF guard + a per-shop rate limit, mirroring
// dashboard.api.bug-report. When purpose=logo the owned URL is wired straight
// into the store's branding (store_settings.logo_url) — the imagery-accepting
// surface that already exists — so an uploaded logo is durable and self-hosted.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, rateLimit, requireSameOrigin } from "~/lib/dashboard/http.server";
import { persistUploadedImage, MAX_UPLOAD_BYTES } from "~/lib/assets/upload.server";
import { getStoreSettings, saveStoreSettings } from "~/lib/storefront/settings.server";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  // Public-bucket writes are an abuse/egress surface — cap uploads per shop.
  if (!(await rateLimit(`asset-upload:${session.shopId}`, 30, 15 * 60_000))) {
    return jsonError(429, "rate_limited", "Too many uploads. Please wait a few minutes.");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(422, "invalid_form");
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return jsonError(422, "missing_file");
  // Reject on declared size before buffering the bytes; the real cap is
  // re-checked against actual bytes in persistUploadedImage.
  if (file.size > MAX_UPLOAD_BYTES) {
    return jsonError(413, "file_too_large", "Images must be 10 MB or smaller.");
  }
  const purpose = form.get("purpose");
  const bytes = new Uint8Array(await file.arrayBuffer());

  return dashboardJson(async () => {
    const stored = await persistUploadedImage(session.shopId, { bytes, declaredType: file.type });
    if (purpose === "logo") {
      const current = await getStoreSettings(session.shopId);
      await saveStoreSettings(session.shopId, {
        storeName: current.storeName,
        palette: current.palette,
        logoUrl: stored.publicUrl,
        voiceTagline: current.voiceTagline,
      });
    }
    return {
      ok: true,
      id: stored.assetId,
      url: stored.publicUrl,
      assetRef: stored.storageKey,
      mime: stored.mime,
      ...(purpose === "logo" ? { applied: "logo" } : {}),
    };
  });
}
