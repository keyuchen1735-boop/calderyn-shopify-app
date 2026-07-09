// app/lib/storegen/generate.server.ts
// The store generator orchestrator. Deterministic control flow (rule 5): Stage 1 = brand
// (one Haiku call → store_settings), Stage 2 = one Haiku call per doc kind, each independently
// parsed → assembled/validated → or fall back. Never publishes (drafts only). Per-run token
// budget (rule 6); every fallback/drop recorded (rule 12).
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropic } from "~/lib/assistant/anthropic.server";
import { toBase64ImageBlock, type AttachmentImage } from "./attachment-intent.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { saveDraft } from "~/lib/storebuilder/page-document.server";
import { getStoreSettings, saveStoreSettings, hasStoreSettings } from "~/lib/storefront/settings.server";
import type { BlockDocument, DocKind, PageKey } from "~/lib/storebuilder/types";
import type { StudioDesignModel } from "~/lib/storebuilder/studio-types";
import type { ValidIds } from "~/lib/storebuilder/validate";
import { parseBlockPlan, parseBrandPlan, type BrandPlan } from "./block-plan";
import { BRAND_SYSTEM_PROMPT, buildBrandUserMessage, docSystemPrompt, buildDocUserMessage, HOME_HTML_SYSTEM_PROMPT, buildHomeHtmlUserMessage, HOME_JUDGE_SYSTEM_PROMPT, buildHomeJudgeUserMessage, candidateAngleNudge, homeRevisionSuffix, SECTION_SYSTEM_PROMPT, buildSectionUserMessage, type CatalogMenu } from "./prompts";
import { sanitizeStoreHtml } from "~/lib/storebuilder/sanitize-html.server";
import { normalizeStorefrontHref, type StorefrontLinkSet } from "~/lib/storefront/links";
import { assembleDocument } from "./sanitize";
import { spliceCatalogBlocks } from "./hybrid";
import { verifyGeneratedDocs, type VerificationReport } from "./verify";
import { fallbackDoc, type FallbackContext } from "./fallback";
import { recordGeneration, recordProposal } from "./audit.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 90k: the budget counts INPUT tokens too, and a full quality run is brand + block plans +
// N home candidates + a judge + possibly one revision. Generation volume is already bounded
// by the burst limit + daily designer quota, so the budget is a per-run runaway safety net,
// not the cost cap — starving pages into silent fallbacks is worse than the marginal spend.
const TOKEN_BUDGET = Number(process.env.STOREGEN_TOKEN_BUDGET ?? 90000);
// Concurrent home candidates per run (1 disables the judge/critique pipeline entirely —
// the cost lever). Clamped 1..2: the judge contract compares exactly two candidates, so a
// third would be paid for and then unconditionally discarded.
function homeCandidateCount(): number {
  const n = Number(process.env.STOREGEN_HOME_CANDIDATES ?? 2);
  return Number.isFinite(n) ? Math.min(2, Math.max(1, Math.round(n))) : 2;
}
// A judged winner scoring below this gets one critique-driven revision pass.
const REVISE_BELOW_SCORE = 8;
// The catalog menu is embedded in every prompt of the run; cap it so a thousand-product shop
// can't burn the budget on menu JSON (the model needs representative nouns, not the full list).
const MENU_PRODUCT_CAP = 60;
const MENU_COLLECTION_CAP = 30;

/** Model seam for the generator (brand + collection/pdp block plans), independent of the digest
 *  crons: override with STOREGEN_MODEL. Sonnet, not the Haiku digest default — the block plans
 *  are design work, and Haiku's plans read as generic filler next to the Sonnet-designed home. */
