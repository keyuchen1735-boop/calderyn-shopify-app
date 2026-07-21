// Publishing for the designer engine (hidden Labs): snapshots the display
// pages into designer_publications, which the public storefront serves in
// place of the runtime renderer. Cart and checkout are deliberately excluded —
// those stay on the functional storefront routes so commerce always works.
import { getSupabase } from "~/lib/supabase.server";
import { CalderynError } from "~/lib/calderyn.server";
import { requirePublishableTenantDomain } from "~/lib/storebuilder/studio.server";
import { tenantDomain } from "~/lib/storefront/vercel-domain.server";
import { expireOverdueExperiment, hasRunningExperiment } from "~/lib/experiments/store-experiment.server";
import { findImageRegistryViolations, unpublishableImageViolations } from "./image-registry.server";
import { designerProductImagesAvailable } from "./product-imagery.server";

const PUBLISHED_ROUTES = ["base", "home", "collection", "product", "search"] as const;

const PAGE_LABELS: Record<string, string> = {
  base: "Site styles (all pages)",
  home: "Home (/storefront)",
  collection: "Collection (/storefront/collections/all)",
  product: "Product (/storefront/products/<product>)",
  search: "Search (/storefront/search)",
};

function pageForFile(file: string): string {
  if (file === "base.css") return PAGE_LABELS.base;
  return PAGE_LABELS[file.replace(/\.(?:html|css)$/i, "")] ?? file;
}

/** Copies the current designer documents to the served snapshot and makes
 *  sure the tenant domain exists. Returns the public storefront URL. */
export async function publishDesignerSite(shopId: string): Promise<string> {
  // Draft edits are always safe mid-experiment, but PUBLISHING would shadow
  // both experiment arms with the designer snapshot and invalidate the test.
  await expireOverdueExperiment(shopId);
  if (await hasRunningExperiment(shopId)) {
    throw new CalderynError({
      code: "experiment_running",
      status: 409,
      message: "An experiment is running on your store. Decide it before publishing a new design.",
    });
  }
  const sb = getSupabase();
  const { data, error } = await sb
    .from("designer_documents")
    .select("route, html, css, template_id, built")
    .eq("shop_id", shopId)
    .in("route", [...PUBLISHED_ROUTES]);
  if (error) throw error;
  const rows = data ?? [];
  if (!rows.some((row) => row.route === "home")) {
    throw new CalderynError({
      code: "designer_not_built",
      status: 422,
      message: "Build your store in the designer before publishing.",
    });
  }

  const unfinished = rows.filter((row) => row.built === false);
  if (unfinished.length > 0) {
    const pages = [...new Set(unfinished.map((row) => PAGE_LABELS[String(row.route)] ?? String(row.route)))];
    throw new CalderynError({
      code: "designer_not_built",
      status: 422,
      message: `Finish these pages in Studio before publishing: ${pages.join(", ")}. Open each page and send any message to resume its repair.`,
    });
  }

  // Hard image gate (spec D4): a page referencing image files that don't
  // exist (or another template's art) must never go live — every view would
  // 404. Build-time repair loops fix these; publishing is the backstop.
  const files: Record<string, string> = {};
  let templateId = "";
  for (const row of rows) {
    templateId = String(row.template_id ?? "");
    if (row.route === "base") files["base.css"] = String(row.css ?? "");
    else {
      files[`${row.route}.html`] = String(row.html ?? "");
      files[`${row.route}.css`] = String(row.css ?? "");
    }
  }
  let findings = findImageRegistryViolations({
    files,
    templateId,
    firstBuild: false,
    // First pass discovers whether these documents reserve synthetic product
    // media. Only those stores need the catalog lookup below.
    productImagesAvailable: false,
  });
  if (findings.some((violation) =>
    violation.reason === "synthetic-product-media-stand-in"
    || (violation.reason === "missing-required-asset-binding" && /\{\{\s*product\.image\s*\}\}/i.test(violation.path)))) {
    const productImagesAvailable = await designerProductImagesAvailable(shopId);
    findings = findImageRegistryViolations({
      files,
      templateId,
      firstBuild: false,
      productImagesAvailable,
    });
  }
  const broken = unpublishableImageViolations(findings);
  if (broken.length > 0) {
    const byPage = new Map<string, string[]>();
    for (const violation of broken) {
      const page = pageForFile(violation.file);
      const paths = byPage.get(page) ?? [];
      if (!paths.includes(violation.path)) paths.push(violation.path);
      byPage.set(page, paths);
    }
    const affected = [...byPage.entries()]
      .map(([page, paths]) => `${page}: ${paths.slice(0, 3).join(", ")}`)
      .join("; ");
    throw new CalderynError({
      code: "designer_broken_imagery",
      status: 422,
      message: `These Studio pages contain broken or placeholder imagery: ${affected}. Open each named page, ask the designer to replace or remove that imagery, then publish again.`,
    });
  }

  const storefrontUrl = await requirePublishableTenantDomain(shopId);
  const snapshot = rows.map((row) => ({
    shop_id: shopId,
    route: String(row.route),
    html: String(row.html ?? ""),
    css: String(row.css ?? ""),
    published_at: new Date().toISOString(),
  }));
  const { error: upsertError } = await sb
    .from("designer_publications")
    .upsert(snapshot, { onConflict: "shop_id,route" });
  if (upsertError) throw upsertError;
  return storefrontUrl;
}

/** Read-only publication status, cheap enough to poll: when the home snapshot
 *  landed, plus the storefront URL for a publication that exists (no domain
 *  registration here — publishing already ensured it). The studio polls this
 *  because a publish POST's response can arrive minutes after the server
 *  finished the actual publish; the row is the truth. */
export async function designerPublicationStatus(
  shopId: string,
): Promise<{ publishedAt: string | null; storefrontUrl: string | null }> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("designer_publications")
    .select("published_at")
    .eq("shop_id", shopId)
    .eq("route", "home")
    .maybeSingle();
  if (error) throw error;
  const publishedAt = data?.published_at ? String(data.published_at) : null;
  if (!publishedAt) return { publishedAt: null, storefrontUrl: null };
  if (process.env.NODE_ENV === "development") return { publishedAt, storefrontUrl: "/storefront" };
  const { data: shop, error: shopError } = await sb.from("shops").select("org_slug").eq("id", shopId).maybeSingle();
  if (shopError) throw shopError;
  const orgSlug = typeof shop?.org_slug === "string" ? shop.org_slug.trim() : "";
  return { publishedAt, storefrontUrl: orgSlug ? `https://${tenantDomain(orgSlug)}/storefront` : null };
}
