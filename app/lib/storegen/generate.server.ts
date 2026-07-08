// app/lib/storegen/generate.server.ts
// The store generator orchestrator. Deterministic control flow (rule 5): Stage 1 = brand
// (one Haiku call → store_settings), Stage 2 = one Haiku call per doc kind, each independently
// parsed → assembled/validated → or fall back. Never publishes (drafts only). Per-run token
// budget (rule 6); every fallback/drop recorded (rule 12).
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropic, digestModel } from "~/lib/assistant/anthropic.server";
import { toBase64ImageBlock, type AttachmentImage } from "./attachment-intent.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { saveDraft } from "~/lib/storebuilder/page-document.server";
import { getStoreSettings, saveStoreSettings, hasStoreSettings } from "~/lib/storefront/settings.server";
import type { BlockDocument, DocKind, PageKey } from "~/lib/storebuilder/types";
import type { StudioDesignModel } from "~/lib/storebuilder/studio-types";
import type { ValidIds } from "~/lib/storebuilder/validate";
import { parseBlockPlan, parseBrandPlan, type BrandPlan } from "./block-plan";
import { BRAND_SYSTEM_PROMPT, buildBrandUserMessage, docSystemPrompt, buildDocUserMessage, HOME_HTML_SYSTEM_PROMPT, buildHomeHtmlUserMessage, SEED_SYSTEM_PROMPT, buildSeedUserMessage, type CatalogMenu } from "./prompts";
import { parseSeedPlan, FALLBACK_SEED } from "./seed";
import { seedSampleCatalog, type SeedOutcome } from "./seed.server";
import { sanitizeStoreHtml } from "~/lib/storebuilder/sanitize-html.server";
import { normalizeStorefrontHref, type StorefrontLinkSet } from "~/lib/storefront/links";
import { assembleDocument } from "./sanitize";
import { spliceCatalogBlocks } from "./hybrid";
import { verifyGeneratedDocs, type VerificationReport } from "./verify";
import { fallbackDoc, type FallbackContext } from "./fallback";
import { recordGeneration, recordProposal } from "./audit.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_BUDGET = Number(process.env.STOREGEN_TOKEN_BUDGET ?? 20000);

/** Model seam for the generator, independent of the shared digest crons: override with
 *  STOREGEN_MODEL without moving the digest crons (github/social summaries) off their own model. */
function storegenModel(): string {
  return process.env.STOREGEN_MODEL || digestModel();
}
/** The home page is generated as a full HTML page (not a block plan); that benefits from a stronger
 *  design model than the digest/Haiku default. Override with STOREGEN_HTML_MODEL. */
function storegenHtmlModel(): string {
  return process.env.STOREGEN_HTML_MODEL || "claude-sonnet-5";
}
/** Concrete model ids behind the merchant's design-model picker. Keyed, not free-form:
 *  the request can only ever select from this allowlist. */
const DESIGN_MODEL_IDS: Record<StudioDesignModel, string> = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-8",
};
const PAGES: { pageKey: PageKey; kind: DocKind }[] = [
  { pageKey: "home", kind: "singleton" },
  { pageKey: "collection", kind: "template" },
  { pageKey: "pdp", kind: "template" },
];

export interface GenerateInput {
  shopId: string;
  mode: "brief" | "catalog";
  brief?: string;
  /** Merchant's design-model choice for the home HTML call; defaults to storegenHtmlModel().
   *  Brand + block-plan calls stay on the cheap model regardless. */
  designModel?: StudioDesignModel;
  /** Untrusted merchant-attached STYLE references. Attached as image blocks to the brand
   *  (stage 1) and home-HTML calls only — palette/mood/type direction, never embedded; the
   *  block-plan collection/pdp calls stay text-only. */
  referenceImages?: AttachmentImage[];
  /** Real build-stage callback for live progress UI. Fires at actual boundaries
   *  (never simulated): brand call → page design calls → pre-save verification. */
  onStage?: (stage: BuildStage) => void;
}
export type BuildStage = "seeding" | "brand" | "designing" | "checking";
export type GenerateStatus = "draft" | "no_products" | "failed";
export interface GenerateResult {
  runId: string;
  status: GenerateStatus;
  tokenCost: number;
  docs: Record<string, BlockDocument>;
  /** Best-effort attribution (only ever set when referenceImages were provided):
   *  every vision-bearing call (brand + home) errored while at least one
   *  text-only call succeeded — the produced design never saw the references.
   *  Absent on an all-calls-failed run (status "failed" is the stronger signal). */
  referencesUnread?: true;
  /** Pre-save verification results (links re-checked, dead fx stripped). */
  verification?: VerificationReport;
}

