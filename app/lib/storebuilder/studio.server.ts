// app/lib/storebuilder/studio.server.ts
// Read model for the Store screen, composed over the existing
// storebuilder/storegen/storefront libs. Server-only: reaches page_document,
// store_settings and store_generation through the service-role client the
// underlying libs already use.
import { getSupabase } from "~/lib/supabase.server";
import { slugify } from "~/lib/auth/tenant.server";
import {
  isTenantDomainReachable,
  registerTenantDomain,
  tenantDomain,
} from "~/lib/storefront/vercel-domain.server";
import { CalderynError } from "~/lib/calderyn.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings, DEFAULT_PALETTE } from "~/lib/storefront/settings.server";
import { getConnectedAccount, isFullyEnabledAccount } from "~/lib/payments/connect.server";
import { listProducts as listAdminProducts } from "~/lib/catalog/catalog.server";
import { latestStudioExperiment } from "~/lib/experiments/store-experiment.server";
import { readStorefrontReleaseState } from "~/lib/storefront-bundle/build.server";
import { loadStorefrontPolicies } from "~/lib/storefront/policies.server";
import { loadDraftDoc, loadPublishedDoc } from "./page-document.server";
import type { BlockDocument } from "./types";
import type {
  StudioGeneration,
  StudioGenerationStatus,
  StudioHero,
  StudioProduct,
  StudioSection,
  StudioState,
} from "./studio-types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

export async function requirePublishableTenantDomain(shopId: string): Promise<string> {
  if (process.env.NODE_ENV === "development") return "/storefront";
  const sb = getSupabase();
  const { data, error } = await sb
    .from("shops")
    .select("org_slug, display_name, shop_domain")
    .eq("id", shopId)
    .maybeSingle();
  if (error) throw error;
  let orgSlug = typeof data?.org_slug === "string" ? data.org_slug.trim() : "";
  if (!orgSlug) {
    const storeName = (await getStoreSettings(shopId)).storeName.trim();
    const displayName = typeof data?.display_name === "string" ? data.display_name.trim() : "";
    const shopDomain = typeof data?.shop_domain === "string" ? data.shop_domain.replace(/\.myshopify\.com$/i, "") : "";
    for (let attempt = 0; attempt < 3 && !orgSlug; attempt++) {
      const candidate = slugify(storeName || displayName || shopDomain || "Store");
      const claimed = await sb
        .from("shops")
        .update({ org_slug: candidate })
        .eq("id", shopId)
        .is("org_slug", null)
        .select("org_slug")
        .maybeSingle();
      if (claimed.error && (claimed.error as { code?: string }).code !== "23505") throw claimed.error;
      if ((claimed.error as { code?: string } | null)?.code === "23505") continue;
      orgSlug = typeof claimed.data?.org_slug === "string" ? claimed.data.org_slug.trim() : "";
      if (!orgSlug) {
        const current = await sb.from("shops").select("org_slug").eq("id", shopId).maybeSingle();
        if (current.error) throw current.error;
        orgSlug = typeof current.data?.org_slug === "string" ? current.data.org_slug.trim() : "";
      }
    }
    if (!orgSlug) {
      throw new CalderynError({
        code: "storefront_domain_registration_failed",
        status: 503,
        message: "The storefront URL could not be reserved. Try publishing again.",
      });
    }
  }
  await registerTenantDomain(orgSlug);
  if (!(await isTenantDomainReachable(orgSlug))) {
    throw new CalderynError({
      code: "storefront_domain_registration_failed",
      status: 503,
      message: "The storefront domain could not be prepared. Try publishing again in a moment.",
    });
  }
  return `https://${tenantDomain(orgSlug)}/storefront`;
}

/** Extract the hero block's real text fields from a doc; null when absent. */
function heroFromDoc(doc: BlockDocument): StudioHero | null {
  const block = doc.blocks.find((b) => b.type === "hero");
  if (!block) return null;
  return {
    headline: str(block.props.headline, "Welcome"),
    subhead: str(block.props.subhead, "Shop our latest"),
  };
}

// ── Sections (editable pieces of the home page) ────────────────────────────────

const SECTION_TITLE_MAX = 60;

/** First heading's text inside a rawHtml section, tags stripped; empty when none. */
function sectionHeading(html: string): string {
  const m = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(html);
  if (!m) return "";
  return m[1].replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, SECTION_TITLE_MAX);
}

/** Shape a home doc's blocks as the studio's editable section list. Only rawHtml blocks
 *  are "design" (regenerable) — template-vocabulary blocks (hero, featureRow, …) from
 *  fallback/default docs are movable/removable "content", never offered a dead Redo. */
export function sectionsFromDoc(doc: BlockDocument): StudioSection[] {
  return doc.blocks.map((b, i) => {
    if (b.type === "productGrid") {
      const heading = str((b.props as { heading?: unknown }).heading).trim();
      return { id: b.id, kind: "products" as const, title: heading || "Product grid" };
    }
    if (b.type === "collectionList") {
      const heading = str((b.props as { heading?: unknown }).heading).trim();
      return { id: b.id, kind: "collections" as const, title: heading || "Category cards" };
    }
    if (b.type === "rawHtml") {
      const html = typeof b.props.html === "string" ? b.props.html : "";
      return { id: b.id, kind: "design" as const, title: sectionHeading(html) || `Design section ${i + 1}` };
    }
    const label = str((b.props as { headline?: unknown }).headline ?? (b.props as { heading?: unknown }).heading).trim();
    return { id: b.id, kind: "content" as const, title: label.slice(0, SECTION_TITLE_MAX) || `${b.type.charAt(0).toUpperCase()}${b.type.slice(1)} section` };
  });
}

