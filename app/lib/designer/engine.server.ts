// The from-scratch designer engine. One conversation, one code document set:
// the first prompt copies a template into the shop's own documents and makes a
// few unique adjustments; every prompt after that is a direct edit session on
// the current code, exactly like working with a coding agent. No schemas, no
// operation types — the model reads code and writes search/replace edits.
import { getAnthropic } from "~/lib/assistant/anthropic.server";
import { getSupabase } from "~/lib/supabase.server";
import { getCatalog } from "../storefront/catalog.server";
import { getStoreSettings } from "../storefront/settings.server";
import { STORE_TEMPLATE_REGISTRY } from "../storefront-bundle/registry";
import { STOREFRONT_DESIGN_MODEL_IDS } from "../storefront-ai/provider.server";
import type { StoreTemplateId } from "../storefront-bundle/types";
import type { StudioDesignModel } from "../storebuilder/studio-types";
import { convertTemplateToDocuments, DESIGNER_ROUTES } from "./convert.server";
import { artDirectionFor, scratchSeedFiles, type ArtDirection } from "./direction.server";
import { applyDesignerEdits, parseDesignerReply, type DesignerEdit } from "./edits";
import { scrubDesignerCss, scrubDesignerHtml } from "./render.server";
import type { DesignerReply, DesignerRoute, DesignerStoreData } from "./types";

const HISTORY_LIMIT = 14;
const MAX_TOKENS = 8_000;
const FIRST_BUILD_MAX_TOKENS = 12_000;

const SYSTEM_PROMPT = `You are Calderyn's storefront designer. You edit a real store's HTML and CSS documents directly, in conversation with the merchant, like a senior design engineer pairing on their storefront.

Reply with a short, plain sentence or two for the merchant (no headings, no code talk), plus your edits as blocks in EXACTLY this format:

FILE: home.html
<<<<<<< SEARCH
(exact text copied from the current file)
=======
(replacement text)
>>>>>>> REPLACE

Rules:
- The SEARCH text must be copied character-for-character from the file so it can be found. Keep each block small and scoped; use several blocks for several spots. To replace an entire file, use a single block whose SEARCH is just *
- Files you may edit: base.css (fonts, colors, shared layout) and, for the page being discussed, <route>.html and <route>.css.
- Placeholders like {{store.name}}, {{product.title}}, {{product.price}}, {{product.image}}, {{product.url}} and the {{#products}}...{{/products}} loop bind live store data. Keep them working; never invent new placeholder names.
- Never add scripts, iframes, forms, event handlers, or references to external URLs. Fonts come only from the @font-face files already in base.css. Images: template art under /storefront-recipes/ and the product placeholders.
- Design taste: one accent color per store, saturation under 80 percent, never pure black or pure white, no AI-purple gradients, no neon glows. Text must stay readable against its background (4.5:1). Headlines short and confident. No dash characters in copy, no exclamation marks, no filler verbs (elevate, unleash, seamless).
- Conversion is the job: the hero headline is the store's promise to the shopper in plain words, never just the store name (the brand mark in the header already says who they are); above the fold that promise plus ONE dominant call to action; price and availability visible on every product card; product listings ALWAYS present as a scannable multi-column grid on desktop (2 to 4 columns), never one-per-row full-width bands; the product page's buy area (title, price, stock, add to cart) readable without scrolling; the cart's checkout button is the heaviest element on that page; somewhere on home a quiet trust row (shipping, returns, guarantee); every section ends somewhere useful, no dead ends.
- Make the change the merchant asked for, decisively. If they ask for something vague ("make it better"), improve the weakest part and say what you changed.`;