function storegenModel(): string {
  return process.env.STOREGEN_MODEL || "claude-sonnet-5";
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
export type BuildStage = "brand" | "designing" | "checking";
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

/**
 * Pull the HTML fragment out of a model reply that may wrap it in prose or fences
 * ("Here is your page: ```html …"). Prefer a fenced block anywhere in the reply, else slice
 * from the first tag; then demand a real container (`<div` open AND close) so a refusal that
 * merely mentions a tag ("I can't render <script> content") never becomes the home page.
 */
export function extractStoreHtml(raw: string): string {
  const fenced = /```(?:html)?\s*([\s\S]*?)```/i.exec(raw);
  let s = (fenced ? fenced[1] : raw).trim();
  s = s.replace(/```\s*$/i, "").trim();
  const firstTag = s.indexOf("<");
  if (firstTag > 0) s = s.slice(firstTag);
  if (!/^<div[\s>]/i.test(s)) return "";
  // Take the BALANCED extent of the root <div>: trailing prose ("Let me know if…") is trimmed,
  // and a page whose root never closes (truncated without a max_tokens stop) is rejected whole.
  const tag = /<div\b[^>]*>|<\/div>/gi;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(s)) !== null) {
    depth += m[0][1] === "/" ? -1 : 1;
    if (depth === 0) return s.slice(0, m.index + m[0].length);
  }
  return "";
}

/** Tolerant parse of the judge's JSON verdict; null on anything off-contract. */
export function parseJudgeVerdict(raw: string): { winner: number; score: number; critique: string } | null {
  let s = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  try {
    const v = JSON.parse(s) as { winner?: unknown; score?: unknown; critique?: unknown };
    const winner = typeof v.winner === "number" && (v.winner === 1 || v.winner === 2) ? v.winner : null;
    const score = typeof v.score === "number" && Number.isFinite(v.score) ? Math.min(10, Math.max(0, v.score)) : null;
    if (winner == null || score == null) return null;
    return { winner, score, critique: typeof v.critique === "string" ? v.critique.slice(0, 400) : "" };
  } catch {
    return null;
  }
}

// One corrective retry per page: appended to the user message so the second attempt knows
// exactly what was wrong with the first. Stateless — no conversation is carried over.
const RETRY_NUDGE_HTML =
  "\n\nIMPORTANT: your previous reply was unusable (truncated, wrapped in prose, or not raw HTML). Reply with ONLY the complete HTML fragment — no prose before or after, no code fences — and keep it compact enough to finish within the token limit.";
const RETRY_NUDGE_JSON =
  "\n\nIMPORTANT: your previous reply was not the required JSON (invalid, truncated, or empty blocks). Reply with ONLY the JSON object in the exact contract shape — no prose, no markdown fences.";

/**
 * Extract exactly one balanced <section> element from a model reply (fences and prose
 * stripped) — the contract of the section-revision prompt. Null-string on anything else so
 * the caller keeps the current section rather than shipping junk.
 */
export function extractSectionHtml(raw: string): string {
  const fenced = /```(?:html)?\s*([\s\S]*?)```/i.exec(raw);
  let s = (fenced ? fenced[1] : raw).trim();
  s = s.replace(/```\s*$/i, "").trim();
  const start = s.search(/<section\b/i);
  if (start === -1) return "";
  s = s.slice(start);
  const tag = /<section\b[^>]*>|<\/section>/gi;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(s)) !== null) {
    depth += m[0][1] === "/" ? -1 : 1;
    if (depth === 0) return s.slice(0, m.index + m[0].length);
  }
  return "";
}

/**
 * Regenerate ONE section of an AI-designed home page (studio "redo this section"). Takes the
 * section's current inner HTML (the <section> element, without the .ai-store wrapper/style)
 * plus an optional merchant instruction; returns the sanitized replacement <section>, or null
 * when the model was unreachable or off-contract — the caller keeps the current section and
 * tells the merchant, never a silent no-op. Side-effect free; the studio owns persistence.
 */
