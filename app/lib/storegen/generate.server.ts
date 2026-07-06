// app/lib/storegen/generate.server.ts
// The store generator orchestrator. Deterministic control flow (rule 5): Stage 1 = brand
// (one Haiku call → store_settings), Stage 2 = one Haiku call per doc kind, each independently
// parsed → assembled/validated → or fall back. Never publishes (drafts only). Per-run token
// budget (rule 6); every fallback/drop recorded (rule 12).
import { getAnthropic, digestModel } from "~/lib/assistant/anthropic.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { saveDraft } from "~/lib/storebuilder/page-document.server";
import { getStoreSettings, saveStoreSettings, hasStoreSettings } from "~/lib/storefront/settings.server";
import type { BlockDocument, DocKind, PageKey } from "~/lib/storebuilder/types";
import type { ValidIds } from "~/lib/storebuilder/validate";
import { parseBlockPlan, parseBrandPlan, type BrandPlan } from "./block-plan";
import { BRAND_SYSTEM_PROMPT, buildBrandUserMessage, docSystemPrompt, buildDocUserMessage, HOME_HTML_SYSTEM_PROMPT, buildHomeHtmlUserMessage, type CatalogMenu } from "./prompts";
import { sanitizeStoreHtml } from "~/lib/storebuilder/sanitize-html.server";
import { normalizeStorefrontHref, type StorefrontLinkSet } from "~/lib/storefront/links";
import { assembleDocument } from "./sanitize";
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
const PAGES: { pageKey: PageKey; kind: DocKind }[] = [
  { pageKey: "home", kind: "singleton" },
  { pageKey: "collection", kind: "template" },
  { pageKey: "pdp", kind: "template" },
];

export interface GenerateInput { shopId: string; mode: "brief" | "catalog"; brief?: string }
export type GenerateStatus = "draft" | "no_products" | "failed";
export interface GenerateResult { runId: string; status: GenerateStatus; tokenCost: number; docs: Record<string, BlockDocument> }

function textOf(msg: { content: { type: string; text?: string }[] }): string {
  return msg.content.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("").trim();
}

export async function generateStore(input: GenerateInput): Promise<GenerateResult> {
  const runId = crypto.randomUUID();
  const model = storegenModel();
  const catalog = getCatalog();
  const products = await catalog.listProducts(input.shopId);
  const collections = await catalog.listCollections(input.shopId);
  const menu: CatalogMenu = {
    products: products.map((p) => ({ id: p.id, handle: p.handle, title: p.title })),
    collections: collections.map((c) => ({ handle: c.handle, title: c.title })),
  };
  const valid: ValidIds = { productIds: new Set(products.map((p) => p.id)), collectionHandles: new Set(collections.map((c) => c.handle)) };
  // Real handles behind every storefront deep-link, so a hallucinated collection/product href is
  // rewritten to the shop home instead of 404-ing (rule 12: never ship a dead link).
  const linkSet: StorefrontLinkSet = { productHandles: new Set(products.map((p) => p.handle)), collectionHandles: new Set(collections.map((c) => c.handle)) };
  let tokenCost = 0;
  let budgetHit = false;
  // Distinguish "the model was never called" (skipLlm / budget) from "the model
  // was called and every call failed" (out of credits, API down). Only the
  // latter is a degraded run the merchant must be told about (rule 12) — a call
  // that merely returns junk still counts as a success (parsing handles it).
  let llmAttempts = 0;
  let llmOk = 0;
  // An empty catalog with no brief gives the model nothing to work with — the
  // result would match the deterministic fallback anyway, so skip the paid
  // calls entirely (this is also the auto-build path for brand-new shops).
  const skipLlm = products.length === 0 && collections.length === 0 && !input.brief;
  const client = getAnthropic();

  async function call(system: string, user: string, opts?: { model?: string; maxTokens?: number }): Promise<string | null> {
    if (skipLlm) return null;
    if (budgetHit || tokenCost >= TOKEN_BUDGET) { budgetHit = true; return null; }
    llmAttempts += 1;
    try {
      const msg = await client.messages.create({ model: opts?.model ?? model, max_tokens: opts?.maxTokens ?? 1500, system, messages: [{ role: "user", content: user }] });
      const u = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      tokenCost += (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0);
      if (tokenCost >= TOKEN_BUDGET) budgetHit = true;
      llmOk += 1;
      return textOf(msg);
    } catch (err) {
      console.error("[storegen] Claude call failed; using deterministic fallback", err);
      return null; // API/timeout → caller uses the deterministic fallback
    }
  }

  // Stage 1 — brand. The brief (when present) drives the store's identity here, not just the
  // per-doc copy below — otherwise a free-text prompt could only ever change page text.
  const brandText = await call(BRAND_SYSTEM_PROMPT, buildBrandUserMessage(menu, input.mode === "brief" ? input.brief : undefined));
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
      const raw = await call(HOME_HTML_SYSTEM_PROMPT, buildHomeHtmlUserMessage(brandPlan, briefArg, menu), { model: storegenHtmlModel(), maxTokens: 8000 });
      // Strip an accidental ```html fence, then require real markup: a reply with no tags (junk,
      // refusal, JSON) is a miss → fall back to the designed hollow store rather than render text.
      const stripped = raw ? raw.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim() : "";
      const clean = /<[a-z]/i.test(stripped) ? sanitizeStoreHtml(stripped, { links: linkSet }) : "";
      const doc: BlockDocument = clean
        ? { kind: "singleton", pageKey: "home", blocks: [{ id: "home-html", type: "rawHtml", layout: { x: 0, y: 0, w: 12, h: 12 }, props: { html: clean } }] }
        : fallbackDoc(pageKey, fbBrand, fallbackContext);
      return { pageKey, doc, proposal: clean ? { rawHtml: true } : { fallback: true } };
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

  const built = await Promise.all(PAGES.map(({ pageKey, kind }) => buildPage(pageKey, kind)));
  for (const { pageKey, doc, proposal } of built) {
    docs[pageKey] = doc;
    proposals[pageKey] = proposal;
  }
  // Persist concurrently — distinct draft keys, home first in PAGES so it lands earliest.
  await Promise.all(built.map(({ pageKey, doc }) => saveDraft(input.shopId, pageKey, doc)));

  // The AI was reached but produced nothing (every call errored) → the docs
  // above are all deterministic fallbacks that ignore the brief. Surface that as
  // a failed run so the studio can tell the merchant instead of passing a
  // generic layout off as their design (rule 12).
  const degraded = llmAttempts > 0 && llmOk === 0;
  const status: GenerateStatus = degraded ? "failed" : products.length === 0 ? "no_products" : "draft";
  await recordProposal(input.shopId, runId, proposals);
  await recordGeneration({ shopId: input.shopId, runId, source: input.mode, briefText: input.brief ?? null, model, status, tokenCost });
  return { runId, status, tokenCost, docs };
}