const REVIEW_PROMPT = `You audit one storefront page's HTML/CSS for launch readiness. Look ONLY for concrete defects: interactive elements left with default browser styling (bare buttons, blue underlined links), raw unstyled lists or tables, leftover template copy that contradicts this store, stray empty-state or filter text rendering where it shouldn't, unreadable text against its background, a primary call to action with no hover or focus treatment, broken or empty href/src, and product listings rendered as one-per-row full-width bands instead of a scannable multi-column grid (the {{#products}} loop repeats per product — its item must be a grid cell, not a page section). If the page is clean reply with exactly OK and nothing else. Otherwise reply ONLY with edit blocks in this format (SEARCH copied character-for-character; * replaces a whole file):

FILE: <name>
<<<<<<< SEARCH
(exact current text)
=======
(replacement)
>>>>>>> REPLACE`;

interface DocumentSet {
  templateId: string;
  files: Record<string, string>;
}

async function loadDocuments(shopId: string): Promise<DocumentSet | null> {
  const { data, error } = await getSupabase()
    .from("designer_documents")
    .select("route, html, css, template_id")
    .eq("shop_id", shopId);
  if (error) throw error;
  if (!data || data.length === 0) return null;
  const files: Record<string, string> = {};
  let templateId = "";
  for (const row of data) {
    templateId = String(row.template_id);
    if (row.route === "base") files["base.css"] = String(row.css ?? "");
    else {
      files[`${row.route}.html`] = String(row.html ?? "");
      files[`${row.route}.css`] = String(row.css ?? "");
    }
  }
  return { files, templateId };
}

async function saveDocuments(shopId: string, templateId: string, files: Record<string, string>): Promise<void> {
  const rows = [
    { shop_id: shopId, route: "base", html: "", css: scrubDesignerCss(files["base.css"] ?? ""), template_id: templateId, updated_at: new Date().toISOString() },
    ...DESIGNER_ROUTES.map((route) => ({
      shop_id: shopId,
      route,
      html: scrubDesignerHtml(files[`${route}.html`] ?? ""),
      css: scrubDesignerCss(files[`${route}.css`] ?? ""),
      template_id: templateId,
      updated_at: new Date().toISOString(),
    })),
  ];
  const { error } = await getSupabase().from("designer_documents").upsert(rows, { onConflict: "shop_id,route" });
  if (error) throw error;
}

async function loadHistory(shopId: string): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const { data, error } = await getSupabase()
    .from("designer_chat")
    .select("role, body")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) throw error;
  return (data ?? []).reverse().map((row) => ({ role: row.role as "user" | "assistant", content: String(row.body) }));
}

async function appendHistory(shopId: string, role: "user" | "assistant", body: string): Promise<void> {
  const { error } = await getSupabase().from("designer_chat").insert({ shop_id: shopId, role, body: body.slice(0, 8_000) });
  if (error) throw error;
}

export async function loadDesignerStoreData(shopId: string): Promise<DesignerStoreData> {
  const [settings, products] = await Promise.all([
    getStoreSettings(shopId),
    getCatalog().listProducts(shopId, { limit: 12 }),
  ]);
  return {
    storeName: settings.storeName,
    tagline: settings.voiceTagline,
    logoUrl: settings.logoUrl,
    products: products.map((product) => ({
      id: product.id,
      handle: product.handle,
      title: product.title,
      description: null,
      priceCents: product.variants[0]?.priceCents ?? null,
      compareAtPriceCents: null,
      available: true,
      imageUrl: product.images[0]?.url ?? null,
    })),
  };
}

function fileContext(files: Record<string, string>, route: DesignerRoute): string {
  const sections = [
    ["base.css", files["base.css"] ?? ""],
    [`${route}.html`, files[`${route}.html`] ?? ""],
    [`${route}.css`, files[`${route}.css`] ?? ""],
  ] as const;
  return sections
    .map(([name, body]) => `===== ${name} =====\n${body}`)
    .join("\n\n");
}

function templateMenu(): string {
  return STORE_TEMPLATE_REGISTRY.templates
    .map((template) => `- ${template.id}: ${template.niche}. ${template.descriptor}`)
    .join("\n");
}

