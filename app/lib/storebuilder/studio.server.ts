// app/lib/storebuilder/studio.server.ts
// Read/update model for the Store studio surface, composed over the existing
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
import { getStoreSettings, saveStoreSettings, DEFAULT_PALETTE } from "~/lib/storefront/settings.server";
import { getConnectedAccount, isFullyEnabledAccount } from "~/lib/payments/connect.server";
import { listProducts as listAdminProducts } from "~/lib/catalog/catalog.server";
import { expireOverdueExperiment, hasRunningExperiment, latestStudioExperiment } from "~/lib/experiments/store-experiment.server";
import { injectMissingFunctionalBlocks } from "~/lib/storegen/sanitize";
import { regenerateHomeSection } from "~/lib/storegen/generate.server";
import { splitTopLevelSections } from "~/lib/storegen/hybrid";
import {
  isStorefrontBundlePublishEnabled,
  readStorefrontReleaseState,
} from "~/lib/storefront-bundle/build.server";
import { publishStorefrontRelease } from "~/lib/storefront-bundle/release.server";
import { loadStorefrontPolicies } from "~/lib/storefront/policies.server";
import { loadDraftDoc, loadPublishedDoc, saveDraft, publishDoc } from "./page-document.server";
import { defaultHomeDocument } from "./default-doc";
import { validateDocument, type ValidIds } from "./validate";
import type { Block, BlockDocument, PageKey } from "./types";
import type {
  StudioGeneration,
  StudioGenerationStatus,
  StudioHero,
  StudioProduct,
  StudioSection,
  StudioState,
  StudioVibe,
} from "./studio-types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The page keys the generator drafts — the studio's publishable set. */
const PUBLISHABLE_PAGES: PageKey[] = ["home", "collection", "pdp"];

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** Refuse a studio design write while an experiment is running. Arm A is the LIVE settings/doc,
 *  so a mid-test vibe/accent/hero change silently rewrites the control (or erases the very
 *  difference under test — setting the challenger's vibe makes both arms identical), and a later
 *  "ship" overwrites the edit with the challenger clone frozen at start time. Same posture as
 *  publish and generate. */
async function refuseMidTest(shopId: string, what: string): Promise<void> {
  if (await hasRunningExperiment(shopId)) {
    throw new CalderynError({
      code: "experiment_running",
      status: 409,
      message: `An experiment is running on your store. Decide it before changing the ${what}.`,
    });
  }
}

async function requirePublishableTenantDomain(shopId: string): Promise<string> {
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
async function loadHomeDocForEdit(shopId: string): Promise<BlockDocument> {
  const doc = (await loadDraftDoc(shopId, "home")) ?? (await loadPublishedDoc(shopId, "home"));
  if (!doc) {
    throw new CalderynError({
      code: "no_home_doc",
      status: 422,
      message: "Build your store first, then edit its sections.",
    });
  }
  return doc;
}

function requireSection(doc: BlockDocument, blockId: string): Block {
  const block = doc.blocks.find((b) => b.id === blockId);
  if (!block) {
    throw new CalderynError({
      code: "section_not_found",
      status: 404,
      message: "That section no longer exists. Refresh and try again.",
    });
  }
  return block;
}

/** Re-stack ys sequentially after any reorder/removal so the renderer's y-sort matches
 *  the array order the studio just produced. */
function restackedDoc(doc: BlockDocument, blocks: Block[]): BlockDocument {
  return { ...doc, blocks: blocks.map((b, i) => ({ ...b, layout: { ...b.layout, y: i } })) };
}

async function saveHomeDoc(shopId: string, doc: BlockDocument): Promise<StudioSection[]> {
  const valid = await catalogValidIds(shopId);
  const { doc: clean } = validateDocument(doc, valid);
  await saveDraft(shopId, "home", clean);
  return sectionsFromDoc(clean);
}

/** Move a home section one step up or down the page. */
export async function moveStudioSection(
  shopId: string,
  blockId: string,
  direction: "up" | "down",
): Promise<StudioSection[]> {
  await refuseMidTest(shopId, "page layout");
  const doc = await loadHomeDocForEdit(shopId);
  requireSection(doc, blockId);
  const blocks = [...doc.blocks];
  const from = blocks.findIndex((b) => b.id === blockId);
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= blocks.length) return sectionsFromDoc(doc); // already at the edge — no-op
  [blocks[from], blocks[to]] = [blocks[to], blocks[from]];
  return saveHomeDoc(shopId, restackedDoc(doc, blocks));
}

/** Remove a home section. The last remaining section is not removable — an empty
 *  home would render blank, which is never what a merchant means. */
export async function removeStudioSection(shopId: string, blockId: string): Promise<StudioSection[]> {
  await refuseMidTest(shopId, "page layout");
  const doc = await loadHomeDocForEdit(shopId);
  requireSection(doc, blockId);
  if (doc.blocks.length <= 1) {
    throw new CalderynError({
      code: "last_section",
      status: 422,
      message: "A page needs at least one section. Regenerate it instead of removing it.",
    });
  }
  const blocks = doc.blocks.filter((b) => b.id !== blockId);
  return saveHomeDoc(shopId, restackedDoc(doc, blocks));
}

// Matches the wrapper convention spliceCatalogBlocks emits: every design section's html is
// `<div class="ai-store">[<style>…</style>]<section-or-content></div>`.
const AI_WRAP_OPEN = '<div class="ai-store">';

/** Regenerate ONE design section of the home page with the design model, keeping the
 *  page's scoped style block intact. Only rawHtml sections qualify — a live product
 *  grid has nothing to regenerate. */
export async function regenerateStudioSection(
  shopId: string,
  blockId: string,
  instruction?: string,
): Promise<StudioSection[]> {
  await refuseMidTest(shopId, "page design");
  const doc = await loadHomeDocForEdit(shopId);
  const block = requireSection(doc, blockId);
  if (block.type !== "rawHtml" || typeof block.props.html !== "string") {
    throw new CalderynError({
      code: "not_a_design_section",
      status: 422,
      message: "Only design sections can be regenerated. Catalog sections always show your live products.",
    });
  }
  // Peel the wrapper + scoped style so the model sees just the section, and the
  // replacement is re-wrapped with the SAME style (page-wide CSS must survive the edit).
  const originalHtml = block.props.html;
  let inner = originalHtml;
  let style = "";
  if (inner.startsWith(AI_WRAP_OPEN) && inner.endsWith("</div>")) {
    inner = inner.slice(AI_WRAP_OPEN.length, -"</div>".length);
    if (inner.startsWith("<style")) {
      const end = inner.indexOf("</style>");
      if (end !== -1) {
        style = inner.slice(0, end + "</style>".length);
        inner = inner.slice(end + "</style>".length);
      }
    }
  }
  // Legacy blocks predate per-section splitting and can hold a WHOLE page; the revision
  // contract returns exactly one <section>, so regenerating in place would silently delete
  // every other section. Split the block apart first and ask the merchant to pick again.
  const pieces = splitTopLevelSections(inner);
  if (pieces.length > 1) {
    const replacementBlocks: Block[] = pieces.map((piece, i) => ({
      ...block,
      id: `${block.id}-s${i}`,
      props: { ...block.props, html: `${AI_WRAP_OPEN}${style}${piece}</div>` },
    }));
    const idx = doc.blocks.findIndex((b) => b.id === blockId);
    const blocks = [...doc.blocks.slice(0, idx), ...replacementBlocks, ...doc.blocks.slice(idx + 1)];
    await saveHomeDoc(shopId, restackedDoc(doc, blocks));
    throw new CalderynError({
      code: "sections_split",
      status: 409,
      message: "That block held several sections, so they are now listed separately. Pick the one to redo.",
    });
  }
  const replacement = await regenerateHomeSection(shopId, inner, instruction);
  if (!replacement) {
    throw new CalderynError({
      code: "section_regen_failed",
      status: 502,
      message: "The design engine could not redo that section right now. Try again in a moment.",
    });
  }
  // The model call took seconds; the draft may have changed under it (second tab, a full
  // rebuild landing). Re-read and verify the target is untouched — applying onto a stale
  // doc would silently discard the newer draft.
  const freshDoc = await loadHomeDocForEdit(shopId);
  const freshBlock = freshDoc.blocks.find((b) => b.id === blockId);
  if (!freshBlock || freshBlock.props.html !== originalHtml) {
    throw new CalderynError({
      code: "section_changed",
      status: 409,
      message: "The page changed while redoing that section. Check the preview and try again.",
    });
  }
  const blocks = freshDoc.blocks.map((b) =>
    b.id === blockId ? { ...b, props: { ...b.props, html: `${AI_WRAP_OPEN}${style}${replacement}</div>` } } : b,
  );
  return saveHomeDoc(shopId, { ...freshDoc, blocks });
}

/** Live catalog ids/handles, for validateDocument before any draft write. */
async function catalogValidIds(shopId: string): Promise<ValidIds> {
  const catalog = getCatalog();
  const [products, collections] = await Promise.all([
    catalog.listProducts(shopId),
    catalog.listCollections(shopId),
  ]);
  return {
    productIds: new Set(products.map((p) => p.id)),
    collectionHandles: new Set(collections.map((c) => c.handle)),
  };
}

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

/** Whether the designer engine (Labs) has built this shop's document set.
 *  Fail-soft: a missing flag only re-shows the first-build mode choice. */
async function designerDocumentsReady(shopId: string): Promise<boolean> {
  if (!UUID_RE.test(shopId)) return false;
  const { data, error } = await getSupabase()
    .from("designer_documents")
    .select("route")
    .eq("shop_id", shopId)
    .limit(1);
  if (error) {
    console.error("[studio] designer documents lookup failed", { shopId, error: error.message });
    return false;
  }
  return (data ?? []).length > 0;
}

export async function loadStudioState(shopId: string): Promise<StudioState> {
  const catalog = getCatalog();
  const [settings, draft, published, products, generation, canCharge, draftCount, orgSlug, experiment, release, policies, designerReady] =
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
      designerDocumentsReady(shopId),
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
      composerEnabled: settings.composerEnabled,
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
    designerReady,
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

/** Update the home hero block's text on the draft doc (creating the draft from
 *  the default home doc when none exists), validate, and save. */
export async function saveStudioHero(shopId: string, hero: StudioHero): Promise<StudioHero> {
  await refuseMidTest(shopId, "hero copy");
  const doc = (await loadDraftDoc(shopId, "home")) ?? defaultHomeDocument();
  const heroBlock = doc.blocks.find((b) => b.type === "hero");
  if (!heroBlock) {
    throw new CalderynError({
      code: "no_hero_block",
      status: 422,
      message: "The home page draft has no hero section to edit.",
    });
  }
  const next: BlockDocument = {
    ...doc,
    blocks: doc.blocks.map((b) =>
      b === heroBlock
        ? { ...b, props: { ...b.props, headline: hero.headline, subhead: hero.subhead } }
        : b,
    ),
  };
  const valid = await catalogValidIds(shopId);
  const { doc: clean } = validateDocument(next, valid);
  const saved = heroFromDoc(clean);
  if (!saved) {
    // The hero block failed props validation and was dropped — surface it
    // rather than silently persisting a doc without the edit.
    throw new CalderynError({
      code: "invalid_hero",
      status: 422,
      message: "The hero copy failed validation and was not saved.",
    });
  }
  await saveDraft(shopId, "home", clean);
  return saved;
}

/** Set the palette's primary/accent color, preserving the other palette keys
 *  and the rest of the store settings. Color format is validated at the route
 *  boundary. */
export async function saveStudioAccent(shopId: string, color: string): Promise<void> {
  await refuseMidTest(shopId, "accent color");
  const settings = await getStoreSettings(shopId);
  await saveStoreSettings(shopId, {
    storeName: settings.storeName,
    palette: { ...DEFAULT_PALETTE, ...settings.palette, primary: color },
    logoUrl: settings.logoUrl,
    voiceTagline: settings.voiceTagline,
  });
}

/** Persist the storefront design vibe through the StoreSettings contract
 *  (settings.server.ts owns the store_settings row shape; the save seeds the
 *  row for shops that have never saved settings and re-saves the other brand
 *  fields as currently stored). Vibe value is validated at the route boundary. */
export async function saveStudioVibe(shopId: string, vibe: StudioVibe): Promise<void> {
  if (!UUID_RE.test(shopId)) {
    throw new CalderynError({
      code: "demo_shop",
      status: 422,
      message: "This demo store can't change its design vibe.",
    });
  }
  await refuseMidTest(shopId, "design vibe");
  const settings = await getStoreSettings(shopId);
  await saveStoreSettings(shopId, {
    storeName: settings.storeName,
    palette: settings.palette,
    logoUrl: settings.logoUrl,
    voiceTagline: settings.voiceTagline,
    vibe,
  });
}

/** Publish every drafted page in the publishable set (home/collection/pdp),
 *  validating each draft first (page-document.server.ts caller obligation).
 *  Once the tenant domain is ready, an empty draft set seeds and publishes the
 *  default home doc so the storefront never goes live blank. */
export async function publishStudioStore(shopId: string, actorId?: string | null): Promise<string> {
  // Demo/fixture shops can't persist page documents (saveDraft throws a raw
  // Error for non-uuid ids) — refuse cleanly instead of 500ing.
  if (!UUID_RE.test(shopId)) {
    throw new CalderynError({
      code: "demo_shop",
      status: 422,
      message: "This demo store can't publish changes.",
    });
  }
  // Publishing mid-test would change arm A under the running experiment, and
  // a later "ship" would overwrite the newer published home (and draft) with
  // the challenger clone frozen at start time — refuse until it is decided.
  await expireOverdueExperiment(shopId);
  if (await hasRunningExperiment(shopId)) {
    throw new CalderynError({
      code: "experiment_running",
      status: 409,
      message: "An experiment is running on your store. Decide it before publishing.",
    });
  }
  const storefrontUrl = await requirePublishableTenantDomain(shopId);
  const release = await readStorefrontReleaseState(shopId);
  if (release.draftRuntimeVersion === 1 && release.draftVersionId) {
    if (!isStorefrontBundlePublishEnabled()) {
      throw new CalderynError({
        code: "storefront_bundle_publish_disabled",
        status: 503,
        message: "Publishing the new storefront runtime is temporarily disabled. Your draft is unchanged.",
      });
    }
    await publishStorefrontRelease({
      shopId,
      expectedDraftVersionId: release.draftVersionId,
      expectedPublishedVersionId: release.publishedVersionId,
      actorId: actorId ?? null,
    });
    return storefrontUrl;
  }
  if (release.draftRuntimeVersion !== null && release.draftRuntimeVersion !== 0) {
    throw new CalderynError({
      code: "unsupported_storefront_runtime",
      status: 503,
      message: "This storefront draft needs a newer publisher. Your live store is unchanged.",
    });
  }
  const valid = await catalogValidIds(shopId);
  const publishPage = async (pageKey: PageKey, doc: BlockDocument) => {
    const { doc: clean, missingFunctional } = validateDocument(doc, valid);
    // A published PDP can never lack the buy path (validateDocument reports
    // missingFunctional but does not enforce it).
    if (missingFunctional.length > 0) injectMissingFunctionalBlocks(clean, pageKey);
    await saveDraft(shopId, pageKey, clean);
    await publishDoc(shopId, pageKey);
  };
  let publishedAny = false;
  for (const pageKey of PUBLISHABLE_PAGES) {
    const draft = await loadDraftDoc(shopId, pageKey);
    if (!draft) continue;
    await publishPage(pageKey, draft);
    publishedAny = true;
  }
  if (!publishedAny) await publishPage("home", defaultHomeDocument());
  return storefrontUrl;
}