export async function regenerateHomeSection(
  shopId: string,
  currentSectionHtml: string,
  instruction?: string,
): Promise<string | null> {
  const catalog = getCatalog();
  const [products, collections, settings] = await Promise.all([
    catalog.listProducts(shopId),
    catalog.listCollections(shopId),
    getStoreSettings(shopId),
  ]);
  const menu: CatalogMenu = {
    products: products.slice(0, MENU_PRODUCT_CAP).map((p) => ({ id: p.id, handle: p.handle, title: p.title })),
    collections: collections.slice(0, MENU_COLLECTION_CAP).map((c) => ({ handle: c.handle, title: c.title })),
  };
  const linkSet: StorefrontLinkSet = { productHandles: new Set(products.map((p) => p.handle)), collectionHandles: new Set(collections.map((c) => c.handle)) };
  const brand: BrandPlan = {
    storeName: settings.storeName,
    palette: settings.palette,
    voiceTagline: settings.voiceTagline ?? "",
    vibe: settings.vibe,
    typeStyle: settings.typeStyle,
    density: settings.density,
  };
  try {
    const msg = await getAnthropic().messages.create({
      model: storegenHtmlModel(),
      max_tokens: 4000,
      system: SECTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildSectionUserMessage(brand, menu, currentSectionHtml, instruction) }],
    });
    if ((msg as { stop_reason?: string | null }).stop_reason === "max_tokens") return null;
    const section = extractSectionHtml(textOf(msg));
    if (!section) return null;
    // The sanitizer expects/keeps arbitrary fragments; the caller re-wraps into the block's
    // .ai-store scope. Sanitizing the bare section here keeps the security boundary in one place.
    const clean = sanitizeStoreHtml(section, { links: linkSet });
    return clean || null;
  } catch (err) {
    console.error("[storegen] section regeneration failed", err);
    return null;
  }
}

/**
 * Generate ONE alternative home-page document for an A/B challenger (experiment kind
 * "ai_page"): same brand, same catalog, a deliberately different composition and copy angle.
 * Side-effect free — no drafts, no settings writes, no audit rows; the caller owns the
 * challenger's persistence. Returns null when the model is unreachable or produced nothing
 * usable, so the experiment start can refuse honestly instead of shipping a fake variant.
 */
export async function generateChallengerHome(shopId: string): Promise<BlockDocument | null> {
  const catalog = getCatalog();
  const [products, collections, settings] = await Promise.all([
    catalog.listProducts(shopId),
    catalog.listCollections(shopId),
    getStoreSettings(shopId),
  ]);
  const menu: CatalogMenu = {
    products: products.slice(0, MENU_PRODUCT_CAP).map((p) => ({ id: p.id, handle: p.handle, title: p.title })),
    collections: collections.slice(0, MENU_COLLECTION_CAP).map((c) => ({ handle: c.handle, title: c.title })),
  };
  const valid: ValidIds = { productIds: new Set(products.map((p) => p.id)), collectionHandles: new Set(collections.map((c) => c.handle)) };
  const linkSet: StorefrontLinkSet = { productHandles: new Set(products.map((p) => p.handle)), collectionHandles: new Set(collections.map((c) => c.handle)) };
  const byCollection: Record<string, number> = {};
  for (const p of products) for (const h of p.collections) byCollection[h] = (byCollection[h] ?? 0) + 1;
  const brand: BrandPlan = {
    storeName: settings.storeName,
    palette: settings.palette,
    voiceTagline: settings.voiceTagline ?? "",
    vibe: settings.vibe,
    typeStyle: settings.typeStyle,
    density: settings.density,
  };
  const brief =
    "Design a DIFFERENT take on this brand's home page: a new composition, section order, hero concept and copy angle aimed at converting a first-time visitor. Keep the same brand identity, palette and catalog facts — change the design, not the brand.";
  try {
    const msg = await getAnthropic().messages.create({
      model: storegenHtmlModel(),
      max_tokens: 12000,
      system: HOME_HTML_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildHomeHtmlUserMessage(brand, brief, menu, false, { products: products.length, byCollection }) }],
    });
    if ((msg as { stop_reason?: string | null }).stop_reason === "max_tokens") return null;
    const html = extractStoreHtml(textOf(msg));
    const clean = html ? sanitizeStoreHtml(html, { links: linkSet }) : "";
    const blocks = clean ? spliceCatalogBlocks(clean, valid) : [];
    return blocks.length > 0 ? { kind: "singleton", pageKey: "home", blocks } : null;
  } catch (err) {
    console.error("[storegen] challenger home generation failed", err);
    return null;
  }
}