async function completeText(input: {
  model?: StudioDesignModel;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  signal?: AbortSignal;
  maxTokens?: number;
}): Promise<string> {
  const client = getAnthropic();
  const request = () => client.messages.create({
    model: input.model ? STOREFRONT_DESIGN_MODEL_IDS[input.model] : STOREFRONT_DESIGN_MODEL_IDS.sonnet,
    max_tokens: input.maxTokens ?? MAX_TOKENS,
    system: input.system,
    messages: input.messages,
  }, { signal: input.signal });
  let response;
  try {
    response = await request();
  } catch (error) {
    // The SDK already retried transient statuses with short backoff; a burst
    // of API load can outlast that. One patient retry saves the whole turn.
    const status = (error as { status?: number }).status;
    if (status !== 529 && status !== 429) throw error;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    if (input.signal?.aborted) throw error;
    response = await request();
  }
  return response.content
    .map((block: { type: string; text?: string }) => (block.type === "text" ? block.text ?? "" : ""))
    .join("");
}

/** Model picks the template from the registry menu; deterministic fallback. */
export async function pickTemplate(brief: string, model?: StudioDesignModel, signal?: AbortSignal): Promise<StoreTemplateId> {
  const known = new Set<string>(STORE_TEMPLATE_REGISTRY.templates.map((template) => template.id));
  try {
    const raw = await completeText({
      model,
      system: "Pick the single best storefront template for the merchant brief. Reply with the template id only, nothing else.",
      messages: [{ role: "user", content: `TEMPLATES:\n${templateMenu()}\n\nBRIEF: ${brief.slice(0, 1_500)}` }],
      signal,
    });
    const id = raw.trim().split(/\s/)[0];
    // Membership in the registry's id set proves the narrowing.
    if (known.has(id)) return id as StoreTemplateId;
  } catch {
    // Fall through to the default below.
  }
  return STORE_TEMPLATE_REGISTRY.templates[0].id;
}

async function runEditTurn(input: {
  shopId: string;
  files: Record<string, string>;
  templateId: string;
  route: DesignerRoute;
  userMessage: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  data: DesignerStoreData;
  model?: StudioDesignModel;
  signal?: AbortSignal;
  maxTokens?: number;
}): Promise<DesignerReply & { files: Record<string, string> }> {
  const context = [
    `STORE: ${input.data.storeName}${input.data.tagline ? ` — ${input.data.tagline}` : ""}`,
    `PRODUCTS: ${input.data.products.map((product) => product.title).join("; ").slice(0, 800)}`,
    `PAGE BEING EDITED: ${input.route}`,
    "",
    fileContext(input.files, input.route),
  ].join("\n");

  const messages = [
    ...input.history,
    { role: "user" as const, content: `${context}\n\nMERCHANT: ${input.userMessage}` },
  ];

  let raw = await completeText({ model: input.model, system: SYSTEM_PROMPT, messages, signal: input.signal, maxTokens: input.maxTokens });
  let parsed = parseDesignerReply(raw);
  let result = applyDesignerEdits(input.files, parsed.edits);

  // One retry for edits whose SEARCH text missed: show the model exactly which
  // blocks failed so it can re-quote from the real file.
  if (result.rejected.length > 0) {
    const failed = result.rejected
      .map((edit: DesignerEdit) => `FILE: ${edit.file}\n<<<<<<< SEARCH\n${edit.search}\n=======\n${edit.replace}\n>>>>>>> REPLACE`)
      .join("\n\n");
    const retryRaw = await completeText({
      model: input.model,
      system: SYSTEM_PROMPT,
      messages: [
        ...messages,
        { role: "assistant" as const, content: raw.slice(0, 6_000) },
        { role: "user" as const, content: `These blocks did not apply because their SEARCH text is not present character-for-character in the current files. Re-send ONLY these edits with SEARCH text copied exactly from the files above (or use * to replace a whole file):\n\n${failed}` },
      ],
      signal: input.signal,
      // First-build retries re-send whole-file rewrites; the higher cap must
      // carry over or the regenerated page truncates and drops its edit.
      maxTokens: input.maxTokens,
    });
    const retryParsed = parseDesignerReply(retryRaw);
    const retryResult = applyDesignerEdits(result.files, retryParsed.edits);
    result = { files: retryResult.files, applied: result.applied + retryResult.applied, rejected: retryResult.rejected };
    if (!parsed.prose && retryParsed.prose) parsed = { ...parsed, prose: retryParsed.prose };
  }

  return {
    reply: parsed.prose || (result.applied > 0 ? "Done, it's in the preview." : "I didn't find a safe way to make that change. Try describing it differently."),
    changed: result.applied > 0,
    rejectedEdits: result.rejected.length,
    files: result.files,
  };
}

