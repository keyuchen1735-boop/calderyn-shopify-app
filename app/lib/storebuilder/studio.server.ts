// app/lib/storebuilder/studio.server.ts
// Read/update model for the Store studio surface, composed over the existing
// storebuilder/storegen/storefront libs. Server-only: reaches page_document,
// store_settings and store_generation through the service-role client the
// underlying libs already use.
import { getSupabase } from "~/lib/supabase.server";
import { tenantDomain } from "~/lib/storefront/vercel-domain.server";
import { CalderynError } from "~/lib/calderyn.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings, saveStoreSettings, DEFAULT_PALETTE } from "~/lib/storefront/settings.server";
import { getConnectedAccount } from "~/lib/payments/connect.server";
import { listProducts as listAdminProducts } from "~/lib/catalog/catalog.server";
import { hasRunningExperiment, latestStudioExperiment } from "~/lib/experiments/store-experiment.server";
import { injectMissingFunctionalBlocks } from "~/lib/storegen/sanitize";
import { loadDraftDoc, loadPublishedDoc, saveDraft, publishDoc } from "./page-document.server";
import { defaultHomeDocument } from "./default-doc";
import { validateDocument, type ValidIds } from "./validate";
import type { BlockDocument, PageKey } from "./types";
import type {
  StudioGeneration,
  StudioGenerationStatus,
  StudioHero,
  StudioProduct,
  StudioState,
  StudioVibe,
} from "./studio-types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The page keys the generator drafts — the studio's publishable set. */
const PUBLISHABLE_PAGES: PageKey[] = ["home", "collection", "pdp"];

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** Extract the hero block's real text fields from a doc; null when absent. */
function heroFromDoc(doc: BlockDocument): StudioHero | null {
  const block = doc.blocks.find((b) => b.type === "hero");
  if (!block) return null;
  return {
    headline: str(block.props.headline, "Welcome"),
    subhead: str(block.props.subhead, "Shop our latest"),
  };
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

/** Whether payments are fully set up — same three-flag definition the Payments
 *  screen uses (charges + payouts + details). Advisory only (the publish warn
 *  panel), so a payments read error reports not-ready rather than failing the
 *  whole studio load. Demo (non-uuid) shops have no row and read as not ready. */
async function checkoutReady(shopId: string): Promise<boolean> {
  if (!UUID_RE.test(shopId)) return false;
  try {
    const account = await getConnectedAccount(shopId);
    return (
      account?.charges_enabled === true &&
      account.payouts_enabled === true &&
      account.details_submitted === true
    );
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
  const [settings, draft, published, products, generation, canCharge, draftCount, orgSlug, experiment] =
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
    hasDraft: draft != null,
    hasPublished: published != null,
    generation,
    orgSlug,
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
 *  Publishing is never gated: with nothing drafted, the default home doc is
 *  seeded as the draft and published, so the storefront always goes live. */
export async function publishStudioStore(shopId: string): Promise<void> {
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
  if (await hasRunningExperiment(shopId)) {
    throw new CalderynError({
      code: "experiment_running",
      status: 409,
      message: "An experiment is running on your home page. Decide it before publishing.",
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
}
