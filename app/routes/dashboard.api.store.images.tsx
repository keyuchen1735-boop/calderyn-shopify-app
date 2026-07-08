// app/routes/dashboard.api.store.images.tsx
// Step-wise imagery fill for the studio (design §3.2): each POST performs ONE unit of work —
// the home hero lifestyle image first (most-viewed visual), then one pending product listing
// image via the existing enhanceListing/store_asset pipeline — and reports what remains. The
// client loops until done, refreshing the preview between calls, so no single invocation
// approaches serverless limits and images appear incrementally.
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { requireSameOrigin } from "~/lib/dashboard/http.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { loadDraftDoc, saveDraft } from "~/lib/storebuilder/page-document.server";
import { sanitizeStoreHtml } from "~/lib/storebuilder/sanitize-html.server";
import { enhanceListing } from "~/lib/storegen/imagery/asset.server";
import { getImageProvider } from "~/lib/storegen/imagery/provider.server";
import { persistExternalImage } from "~/lib/assets/persist.server";
import { getSupabase } from "~/lib/supabase.server";
import { SAMPLE_TAG } from "~/lib/storegen/seed.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The home carries a `<div data-cd-hero-media></div>` placeholder the generator emits; swap it for
// a generated hero <img> exactly once. HERO_IMG_RE makes the swap idempotent across loop calls.
const HERO_MARKER_RE = /<div([^>]*)data-cd-hero-media([^>]*)>\s*<\/div>/i;
const HERO_IMG_RE = /<img[^>]*data-cd-hero-media/i;

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  const shopId = session.shopId;
  // Non-uuid (demo/fixture) shops have no DB rows and enhanceListing/saveDraft reject them; there is
  // nothing to fill, so report done rather than error the studio loop.
  if (!UUID_RE.test(shopId)) return json({ done: true, remaining: 0 });

  const catalog = getCatalog();
  const products = await catalog.listProducts(shopId);

  // A store_asset row (ready OR failed) means the product was already attempted — never retry, so the
  // loop terminates (rule 12: a failed row is a recorded outcome, not a reason to loop forever).
  const { data: assetRows, error: assetErr } = await getSupabase()
    .from("store_asset").select("product_id, status").eq("shop_id", shopId);
  if (assetErr) throw assetErr;
  const attempted = new Set((assetRows ?? []).map((r) => String(r.product_id)));
  const pending = products.filter(
    (p) => (p.tags?.includes(SAMPLE_TAG) || p.images.length === 0) && !attempted.has(p.id),
  );

  const home = await loadDraftDoc(shopId, "home");
  const raw = home?.blocks.find((b) => b.type === "rawHtml");
  const html = raw ? String((raw.props as { html?: string }).html ?? "") : "";
  if (home && raw && HERO_MARKER_RE.test(html) && !HERO_IMG_RE.test(html)) {
    const settings = await getStoreSettings(shopId);
    try {
      const out = await getImageProvider().generateListingImage({
        productTitle: settings.storeName,
        productDescription: `Brand hero lifestyle scene for ${settings.storeName}. ${settings.voiceTagline ?? ""}`.trim(),
        sourceImageUrl: null,
        mode: "lifestyle_scene",
      });
      // Capture the ephemeral provider URL into owned storage (never throws — returns the ephemeral
      // url on failure). The sanitizer keeps <img> with inline position:absolute (style/data-* ride
      // the "*" allowedAttributes; no allowedStyles filter), so the absolute-cover hero survives.
      const { url } = await persistExternalImage(shopId, out.url, "generated", "generated");
      // Function replacer: its return value is inserted literally, so `$`-sequences in `url` (the
      // persist failure path hands back the raw provider url, which may carry `$` in query params)
      // are never reinterpreted as String.replace substitution patterns.
      const patched = html.replace(
        HERO_MARKER_RE,
        () => `<img data-cd-hero-media class="cd-hero-media" src="${url}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" />`,
      );
      raw.props = { ...(raw.props as object), html: sanitizeStoreHtml(patched) };
      await saveDraft(shopId, "home", home);
      return json({ done: pending.length === 0, kind: "hero", remaining: pending.length });
    } catch (err) {
      console.error("[storegen] hero image generation failed", err);
      // Neutralize the marker so a failed hero is attempted once, not re-generated on every
      // fill iteration (each attempt is a paid call). A later full regeneration emits a fresh
      // marker, so the hero still regenerates then. The designed CSS hero stands without it.
      const cleared = html.replace(HERO_MARKER_RE, () => "<div></div>");
      raw.props = { ...(raw.props as object), html: sanitizeStoreHtml(cleared) };
      await saveDraft(shopId, "home", home);
      if (pending.length === 0) return json({ done: true, remaining: 0, heroFailed: true });
      const r = await enhanceListing(shopId, pending[0]);
      return json({ done: pending.length <= 1, kind: "product", remaining: pending.length - 1, heroFailed: true, last: r });
    }
  }

  if (pending.length > 0) {
    const r = await enhanceListing(shopId, pending[0]);
    return json({ done: pending.length <= 1, kind: "product", remaining: pending.length - 1, last: r });
  }
  return json({ done: true, remaining: 0 });
}