/** The home doc section mutations operate on: the draft, else a copy of the published page
 *  (first edit of a published-only store forks it into a draft — publish stays explicit). */
async function latestGeneration(shopId: string): Promise<StudioGeneration | null> {
  // Non-uuid (demo) shops have no rows and would error on the uuid column.
  if (!UUID_RE.test(shopId)) return null;
  const { data, error } = await getSupabase()
    .from("store_generation")
    .select("run_id, status, brief_text, created_at")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    runId: String(data.run_id),
    status: data.status as StudioGenerationStatus,
    brief: (data.brief_text as string | null) ?? null,
    createdAt: String(data.created_at),
  };
}

/** Whether payments are fully set up — the SAME fully-enabled definition the
 *  charge path routes on (isFullyEnabledAccount), so the publish warn panel can
 *  never desync from what checkout actually enforces. Advisory only (the publish
 *  warn panel), so a payments read error reports not-ready rather than failing
 *  the whole studio load. Demo (non-uuid) shops have no row and read as not ready. */
async function checkoutReady(shopId: string): Promise<boolean> {
  if (!UUID_RE.test(shopId)) return false;
  try {
    const account = await getConnectedAccount(shopId);
    return account != null && isFullyEnabledAccount(account);
  } catch (err) {
    console.error("[studio] checkout readiness read failed; reporting not ready", err);
    return false;
  }
}

/** Products sitting in draft status — invisible to the storefront until
 *  finished, but the studio must say where chat-box attachments went. */
async function draftProductCount(shopId: string): Promise<number> {
  if (!UUID_RE.test(shopId)) return 0;
  const { total } = await listAdminProducts(shopId, { status: "draft", limit: 1 });
  return total;
}

/** shops.org_slug — the owned-tenant identity the public storefront resolves
 *  by Host. Null for domain-keyed Shopify tenants and demo (non-uuid) shops.
 *  Fail-soft: a URL nicety must never fail the whole studio load. */
async function shopOrgSlug(shopId: string): Promise<string | null> {
  if (!UUID_RE.test(shopId)) return null;
  const { data, error } = await getSupabase()
    .from("shops")
    .select("org_slug")
    .eq("id", shopId)
    .maybeSingle();
  if (error) {
    console.error("[studio] org_slug lookup failed", { shopId, error: error.message });
    return null;
  }
  return typeof data?.org_slug === "string" && data.org_slug ? data.org_slug : null;
}

export async function loadStudioState(shopId: string): Promise<StudioState> {
  const catalog = getCatalog();
  const [settings, draft, published, products, generation, canCharge, draftCount, orgSlug, experiment, release, policies] =
    await Promise.all([
      getStoreSettings(shopId),
      loadDraftDoc(shopId, "home"),
      loadPublishedDoc(shopId, "home"),
      catalog.listProducts(shopId),
      latestGeneration(shopId),
      checkoutReady(shopId),
      draftProductCount(shopId),
      shopOrgSlug(shopId),
      latestStudioExperiment(shopId),
      UUID_RE.test(shopId)
        ? readStorefrontReleaseState(shopId)
        : Promise.resolve({
            draftVersionId: null,
            publishedVersionId: null,
            draftRuntimeVersion: null,
            publishedRuntimeVersion: null,
          }),
      UUID_RE.test(shopId) ? loadStorefrontPolicies(shopId) : Promise.resolve([]),
    ]);

  const doc = draft ?? published;
  const shaped: StudioProduct[] = products.slice(0, 3).map((p) => ({
    id: p.id,
    title: p.title,
    priceCents: p.variants[0]?.priceCents ?? null,
    imageUrl: p.images[0]?.url ?? null,
  }));

  return {
    settings: {
      storeName: settings.storeName,
      accent: settings.palette.primary || DEFAULT_PALETTE.primary,
      vibe: settings.vibe,
      typeStyle: settings.typeStyle,
      density: settings.density,
      logoUrl: settings.logoUrl,
      tagline: settings.voiceTagline,
    },
    hero: doc ? heroFromDoc(doc) : null,
    products: shaped,
    productCount: products.length,
    draftProductCount: draftCount,
    checkoutReady: canCharge,
    hasDraft: draft != null || release.draftVersionId != null,
    hasPublished: published != null || release.publishedVersionId != null,
    release: {
      draftVersionId: release.draftVersionId,
      publishedVersionId: release.publishedVersionId,
      draftRuntime: release.draftRuntimeVersion === 1 ? 1 : 0,
      publishedRuntime: release.publishedRuntimeVersion === 1 ? 1 : 0,
    },
    generation,
    orgSlug,
    sections: doc ? sectionsFromDoc(doc) : [],
    policies,
    // The public storefront resolves tenants by Host, so on the dashboard
    // origin the fixed app path renders the demo shell — the real tenant URL
    // needs the org_slug subdomain. tenantDomain keeps the host provably
    // identical to the one registered with Vercel at provisioning; in dev the
    // relative path is the one that reaches the environment under test.
    storefrontUrl:
      orgSlug && process.env.NODE_ENV !== "development"
        ? `https://${tenantDomain(orgSlug)}/storefront`
        : "/storefront",
    experiment,
  };
}