/** True once the shop has designer documents — the route uses this to choose
 *  between the streaming first build and a plain edit turn. */
export async function designerHasDocuments(shopId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("designer_documents")
    .select("route")
    .eq("shop_id", shopId)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Launch-readiness pass over one page: a second, strict look that catches
 *  what a build turn typically misses (default-styled buttons, raw lists,
 *  leftover template copy). At most one pass; failures never sink the page. */
async function reviewPage(input: {
  files: Record<string, string>;
  route: DesignerRoute;
  model?: StudioDesignModel;
  signal?: AbortSignal;
}): Promise<{ files: Record<string, string>; fixed: number }> {
  try {
    const raw = await completeText({
      model: input.model,
      system: REVIEW_PROMPT,
      messages: [{ role: "user", content: `PAGE: ${input.route}\n\n${fileContext(input.files, input.route)}` }],
      signal: input.signal,
      maxTokens: 4_000,
    });
    if (raw.trim().toUpperCase() === "OK") return { files: input.files, fixed: 0 };
    const parsed = parseDesignerReply(raw);
    const result = applyDesignerEdits(input.files, parsed.edits);
    return { files: result.files, fixed: result.applied };
  } catch {
    return { files: input.files, fixed: 0 };
  }
}

export type DesignerBuildMode = "template" | "scratch";

export interface DesignerBuildEvent {
  kind: "page";
  page: DesignerRoute;
  index: number;
  total: number;
  reply: string;
}

function firstBuildInstruction(input: {
  brief: string;
  route: DesignerRoute;
  mode: DesignerBuildMode;
  templateId: string;
  direction: ArtDirection;
  donePages: DesignerRoute[];
}): string {
  const base = input.mode === "template"
    ? `First build, page "${input.route}": this store was just attached to the "${input.templateId}" template. Rework this page so it belongs to THIS merchant: their copy, their accent, their category names. Keep template structure only where it genuinely serves the page — restructure anything that hurts scanning (stacked one-per-row product lists become grids, oversized imagery gets contained), and fully style anything the template left plain.`
    : `First build, page "${input.route}": you are designing this store from scratch. Author the complete page (whole-file rewrites with * are expected) with committed art direction, not a wireframe.`;
  const direction = `Art direction for this store (starting point, adapt to the merchant's brief if they conflict): display font "${input.direction.displayFont}", body font "${input.direction.bodyFont}"; palette: ${input.direction.palette}; layout: ${input.direction.layout}; mood: ${input.direction.mood}. Add @font-face rules to base.css only for these self-hosted fonts (/storefront-fonts/<id>-latin.woff2).`;
  const continuity = input.donePages.length > 0
    ? `Pages already designed this build: ${input.donePages.join(", ")}. base.css already carries the design system from those pages — reuse it, do not fork new token names for the same concepts.`
    : "This is the first page of the build; establish the design system tokens in base.css here.";
  return `${input.brief}\n\n(${base}\n${direction}\n${continuity}\nEvery section must end launch-ready: no default browser styling, no placeholder copy, price and availability visible wherever a product shows.)`;
}

/** The first build: designs EVERY page, saving and reporting page by page so
 *  the merchant can watch pages land instead of staring at one long spinner. */
export async function designerFirstBuild(input: {
  shopId: string;
  message: string;
  mode?: DesignerBuildMode;
  model?: StudioDesignModel;
  signal?: AbortSignal;
  onEvent?: (event: DesignerBuildEvent) => void;
}): Promise<DesignerReply> {
  const mode: DesignerBuildMode = input.mode === "scratch" ? "scratch" : "template";
  const data = await loadDesignerStoreData(input.shopId);
  const direction = artDirectionFor(input.shopId);

  let templateId: string;
  let files: Record<string, string>;
  if (mode === "scratch") {
    templateId = "scratch";
    files = scratchSeedFiles(direction, data);
  } else {
    templateId = await pickTemplate(input.message, input.model, input.signal);
    const converted = await convertTemplateToDocuments(templateId as StoreTemplateId);
    files = { "base.css": converted.baseCss };
    for (const document of converted.documents) {
      files[`${document.route}.html`] = document.html;
      files[`${document.route}.css`] = document.css;
    }
  }

  // Record the brief up front so an interrupted build still leaves the
  // merchant's intent in history rather than an empty conversation.
  await appendHistory(input.shopId, "user", input.message);

  const donePages: DesignerRoute[] = [];
  let rejected = 0;
  for (const route of DESIGNER_ROUTES) {
    const turn = await runEditTurn({
      shopId: input.shopId,
      files,
      templateId,
      route,
      userMessage: firstBuildInstruction({ brief: input.message, route, mode, templateId, direction, donePages }),
      history: [],
      data,
      model: input.model,
      signal: input.signal,
      maxTokens: FIRST_BUILD_MAX_TOKENS,
    });
    files = turn.files;
    rejected += turn.rejectedEdits;
    const review = await reviewPage({ files, route, model: input.model, signal: input.signal });
    files = review.files;
    // Persist after every page so the preview shows finished pages immediately.
    await saveDocuments(input.shopId, templateId, files);
    donePages.push(route);
    input.onEvent?.({ kind: "page", page: route, index: donePages.length, total: DESIGNER_ROUTES.length, reply: turn.reply });
  }

  const summary = mode === "scratch"
    ? "Your store is built from scratch across every page. Look around the pages and tell me what to push further."
    : "Every page is designed and ready. Look around and tell me what to change.";
  await appendHistory(input.shopId, "assistant", summary);
  return { reply: summary, changed: true, rejectedEdits: rejected };
}

/** One designer chat turn on an existing document set. First builds go through
 *  designerFirstBuild — the API routes there when no documents exist yet. */
export async function designerTurn(input: {
  shopId: string;
  message: string;
  route?: DesignerRoute;
  model?: StudioDesignModel;
  signal?: AbortSignal;
}): Promise<DesignerReply> {
  const route: DesignerRoute = input.route && (DESIGNER_ROUTES as readonly string[]).includes(input.route) ? input.route : "home";
  const data = await loadDesignerStoreData(input.shopId);
  const documents = await loadDocuments(input.shopId);
  // The route only calls this once designerHasDocuments is true. If the set
  // vanished in the gap (a reset/harness race), do NOT silently launch a full
  // multi-call build inside this plain-JSON path — report a retryable state.
  if (!documents) {
    return { reply: "This store's design was just reset. Send your message again to start a fresh build.", changed: false, rejectedEdits: 0 };
  }

  const history = await loadHistory(input.shopId);
  const turn = await runEditTurn({
    shopId: input.shopId,
    files: documents.files,
    templateId: documents.templateId,
    route,
    userMessage: input.message,
    history,
    data,
    model: input.model,
    signal: input.signal,
  });

  if (turn.changed) {
    await saveDocuments(input.shopId, documents.templateId, turn.files);
  }
  await appendHistory(input.shopId, "user", input.message);
  await appendHistory(input.shopId, "assistant", turn.reply);

  return { reply: turn.reply, changed: turn.changed, rejectedEdits: turn.rejectedEdits };
}