function textOf(msg: { content: { type: string; text?: string }[] }): string {
  return msg.content.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("").trim();
}

export async function generateStore(input: GenerateInput): Promise<GenerateResult> {
  const runId = crypto.randomUUID();
  const model = storegenModel();
  const catalog = getCatalog();
  let tokenCost = 0;
  let budgetHit = false;
  // Distinguish "the model was never called" (budget) from "the model
  // was called and every call failed" (out of credits, API down). Only the
  // latter is a degraded run the merchant must be told about (rule 12) — a call
  // that merely returns junk still counts as a success (parsing handles it).
  let llmAttempts = 0;
  let llmOk = 0;
  // Vision-bearing calls (the two that carry reference image blocks) tracked
  // separately: when they all error but a text-only call succeeds, the design
  // was produced WITHOUT ever seeing the references — surfaced as
  // referencesUnread so the studio can tell the merchant (rule 12).
  let visionAttempts = 0;
  let visionOk = 0;
  // Style-reference image blocks the brand + home calls attach (see call()).
  // Built once here (a bad media type is dropped) so both calls share them and
  // the base64 is encoded a single time upstream.
  const refImageBlocks: Anthropic.ImageBlockParam[] = [];
  for (const img of input.referenceImages ?? []) {
    const block = toBase64ImageBlock(img);
    if (block) refImageBlocks.push(block);
  }
  const hasReferences = refImageBlocks.length > 0;
  const client = getAnthropic();

  async function call(system: string, user: string, opts?: { model?: string; maxTokens?: number; images?: Anthropic.ImageBlockParam[] }): Promise<string | null> {
    if (budgetHit || tokenCost >= TOKEN_BUDGET) { budgetHit = true; return null; }
    llmAttempts += 1;
    const isVision = !!(opts?.images && opts.images.length > 0);
    if (isVision) visionAttempts += 1;
    try {
      // Text-only stays a plain string (byte-identical to before); when images
      // are attached the content becomes a text block + the image blocks.
      const content: Anthropic.MessageParam["content"] = isVision && opts?.images
        ? [{ type: "text", text: user }, ...opts.images]
        : user;
      const msg = await client.messages.create({ model: opts?.model ?? model, max_tokens: opts?.maxTokens ?? 1500, system, messages: [{ role: "user", content }] });
      const u = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      tokenCost += (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0);
      if (tokenCost >= TOKEN_BUDGET) budgetHit = true;
      llmOk += 1;
      if (isVision) visionOk += 1;
      return textOf(msg);
    } catch (err) {
      console.error("[storegen] Claude call failed; using deterministic fallback", err);
      return null; // API/timeout → caller uses the deterministic fallback
    }
  }

  let products = await catalog.listProducts(input.shopId);
  let collections = await catalog.listCollections(input.shopId);
  // Replit-style seed (design §3.1): an empty shop gets a model-invented demo catalog written
  // through the real catalog path BEFORE anything else, so every later stage — link set, menu,
  // grids, PDPs — works against real handles. UUID-gated: the fixture/stub catalogs (non-uuid
  // shops) cannot take writes.
  let seedOutcome: SeedOutcome | null = null;
  if (products.length === 0 && collections.length === 0 && UUID_RE.test(input.shopId)) {
    input.onStage?.("seeding");
    // Text-only on purpose: reference images are pinned to the brand + home-HTML calls (see
    // GenerateInput.referenceImages), and keeping the seed call out of the vision counters
    // preserves referencesUnread's meaning (design calls only).
    const seedText = await call(SEED_SYSTEM_PROMPT, buildSeedUserMessage(input.mode === "brief" ? input.brief : undefined), { maxTokens: 2500 });
    const plan = (seedText && parseSeedPlan(seedText)) || FALLBACK_SEED;
    try {
      seedOutcome = await seedSampleCatalog(input.shopId, plan);
      products = await catalog.listProducts(input.shopId);
      collections = await catalog.listCollections(input.shopId);
    } catch (err) {
      // A collection write failing mid-seed must degrade to the old unseeded behavior, not fail
      // the whole generation — the run proceeds catalog-less and the outcome is recorded below
      // (rule 12: surfaced in proposals, never hidden).
      console.error("[storegen] seed catalog write failed; continuing unseeded", err);
      seedOutcome = { collections: 0, products: 0, failed: plan.products.length };
    }
  }
  // Degradation is a DESIGN-quality signal: measure only the brand/page calls, excluding the
  // seed call above, so a run whose seed succeeded but whose every design call failed is still
  // reported as failed (rule 12), not passed off as a draft.
  const designAttemptsBase = llmAttempts;
  const designOkBase = llmOk;
  const menu: CatalogMenu = {
    products: products.map((p) => ({ id: p.id, handle: p.handle, title: p.title })),
    collections: collections.map((c) => ({ handle: c.handle, title: c.title })),
  };
  const valid: ValidIds = { productIds: new Set(products.map((p) => p.id)), collectionHandles: new Set(collections.map((c) => c.handle)) };
  // Real catalog numbers for the home prompt: copy grounded on these can be concrete
  // ("Explore 21 certified devices") without the model inventing figures.
  const byCollection: Record<string, number> = {};
  for (const p of products) for (const h of p.collections) byCollection[h] = (byCollection[h] ?? 0) + 1;
  const counts = { products: products.length, byCollection };
  // Real handles behind every storefront deep-link, so a hallucinated collection/product href is
  // rewritten to the shop home instead of 404-ing (rule 12: never ship a dead link).
  const linkSet: StorefrontLinkSet = { productHandles: new Set(products.map((p) => p.handle)), collectionHandles: new Set(collections.map((c) => c.handle)) };

  // Stage 1 — brand. The brief (when present) drives the store's identity here, not just the
  // per-doc copy below — otherwise a free-text prompt could only ever change page text.
  input.onStage?.("brand");
  const brandText = await call(BRAND_SYSTEM_PROMPT, buildBrandUserMessage(menu, input.mode === "brief" ? input.brief : undefined, hasReferences), { images: refImageBlocks });
  let brand: BrandPlan | null = (brandText && parseBrandPlan(brandText)) || null;
  if (!brand) {
    // Model unreachable or junk: brand from what the shop already has (its
    // settings row, else shops.display_name via getStoreSettings) — a store
    // named by its owner must never regress to a placeholder.
    const existing = await getStoreSettings(input.shopId);
    brand = {
      storeName: existing.storeName || "My Store",
      palette: existing.palette,
      voiceTagline: existing.voiceTagline ?? "",
      vibe: existing.vibe ?? "minimal",
      typeStyle: existing.typeStyle ?? "classic",
      density: existing.density ?? "standard",
    };
  }
  if (UUID_RE.test(input.shopId)) {
    // The merchant owns their vibe once it's set, so an auto/catalog rebuild never stomps it —
    // but an explicit free-text brief is a deliberate restyle request ("make it bolder"), so it
    // may re-set the vibe even on a rebuild. First-ever branding always sets it.
    const explicitBrief = input.mode === "brief" && !!input.brief?.trim();
    const firstBrand = !(await hasStoreSettings(input.shopId));
    await saveStoreSettings(input.shopId, {
      storeName: brand.storeName, palette: brand.palette, logoUrl: null, voiceTagline: brand.voiceTagline,
      ...(firstBrand || explicitBrief ? { vibe: brand.vibe, typeStyle: brand.typeStyle, density: brand.density } : {}),
    });
  }

  // Real catalog nouns the deterministic fallback templates copy from — same snapshot as the
  // model prompts, so the fallback path (today's path: the API key is at its limit) still reads
  // designed instead of generic when every call errors.
  const fallbackContext: FallbackContext = {
    products: products.map((p) => ({ title: p.title, imageUrl: p.images[0]?.url })),
    collections: collections.map((c) => ({ handle: c.handle, title: c.title })),
    vibe: brand.vibe,
  };
  // Stage 2 — the three pages are independent, so build them CONCURRENTLY. The HOME page (a full
  // self-contained HTML page from the stronger model) is the long pole; running collection/pdp
  // alongside it collapses wall-clock from the sum of all three to ~the home call alone, which is
  // what the merchant actually waits on before the preview paints. Each page still parses, validates
  // and falls back in isolation (rule 12); rawHtml is sanitized here and again at saveDraft (the
  // security boundary). Draft rows use distinct keys, so the concurrent saveDraft calls never contend.
  const docs: Record<string, BlockDocument> = {};
  const proposals: Record<string, unknown> = {};
  const fbBrand = { storeName: brand.storeName, tagline: brand.voiceTagline };
  const briefArg = input.mode === "brief" ? input.brief : undefined;
  // `brand` is non-null from here; capture it as a const so the concurrent buildPage closures
  // below keep the narrowing (a captured `let` reverts to BrandPlan | null inside a closure).
  const brandPlan: BrandPlan = brand;

  async function buildPage(pageKey: PageKey, kind: DocKind): Promise<{ pageKey: PageKey; doc: BlockDocument; proposal: unknown }> {
    if (pageKey === "home") {
      const raw = await call(HOME_HTML_SYSTEM_PROMPT, buildHomeHtmlUserMessage(brandPlan, briefArg, menu, hasReferences, counts), {
        model: input.designModel ? DESIGN_MODEL_IDS[input.designModel] : storegenHtmlModel(),
        // 12000, not 8000: with the fx channels in the prompt, Sonnet's full home
        // pages regularly ran to exactly 8000 and truncated mid-section (verified
        // against live generations); Opus finishes near 4000 either way.
        maxTokens: 12000,
        images: refImageBlocks,
      });
      // Strip an accidental ```html fence, then require real markup: a reply with no tags (junk,
      // refusal, JSON) is a miss → fall back to the designed hollow store rather than render text.
      const stripped = raw ? raw.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim() : "";
      const clean = /<[a-z]/i.test(stripped) ? sanitizeStoreHtml(stripped, { links: linkSet }) : "";
      // Splice catalog markers into REAL productGrid/collectionList blocks — live
      // photos, prices and add-to-cart from the storefront renderer, so the home
      // has genuine commerce substance, not a typographic poster alone.
      const blocks = clean ? spliceCatalogBlocks(clean, valid) : [];
      const doc: BlockDocument = blocks.length > 0 ? { kind: "singleton", pageKey: "home", blocks } : fallbackDoc(pageKey, fbBrand, fallbackContext);
      return {
        pageKey,
        doc,
        proposal: blocks.length > 0 ? { rawHtml: true, catalogBlocks: blocks.filter((b) => b.type !== "rawHtml").length } : { fallback: true },
      };
    }
    const text = await call(docSystemPrompt(pageKey), buildDocUserMessage(pageKey, { brand: brandPlan, brief: briefArg, menu }));
    const plan = text ? parseBlockPlan(text) : null;
    // Rewrite any block link (e.g. a button href) to a guaranteed-live target before assembly.
    if (plan) for (const b of plan.blocks) {
      if (typeof b.props.href === "string") b.props.href = normalizeStorefrontHref(b.props.href, linkSet);
    }
    try {
      const assembled = plan ? assembleDocument(pageKey, kind, plan, valid) : null;
      // A plan that validates down to nothing is a failure → fall back.
      const doc = assembled && assembled.doc.blocks.length > 0 ? assembled.doc : fallbackDoc(pageKey, fbBrand, fallbackContext);
      return { pageKey, doc, proposal: plan ?? { fallback: true } };
    } catch (err) {
      console.error(`[storegen] assemble failed for ${pageKey}; using fallback`, err);
      return { pageKey, doc: fallbackDoc(pageKey, fbBrand, fallbackContext), proposal: { fallback: true } };
    }
  }

  input.onStage?.("designing");
  const built = await Promise.all(PAGES.map(({ pageKey, kind }) => buildPage(pageKey, kind)));
  for (const { pageKey, doc, proposal } of built) {
    docs[pageKey] = doc;
    proposals[pageKey] = proposal;
  }
  // Pre-present verification (rule 12): re-check every link against the live
  // catalog and strip fx specs the runtime would reject — the merchant is only
  // ever shown drafts that passed, and the report is recorded, not discarded.
  input.onStage?.("checking");
  const { docs: verifiedDocs, report: verification } = verifyGeneratedDocs(docs, linkSet);
  for (const key of Object.keys(docs)) docs[key] = verifiedDocs[key];
  proposals.verification = verification;
  // Persist concurrently — distinct draft keys, home first in PAGES so it lands earliest.
  await Promise.all(built.map(({ pageKey }) => saveDraft(input.shopId, pageKey, docs[pageKey])));

  // The AI was reached but produced nothing (every call errored) → the docs
  // above are all deterministic fallbacks that ignore the brief. Surface that as
  // a failed run so the studio can tell the merchant instead of passing a
  // generic layout off as their design (rule 12).
  const degraded = (llmAttempts - designAttemptsBase) > 0 && (llmOk - designOkBase) === 0;
  const status: GenerateStatus = degraded ? "failed" : products.length === 0 ? "no_products" : "draft";
  // Best-effort attribution: references were attached and every call carrying
  // them errored while a text-only call succeeded — the run "worked" but the
  // design never saw the references. Not set on an all-failed run (status
  // "failed" already tells the merchant the AI was unreachable).
  const referencesUnread = hasReferences && visionAttempts > 0 && visionOk === 0 && llmOk > 0;
  if (seedOutcome) proposals.seed = seedOutcome;
  await recordProposal(input.shopId, runId, proposals);
  await recordGeneration({ shopId: input.shopId, runId, source: input.mode, briefText: input.brief ?? null, model, status, tokenCost });
  return { runId, status, tokenCost, docs, verification, ...(referencesUnread ? { referencesUnread: true as const } : {}) };
}