export async function generateStore(input: GenerateInput): Promise<GenerateResult> {
  const runId = crypto.randomUUID();
  const model = storegenModel();
  const catalog = getCatalog();
  const products = await catalog.listProducts(input.shopId);
  const collections = await catalog.listCollections(input.shopId);
  const menu: CatalogMenu = {
    products: products.slice(0, MENU_PRODUCT_CAP).map((p) => ({ id: p.id, handle: p.handle, title: p.title })),
    collections: collections.slice(0, MENU_COLLECTION_CAP).map((c) => ({ handle: c.handle, title: c.title })),
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
  let tokenCost = 0;
  let budgetHit = false;
  // Distinguish "the model was never called" (skipLlm / budget) from "the model
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
  // An empty catalog with no brief gives the model nothing to work with — the
  // result would match the deterministic fallback anyway, so skip the paid
  // calls entirely (this is also the auto-build path for brand-new shops).
  // Reference images ARE real input, so their presence keeps the calls on.
  const skipLlm = products.length === 0 && collections.length === 0 && !input.brief && !hasReferences;
  const client = getAnthropic();

  interface CallResult { text: string; truncated: boolean }

  // Spend-based gate: a call is admitted while ACTUAL spend is under budget. The concurrent
  // Stage-2 calls can therefore overshoot by at most their own output allowances — a bounded,
  // accepted overshoot. The alternative (pre-reserving output tokens) starves pages into
  // silent fallbacks whenever the estimate is pessimistic, which is strictly worse than
  // spending a little past a safety net the burst limit + daily quota already bound.
  async function call(system: string, user: string, opts?: { model?: string; maxTokens?: number; images?: Anthropic.ImageBlockParam[] }): Promise<CallResult | null> {
    if (skipLlm) return null;
    const maxTokens = opts?.maxTokens ?? 3000;
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
      const msg = await client.messages.create({ model: opts?.model ?? model, max_tokens: maxTokens, system, messages: [{ role: "user", content }] });
      const u = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      tokenCost += (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0);
      if (tokenCost >= TOKEN_BUDGET) budgetHit = true;
      llmOk += 1;
      if (isVision) visionOk += 1;
      // A max_tokens stop means the reply was cut mid-thought; callers must treat it as a
      // miss (home) or retry (block plans) — never parse or ship a truncated design.
      const truncated = (msg as { stop_reason?: string | null }).stop_reason === "max_tokens";
      return { text: textOf(msg), truncated };
    } catch (err) {
      console.error("[storegen] Claude call failed; using deterministic fallback", err);
      return null; // API/timeout → caller uses the deterministic fallback
    }
  }

  // Stage 1 — brand. The brief (when present) drives the store's identity here, not just the
  // per-doc copy below — otherwise a free-text prompt could only ever change page text.
  input.onStage?.("brand");
  const brandRes = await call(BRAND_SYSTEM_PROMPT, buildBrandUserMessage(menu, input.mode === "brief" ? input.brief : undefined, hasReferences), { images: refImageBlocks });
  let brand: BrandPlan | null = (brandRes && !brandRes.truncated && parseBrandPlan(brandRes.text)) || null;
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
    // logoUrl is deliberately OMITTED: the generator never touches the merchant's uploaded
    // logo (writing null here used to wipe it on every rebuild).
    await saveStoreSettings(input.shopId, {
      storeName: brand.storeName, palette: brand.palette, voiceTagline: brand.voiceTagline,
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

  async function buildPage(pageKey: PageKey, kind: DocKind): Promise<{ pageKey: PageKey; doc: BlockDocument; proposal: unknown; fellBack: boolean }> {
    if (pageKey === "home") {
      const homeUser = buildHomeHtmlUserMessage(brandPlan, briefArg, menu, hasReferences, counts);
      const homeOpts = {
        model: input.designModel ? DESIGN_MODEL_IDS[input.designModel] : storegenHtmlModel(),
        // 12000, not 8000: with the fx channels in the prompt, Sonnet's full home
        // pages regularly ran to exactly 8000 and truncated mid-section (verified
        // against live generations); Opus finishes near 4000 either way.
        maxTokens: 12000,
        images: refImageBlocks,
      };
      const candidateCount = homeCandidateCount();
      // Quality pipeline: N concurrent candidates exploring different angles, a judge picks
      // the winner against a slop rubric, and a weak winner gets ONE critique-driven revision.
      // candidateCount 1 disables the pipeline (single call + corrective retry — the cost lever).
      const judgeMeta: Record<string, unknown> = {};
      let html = "";
      if (candidateCount > 1) {
        const results = await Promise.all(
          Array.from({ length: candidateCount }, (_, i) =>
            call(HOME_HTML_SYSTEM_PROMPT, homeUser + candidateAngleNudge(i), homeOpts),
          ),
        );
        const candidates = results
          .map((r) => (r && !r.truncated ? extractStoreHtml(r.text) : ""))
          .filter((h) => h !== "");
        judgeMeta.candidates = candidateCount;
        judgeMeta.validCandidates = candidates.length;
        if (candidates.length === 0) {
          // Every candidate missed: one corrective retry before conceding the fallback.
          const retry = await call(HOME_HTML_SYSTEM_PROMPT, homeUser + RETRY_NUDGE_HTML, homeOpts);
          html = retry && !retry.truncated ? extractStoreHtml(retry.text) : "";
        } else {
          html = candidates[0];
          const judgeRes = await call(HOME_JUDGE_SYSTEM_PROMPT, buildHomeJudgeUserMessage(brandPlan, candidates.slice(0, 2)), { maxTokens: 600 });
          const verdict = judgeRes && !judgeRes.truncated ? parseJudgeVerdict(judgeRes.text) : null;
          if (verdict) {
            html = candidates[Math.min(verdict.winner, candidates.length) - 1];
            judgeMeta.judge = { winner: verdict.winner, score: verdict.score, critique: verdict.critique };
            if (verdict.score < REVISE_BELOW_SCORE && verdict.critique) {
              // The judge found concrete, fixable issues: one revision pass carrying the
              // critique and the current page. An invalid revision keeps the winner.
              const revised = await call(HOME_HTML_SYSTEM_PROMPT, homeUser + homeRevisionSuffix(verdict.critique, html), homeOpts);
              const revisedHtml = revised && !revised.truncated ? extractStoreHtml(revised.text) : "";
              if (revisedHtml) {
                html = revisedHtml;
                judgeMeta.revised = true;
              }
            }
          }
        }
      } else {
        let res = await call(HOME_HTML_SYSTEM_PROMPT, homeUser, homeOpts);
        // Truncated replies are a hard miss (never ship half a page); prose/refusal replies fail
        // extractStoreHtml. Either way the model was reachable, so one corrective retry is worth
        // the spend before conceding the canned fallback.
        html = res && !res.truncated ? extractStoreHtml(res.text) : "";
        if (res && !html) {
          res = await call(HOME_HTML_SYSTEM_PROMPT, homeUser + RETRY_NUDGE_HTML, homeOpts);
          html = res && !res.truncated ? extractStoreHtml(res.text) : "";
        }
      }
      const clean = html ? sanitizeStoreHtml(html, { links: linkSet }) : "";
      // Splice catalog markers into REAL productGrid/collectionList blocks — live
      // photos, prices and add-to-cart from the storefront renderer, so the home
      // has genuine commerce substance, not a typographic poster alone.
      const blocks = clean ? spliceCatalogBlocks(clean, valid) : [];
      const doc: BlockDocument = blocks.length > 0 ? { kind: "singleton", pageKey: "home", blocks } : fallbackDoc(pageKey, fbBrand, fallbackContext);
      return {
        pageKey,
        doc,
        proposal: blocks.length > 0 ? { rawHtml: true, catalogBlocks: blocks.filter((b) => b.type !== "rawHtml").length, ...judgeMeta } : { fallback: true, ...judgeMeta },
        fellBack: blocks.length === 0,
      };
    }
    const docSystem = docSystemPrompt(pageKey);
    const docUser = buildDocUserMessage(pageKey, { brand: brandPlan, brief: briefArg, menu });
    let res = await call(docSystem, docUser);
    let plan = res && !res.truncated ? parseBlockPlan(res.text) : null;
    if (res && (!plan || plan.blocks.length === 0)) {
      // The model answered but off-contract (junk JSON, truncation, empty plan): one corrective
      // retry before the canned fallback — the retry is what keeps fallback a last resort.
      res = await call(docSystem, docUser + RETRY_NUDGE_JSON);
      plan = res && !res.truncated ? parseBlockPlan(res.text) : null;
    }
    // Rewrite any block link (e.g. a button href) to a guaranteed-live target before assembly.
    if (plan) for (const b of plan.blocks) {
      if (typeof b.props.href === "string") b.props.href = normalizeStorefrontHref(b.props.href, linkSet);
    }
    try {
      const assembled = plan ? assembleDocument(pageKey, kind, plan, valid) : null;
      // A plan that validates down to nothing is a failure → fall back.
      const ok = assembled != null && assembled.doc.blocks.length > 0;
      const doc = ok ? assembled.doc : fallbackDoc(pageKey, fbBrand, fallbackContext);
      // Keep the raw plan in the audit row even when validation rejected it (rule 12).
      return { pageKey, doc, proposal: ok ? plan : { fallback: true, ...(plan ? { rejectedPlan: plan } : {}) }, fellBack: !ok };
    } catch (err) {
      console.error(`[storegen] assemble failed for ${pageKey}; using fallback`, err);
      return { pageKey, doc: fallbackDoc(pageKey, fbBrand, fallbackContext), proposal: { fallback: true }, fellBack: true };
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

  // The AI was reached but produced nothing usable — every call errored, OR every page fell
  // back (junk/truncation/budget starvation on all three). Either way the docs above are all
  // deterministic fallbacks that ignore the brief; surface that as a failed run so the studio
  // can tell the merchant instead of passing a generic layout off as their design (rule 12).
  const allFellBack = built.length > 0 && built.every((b) => b.fellBack);
  const degraded = llmAttempts > 0 && (llmOk === 0 || allFellBack);
  const status: GenerateStatus = degraded ? "failed" : products.length === 0 ? "no_products" : "draft";
  // Budget starvation and per-call outcomes ride the proposal audit row — the fixed-column
  // store_generation row stays as-is, but an operator can always see WHY a run degraded.
  proposals._meta = { budgetHit, llmAttempts, llmOk, tokenCost };
  // Best-effort attribution: references were attached and every call carrying
  // them errored while a text-only call succeeded — the run "worked" but the
  // design never saw the references. Not set on an all-failed run (status
  // "failed" already tells the merchant the AI was unreachable).
  const referencesUnread = hasReferences && visionAttempts > 0 && visionOk === 0 && llmOk > 0;
  await recordProposal(input.shopId, runId, proposals);
  await recordGeneration({ shopId: input.shopId, runId, source: input.mode, briefText: input.brief ?? null, model, status, tokenCost });
  return { runId, status, tokenCost, docs, verification, ...(referencesUnread ? { referencesUnread: true as const } : {}) };
}
