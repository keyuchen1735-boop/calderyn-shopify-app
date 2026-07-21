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
import type { StoreTemplateId } from "../storefront-bundle/types";
import type { StudioDesignModel } from "../storebuilder/studio-types";
import { convertTemplateToDocuments, DESIGNER_ROUTES } from "./convert.server";
import { CRAFT_RULES, EDIT_FEEDBACK_RULES, REVIEW_CRAFT_CHECKS } from "./doctrine";
import { artDirectionFor, DESIGNER_FONT_IDS, scratchSeedFiles, type ArtDirection } from "./direction.server";
import { adoptDesignerAsset, designerFirstBuildImageLimits, generateDesignerAsset, loadDesignerAssets } from "./imagery.server";
import { applyAssetOverrides, generateMissingListingImages } from "~/lib/storegen/imagery/asset.server";
import { claimsRepairInstruction, findUnhonorableClaims } from "./claims";
import { donorTemplateArtPaths, findImageRegistryViolations, imageRepairInstruction } from "./image-registry.server";
import { editContext, fileContext, summarizeChanges } from "./context";
import { applyDesignerEdits, parseDesignerReply, type DesignerEdit } from "./edits";
import { scrubDesignerCss, scrubDesignerHtml } from "./render.server";
import type { DesignerChange, DesignerReply, DesignerRoute, DesignerStoreData } from "./types";

/** Concrete model ids behind the merchant's design-model picker; requests
 *  only ever select a key, never a free-form model id. */
const STOREFRONT_DESIGN_MODEL_IDS: Record<StudioDesignModel, string> = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-8",
};

const HISTORY_LIMIT = 14;
const MAX_TOKENS = 8_000;
const FIRST_BUILD_MAX_TOKENS = 12_000;
// The serverless route is hard-killed at maxDuration (800s) with no error
// path — stop starting new pages well before that so the build always ends
// with a saved state and an honest reply instead of a vanished stream.
const FIRST_BUILD_DEADLINE_MS = 680_000;

// Exported for prompt-rule tests — the honesty rules below are contract, and
// a reworded or dropped rule must be a deliberate diff, not a silent drift.
export const SYSTEM_PROMPT = `You are Calderyn's storefront designer. You edit a real store's HTML and CSS documents directly, in conversation with the merchant, like a senior design engineer pairing on their storefront.

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
- Placeholders like {{store.name}}, {{product.title}}, {{product.price}}, {{product.image}}, {{product.url}} and the {{#products}}...{{/products}} loop bind live store data; {{asset.hero}} binds this store's generated hero photograph when one exists. Keep them working; never invent new placeholder names.
- Never add scripts, iframes, forms, event handlers, or references to external URLs. Fonts come only from the @font-face files already in base.css. Images: ONLY the placeholder bindings ({{product.image}}, {{store.logo}}, {{asset.<key>}} for assets named in this conversation) and template art paths already present in the current files. NEVER invent an image path or file name — nothing else exists on disk, so an invented path renders as a broken image on every view.
- Conversion widgets are declared, not scripted. A coupon-capture popup is allowed ONLY when the merchant has given you a real discount code in this conversation or the build context — this platform has no discounts feature yet, so never invent a code or an offer (the runtime drops any popup whose code is not redeemable). With a real code, place exactly one marker on the home page (the runtime turns it into a real, dismissible popup and wires the behavior): <div data-designer-widget="coupon" data-code="THE-MERCHANT'S-CODE" data-headline="A welcome offer" data-sub="Join the list for early access and member pricing."></div>. Style it by editing base.css variables it inherits; never write its script. An announcement bar is ordinary styled markup you author at the very top of the shell (a thin full-width bar) — it needs no script. Give it a free-shipping-threshold line ONLY when the merchant supplied that exact threshold, and then also put data-designer-free-shipping="120" (the whole-dollar threshold) on the bar element so the store's cart drawer can show a progress meter toward it; otherwise the bar carries a true, number-free line (a brand promise or launch note).
- Live behavior comes from data attributes the runtime wires (never write scripts): a header search field is an <input type="search" data-designer-search placeholder="Search"> (the runtime submits it to the search page on Enter); a header cart count is <span data-designer-cart-count>{{cart.count}}</span> (the runtime keeps it current). Add-to-cart buttons always carry the class designer-add-to-cart.
- Design taste: one accent color per store, saturation under 80 percent, never pure black or pure white, no AI-purple gradients, no neon glows. The accent lives in base.css as --signal on :root — define it there, reference var(--signal) wherever the accent appears, and when the merchant changes the accent site-wide, update --signal in the same edit: the store's runtime chrome (coupon popup button, cart drawer meter and checkout button) colors itself from var(--signal) and must follow the swap. Text must stay readable against its background (4.5:1). Headlines short and confident. No dash characters in copy, no exclamation marks, no filler verbs (elevate, unleash, seamless).
- Never fabricate facts: no invented review counts or star ratings, no made-up customer quotes, press mentions, sales numbers, or certifications. Trust elements state real policies (shipping, returns) or stay generic ("Loved by our customers") until the merchant supplies real numbers.
- Policy and spec copy is only ever specific when the fact was supplied: shipping thresholds, delivery windows, returns windows, and product attributes (burn time, materials, dimensions, capacity) must come from the store data you were given or the merchant's own words. NEVER state a number, duration, percentage, or threshold that wasn't supplied — write the number-free generic version instead ("Fast shipping", "Easy returns"). When the merchant asks for story or policy content whose facts you don't have, build the section with generic copy and ask them for the real details in your reply (their actual shipping promise, returns window, materials) — the same way you ask for real brand-story details instead of inventing them.
- The store's name is exactly what the STORE line gives. Bind it with {{store.name}} wherever the live name renders, and never invent, guess, or hard-code a different brand or store name anywhere: copy, headings, alt text, meta, or link text. If an earlier draft left a stray brand name in the files, correct it to the real store name — it is never the store's identity, and its presence is never a reason to treat the files as another store's or to ask the merchant to paste or rebuild anything.
- Conversion, at premium DTC quality (think trenchies.co, gymshark.com):
  - Hero: full-bleed media edge to edge (no boxed image with side margins), roughly 82 to 92vh, ONE committed branded headline that states the promise (never just the store name, never a 5-slide carousel), one subhead clause, ONE high-contrast branded CTA (specific copy like "Shop the drop" or "Get yours", never bare "Shop now"), and a trust triad row of three short signals (quality, origin, speed) near the top.
  - Announcement bar pinned at the very top of the shell: a thin full-width bar with a short true line (brand promise, launch note; a shipping threshold only when the merchant supplied one).
  - Product cards: one consistent image ratio across the grid (portrait 4:5 or square), price always visible, compare-at price struck through in muted grey followed by the sale price when one exists plus a small "Save $X" chip, a single small badge slot top-left, and a subtle hover lift.
  - PDP buy area readable without scrolling and visually the heaviest block: title, rating line, price, variant choices as visual swatches and size pills (never a bare dropdown), a full-width add-to-cart, and a reassurance micro-row under it (free shipping, returns, ships fast). Below: a benefits strip, then a trust/proof or reviews block.
  - Home carries a trust/proof row (and a coupon-capture popup only under the real-code rule above — never by default).
- Premium polish, not wireframe: neutral-dominant palette (near-black not pure black, off-white paper, a couple of greys) with the single accent reserved for CTAs and sale prices; generous consistent section padding (about 96 to 128px desktop) on an 8px rhythm; a real type scale with clear jumps between display, heading, and body and negative tracking on big headlines; hairline borders and soft low-opacity shadows tinted to the background. Avoid the AI tells: no three identical equal feature cards, no centered-everything, no rainbow accent use, no filler stock geometry where a product or lifestyle image belongs.
${CRAFT_RULES}
${EDIT_FEEDBACK_RULES}
- The merchant owns this store. When they give a SPECIFIC instruction (exact copy, "change X to Y", a named color or layout), execute it exactly as stated — you may add ONE short sentence noting a concern, but never refuse, water down, or substitute your own wording for theirs. Your creative discretion applies only to vague requests ("make it better"), where you improve the weakest part and say what you changed. Never re-add an element the merchant explicitly removed earlier in this conversation, even where these rules recommend it — their removal stands until they ask for it back.`;

const REVIEW_PROMPT = `You audit one storefront page's HTML/CSS for launch readiness. Look ONLY for concrete defects: interactive elements left with default browser styling (bare buttons, blue underlined links), raw unstyled lists or tables, leftover template copy that contradicts this store, stray empty-state or filter text rendering where it shouldn't, ${REVIEW_CRAFT_CHECKS}, broken or empty href/src, and product listings rendered as one-per-row full-width bands instead of a scannable multi-column grid (the {{#products}} loop repeats per product — its item must be a grid cell, not a page section). If the page is clean reply with exactly OK and nothing else. Otherwise reply ONLY with edit blocks in this format (SEARCH copied character-for-character; * replaces a whole file):

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

async function loadDocuments(shopId: string): Promise<(DocumentSet & { unbuilt: DesignerRoute[] }) | null> {
  const { data, error } = await getSupabase()
    .from("designer_documents")
    .select("route, html, css, template_id, built")
    .eq("shop_id", shopId);
  if (error) throw error;
  if (!data || data.length === 0) return null;
  const files: Record<string, string> = {};
  const unbuilt: DesignerRoute[] = [];
  let templateId = "";
  for (const row of data) {
    templateId = String(row.template_id);
    if (row.route === "base") files["base.css"] = String(row.css ?? "");
    else {
      files[`${row.route}.html`] = String(row.html ?? "");
      files[`${row.route}.css`] = String(row.css ?? "");
      if (row.built === false) unbuilt.push(row.route as DesignerRoute);
    }
  }
  return { files, templateId, unbuilt };
}

/** The saved conversation, oldest first, for re-seeding the studio thread
 *  after a reload. Display copy only — model turns use loadHistory. */
export async function loadDesignerChat(shopId: string): Promise<Array<{ role: "user" | "assistant"; body: string }>> {
  const { data, error } = await getSupabase()
    .from("designer_chat")
    .select("role, body")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: true })
    .limit(40);
  if (error) throw error;
  return (data ?? []).map((row) => ({ role: row.role as "user" | "assistant", body: String(row.body) }));
}

/** How the route decides between a first build, a resume of an interrupted
 *  build, and a plain edit turn — one query. */
export async function designerBuildState(shopId: string): Promise<{ hasDocuments: boolean; unbuiltRoutes: DesignerRoute[] }> {
  const { data, error } = await getSupabase()
    .from("designer_documents")
    .select("route, built")
    .eq("shop_id", shopId);
  if (error) throw error;
  const rows = data ?? [];
  return {
    hasDocuments: rows.length > 0,
    unbuiltRoutes: rows
      .filter((row) => row.route !== "base" && row.built === false)
      .map((row) => row.route as DesignerRoute),
  };
}

async function saveDocuments(
  shopId: string,
  templateId: string,
  files: Record<string, string>,
  opts?: {
    /** Routes designed so far this build; the rest save with built=false so an
     *  interrupted build is detectable and resumable. Omit = all built. */
    builtRoutes?: ReadonlySet<string>;
    /** Save only these files (edit turns) — a concurrent turn on another page
     *  must not be clobbered by this turn's stale snapshot of it. */
    onlyFiles?: ReadonlySet<string>;
  },
): Promise<void> {
  // Observability only (spec D4): a save must never throw on a bad image
  // reference — that would brick mid-stream page saves and the resume path.
  // The build/edit loops feed violations back to the model as repair
  // instructions, and publishing refuses the truly broken ones.
  const violations = findImageRegistryViolations({ files, templateId, firstBuild: false });
  if (violations.length > 0) {
    console.warn("[designer] saving documents with image-registry violations", {
      shopId,
      violations: violations.slice(0, 8).map((violation) => `${violation.file}: ${violation.path} (${violation.reason})`),
    });
  }
  const stamp = new Date().toISOString();
  const rows = [
    { shop_id: shopId, route: "base", html: "", css: scrubDesignerCss(files["base.css"] ?? ""), template_id: templateId, built: true, updated_at: stamp },
    ...DESIGNER_ROUTES.map((route) => ({
      shop_id: shopId,
      route,
      html: scrubDesignerHtml(files[`${route}.html`] ?? ""),
      css: scrubDesignerCss(files[`${route}.css`] ?? ""),
      template_id: templateId,
      built: opts?.builtRoutes ? opts.builtRoutes.has(route) : true,
      updated_at: stamp,
    })),
  ].filter((row) =>
    !opts?.onlyFiles ||
    (row.route === "base"
      ? opts.onlyFiles.has("base.css")
      : opts.onlyFiles.has(`${row.route}.html`) || opts.onlyFiles.has(`${row.route}.css`)),
  );
  if (rows.length === 0) return;
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
  const [settings, rawProducts, assets] = await Promise.all([
    getStoreSettings(shopId),
    getCatalog().listProducts(shopId, { limit: 12 }),
    loadDesignerAssets(shopId),
  ]);
  // Generated product photography (store_asset rows) fills gaps where the
  // merchant hasn't uploaded imagery — same overrides the runtime applies.
  const products = await applyAssetOverrides(shopId, rawProducts).catch(() => rawProducts);
  return {
    storeName: settings.storeName,
    tagline: settings.voiceTagline,
    logoUrl: settings.logoUrl,
    assets,
    products: products.map((product) => {
      const buyable = product.variants.find((variant) => variant.available) ?? null;
      return {
        id: product.id,
        handle: product.handle,
        title: product.title,
        // Preview/live parity: the live serve path binds the catalog
        // description and compare-at price, so the studio preview must too —
        // a card the merchant approved without a description must not grow
        // one the moment the page goes live (or vice versa).
        description: product.description || null,
        priceCents: product.variants[0]?.priceCents ?? null,
        compareAtPriceCents: product.variants[0]?.compareAtPriceCents ?? null,
        available: buyable != null,
        imageUrl: product.images[0]?.url ?? null,
        variantId: buyable?.id ?? null,
      };
    }),
  };
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
    // Thinking must stay off: Sonnet 5 runs adaptive thinking by default when
    // the field is omitted, and its reasoning bills against max_tokens — a
    // heavy page turn can burn the whole budget before one edit block is
    // emitted (observed live: 11,999 thinking tokens, zero text).
    thinking: { type: "disabled" },
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
  if (response.stop_reason === "max_tokens") {
    // Surfaced for observability; the parser detects the cut block and the
    // retry loop re-requests the lost edits, so the turn still lands.
    console.warn("[designer] completion truncated at max_tokens", { maxTokens: input.maxTokens ?? MAX_TOKENS });
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
  /** First builds hold donor-template art to the replacement contract; edit
   *  turns grandfather donor paths already present in saved documents. */
  firstBuild?: boolean;
}): Promise<DesignerReply & { files: Record<string, string> }> {
  const context = editContext(input.data, input.route, input.files);

  const messages = [
    ...input.history,
    { role: "user" as const, content: `${context}\n\nMERCHANT: ${input.userMessage}` },
  ];

  // The model only sees base.css plus the page under discussion; edits to any
  // other file would rewrite pages it never read, so they are rejected.
  const allowedFiles = new Set(["base.css", `${input.route}.html`, `${input.route}.css`]);

  // Deterministic image audit (spec D4): violations in the files this turn
  // may edit feed the same retry loop as failed edits — the model repairs its
  // own output instead of a save throwing mid-stream.
  const auditImages = (files: Record<string, string>) =>
    findImageRegistryViolations({ files, templateId: input.templateId, firstBuild: input.firstBuild === true })
      .filter((violation) => allowedFiles.has(violation.file));

  let raw = await completeText({ model: input.model, system: SYSTEM_PROMPT, messages, signal: input.signal, maxTokens: input.maxTokens });
  let parsed = parseDesignerReply(raw);
  let result = applyDesignerEdits(input.files, parsed.edits, allowedFiles);
  let attempted = parsed.edits.length + (parsed.truncated ? 1 : 0);
  let violations = auditImages(result.files);

  // One retry covering the failure shapes: SEARCH text that missed, a reply
  // cut off mid-block by the output-token cap, and image references that
  // break the registry contract (invented paths, surviving donor art).
  if (result.rejected.length > 0 || parsed.truncated || violations.length > 0) {
    const failed = result.rejected
      .map((edit: DesignerEdit) => `FILE: ${edit.file}\n<<<<<<< SEARCH\n${edit.search}\n=======\n${edit.replace}\n>>>>>>> REPLACE`)
      .join("\n\n");
    const instruction = [
      parsed.truncated
        ? "Your previous reply was cut off before its final edit block completed. Re-send the edits that were lost, keeping each block small."
        : "",
      result.rejected.length > 0
        ? `These blocks did not apply because their SEARCH text is not present character-for-character in the current files (or they touch a file outside base.css and the page being discussed). Re-send ONLY these edits with SEARCH text copied exactly from the files above (or use * to replace a whole file):\n\n${failed}`
        : "",
      imageRepairInstruction(violations),
    ].filter(Boolean).join("\n\n");
    const retryRaw = await completeText({
      model: input.model,
      system: SYSTEM_PROMPT,
      messages: [
        ...messages,
        { role: "assistant" as const, content: raw.slice(0, 6_000) },
        { role: "user" as const, content: instruction },
      ],
      signal: input.signal,
      // First-build retries re-send whole-file rewrites; the higher cap must
      // carry over or the regenerated page truncates and drops its edit.
      maxTokens: input.maxTokens,
    });
    const retryParsed = parseDesignerReply(retryRaw);
    const retryResult = applyDesignerEdits(result.files, retryParsed.edits, allowedFiles);
    attempted += retryParsed.edits.length + (retryParsed.truncated ? 1 : 0);
    result = { files: retryResult.files, applied: result.applied + retryResult.applied, rejected: retryResult.rejected };
    if (!parsed.prose && retryParsed.prose) parsed = { ...parsed, prose: retryParsed.prose };
    violations = auditImages(result.files);
    if (violations.length > 0) {
      // Save still proceeds (fail-soft); publish is the hard gate.
      console.warn("[designer] image-registry violations survived the repair retry", {
        route: input.route,
        violations: violations.slice(0, 8).map((violation) => `${violation.file}: ${violation.path} (${violation.reason})`),
      });
    }
  }

  // Honest reporting (rule 12): never let success prose stand when nothing
  // (or only part) of what the model attempted actually landed.
  const changed = result.applied > 0;
  let reply: string;
  if (changed && result.rejected.length === 0) {
    reply = parsed.prose || "Done, it's in the preview.";
  } else if (changed) {
    const base = parsed.prose || "Done, it's in the preview.";
    reply = `${base} (Note: ${result.rejected.length} of the changes didn't apply cleanly — ask again for those and I'll take another pass.)`;
  } else if (attempted > 0) {
    reply = "I couldn't apply that change cleanly this time. Try asking for it in smaller steps, or point me at the exact text to change.";
  } else {
    reply = parsed.prose || "Tell me what you'd like to change and I'll make it happen.";
  }

  // Absolute output guard: whatever new formatting a model invents, edit-block
  // markers must never render in a merchant's chat bubble. If any slipped
  // through parsing into the prose, swap in an honest generic reply instead.
  if (/(?:^|\n)[ \t]*(?:<{4,}|>{4,}|={4,}|FILE:[ \t]*[\w.-]+[ \t]*$)/m.test(reply)) {
    reply = changed
      ? "Done, it's in the preview."
      : "I couldn't apply that change cleanly this time. Try asking for it in smaller steps, or point me at the exact text to change.";
  }

  return { reply, changed, rejectedEdits: result.rejected.length, files: result.files };
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
  templateId: string;
  /** First builds hold donor art to the replacement contract (spec D4). */
  firstBuild: boolean;
  model?: StudioDesignModel;
  signal?: AbortSignal;
  /** Merchant-supplied text (brief, configured facts): a numeric offer whose
   *  number/code appears here was provided, not invented. */
  providedFacts?: string;
}): Promise<{ files: Record<string, string>; fixed: number }> {
  try {
    // Deterministic backstop first (spec D5): flag obviously unhonorable offer
    // copy — percent-off, promo codes, free-shipping thresholds — that no
    // supplied fact backs, and hand the findings to the review model as
    // concrete defects to repair alongside its own findings.
    const claims = findUnhonorableClaims(input.files[`${input.route}.html`] ?? "", {
      providedFacts: input.providedFacts,
    });
    // Same for image references (spec D4): invented paths and surviving donor
    // art on this page are concrete defects the review pass must repair.
    const imagery = imageRepairInstruction(
      findImageRegistryViolations({ files: input.files, templateId: input.templateId, firstBuild: input.firstBuild })
        .filter((violation) => violation.file === "base.css" || violation.file.startsWith(`${input.route}.`)),
    );
    const audit = [claimsRepairInstruction(claims), imagery].filter(Boolean).join("\n\n");
    const raw = await completeText({
      model: input.model,
      system: REVIEW_PROMPT,
      messages: [{
        role: "user",
        content: `PAGE: ${input.route}\n\n${fileContext(input.files, input.route)}${audit ? `\n\n${audit}` : ""}`,
      }],
      signal: input.signal,
      maxTokens: 4_000,
    });
    if (raw.trim().toUpperCase() === "OK") return { files: input.files, fixed: 0 };
    const parsed = parseDesignerReply(raw);
    const result = applyDesignerEdits(input.files, parsed.edits, new Set(["base.css", `${input.route}.html`, `${input.route}.css`]));
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

/** Picks the best imagery the shop ALREADY has for a zero-quota hero: the
 *  first product photo (merchant media, or a ready generated asset merged by
 *  applyAssetOverrides — never failed rows, whose urls are empty), else the
 *  store logo. Null means the shop genuinely has no usable imagery. */
export function pickExistingHeroSource(data: DesignerStoreData): string | null {
  const productImage = data.products.find((product) => product.imageUrl)?.imageUrl ?? null;
  return productImage || data.logoUrl || null;
}

// Exported for prompt-rule tests: the hero branch is contract (spec D4's
// mandatory hero) — it must never be empty, whatever imagery the shop has.
export function firstBuildInstruction(input: {
  brief: string;
  route: DesignerRoute;
  mode: DesignerBuildMode;
  templateId: string;
  direction: ArtDirection;
  donePages: DesignerRoute[];
  heroAssetUrl?: string | null;
  /** Whether any catalog product carries a usable photo ({{product.image}}). */
  hasProductImagery?: boolean;
}): string {
  // Donor-art replacement contract (spec D4): a first build names the donor
  // template's REAL art paths and requires each to be replaced or removed —
  // never kept, never re-captioned with this store's alt text. Strict here
  // (first builds only); the shared system prompt stays permissive so edit
  // turns don't break already-saved donor art.
  const donorArt = input.mode === "template" ? donorTemplateArtPaths(input.templateId) : [];
  const donorRule = donorArt.length > 0
    ? ` The template's own artwork (exactly these files: ${donorArt.join(", ")}) photographs the donor template's product category, not this merchant's: replace every reference to it with this store's real imagery ({{asset.hero}}, {{product.image}}) or remove the element entirely — never keep donor art on this store, and never re-caption it with this store's alt text.`
    : "";
  const base = input.mode === "template"
    ? `First build, page "${input.route}": this store was just attached to the "${input.templateId}" template. Rework this page so it belongs to THIS merchant: their copy, their accent, their category names, their imagery.${donorRule} Keep template structure only where it genuinely serves the page — restructure anything that hurts scanning (stacked one-per-row product lists become grids, oversized imagery gets contained), and fully style anything the template left plain.`
    : `First build, page "${input.route}": you are designing this store from scratch. Author the complete page (whole-file rewrites with * are expected) with committed art direction, not a wireframe.`;
  const direction = `Art direction for this store (starting point, adapt to the merchant's brief if they conflict): display font "${input.direction.displayFont}", body font "${input.direction.bodyFont}"; palette: ${input.direction.palette}; layout: ${input.direction.layout}; mood: ${input.direction.mood}. Add @font-face rules to base.css only for these self-hosted fonts (/storefront-fonts/<id>-latin.woff2), where <id> must be one of: ${DESIGNER_FONT_IDS.join(", ")}. No other font files exist.`;
  const continuity = input.donePages.length > 0
    ? `Pages already designed this build: ${input.donePages.join(", ")}. base.css already carries the design system from those pages — reuse it, do not fork new token names for the same concepts.`
    : "This is the first page of the build; establish the design system tokens in base.css here.";
  // Mandatory hero (spec D4): this branch must NEVER be empty — every first
  // build commits to a real hero (asset, product photography, or a deliberate
  // typographic treatment), never gray placeholder art.
  const hero = input.heroAssetUrl
    ? `A real photograph is ready for this store: use the placeholder {{asset.hero}} as an image src (hero media, a section background image, or a large brand moment). It matches this store's brief and art direction — prefer it over template art for the hero.`
    : input.hasProductImagery
      ? `This store has real product photography: build the hero around {{product.image}} as a committed full-bleed or composed brand moment — never a gray placeholder, never leftover template art.`
      : `No imagery exists for this store yet: author a deliberate typographic/color hero — committed display type, the store's palette, strong composition. No image element, no gray placeholder art.`;
  return `${input.brief}\n\n(${base}\n${direction}\n${continuity}\n${hero}\nEvery section must end launch-ready: no default browser styling, no placeholder copy, price and availability visible wherever a product shows.)`;
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
  const startedAt = Date.now();
  const mode: DesignerBuildMode = input.mode === "scratch" ? "scratch" : "template";
  const direction = artDirectionFor(input.shopId);

  // Product photography first: fill catalog gaps through the same
  // generated-asset pipeline, capped per build. Overrides are applied BEFORE
  // computing what's missing so products that already have a generated photo
  // aren't paid for again. Fail-soft — then load store data so the pages are
  // designed against the real visuals.
  // First builds carry a reserved image allowance on top of the shared daily
  // cap (spec D4) — passed as a limits override, never a counting change.
  const firstBuildLimits = designerFirstBuildImageLimits();
  let photosQuotaBlocked = false;
  try {
    const catalogProducts = await getCatalog().listProducts(input.shopId, { limit: 12 });
    const withExisting = await applyAssetOverrides(input.shopId, catalogProducts).catch(() => catalogProducts);
    await generateMissingListingImages(input.shopId, withExisting, undefined, input.signal, 6, firstBuildLimits);
  } catch (err) {
    console.error("[designer] product image generation skipped", err);
  }
  const data = await loadDesignerStoreData(input.shopId);

  // Resume: an interrupted build left documents with built=false routes.
  // Reuse the saved files and design only the remaining pages.
  const existing = await loadDocuments(input.shopId);
  const resuming = existing !== null && existing.unbuilt.length > 0;

  let templateId: string;
  let files: Record<string, string>;
  let routesToBuild: readonly DesignerRoute[];
  if (resuming) {
    templateId = existing.templateId;
    files = existing.files;
    routesToBuild = existing.unbuilt;
  } else if (mode === "scratch") {
    templateId = "scratch";
    files = scratchSeedFiles(direction, data);
    routesToBuild = DESIGNER_ROUTES;
  } else {
    templateId = await pickTemplate(input.message, input.model, input.signal);
    const converted = await convertTemplateToDocuments(templateId as StoreTemplateId);
    files = { "base.css": converted.baseCss };
    for (const document of converted.documents) {
      files[`${document.route}.html`] = document.html;
      files[`${document.route}.css`] = document.css;
    }
    routesToBuild = DESIGNER_ROUTES;
  }

  // Record the brief up front so an interrupted build still leaves the
  // merchant's intent in history rather than an empty conversation.
  await appendHistory(input.shopId, "user", input.message);

  // Mandatory hero (spec D4): one hero per build, resolved through a fallback
  // chain that always terminates in a usable instruction. (1) Reuse before
  // generate: imagery the shop already has (first product photo, else logo)
  // is adopted as the hero at ZERO generation quota. (2) Else one generated
  // hero photograph (cheap image tier, quota-metered, fail-soft). (3) Else
  // the build instruction demands a deliberate typographic hero — never gray
  // placeholder art. A resume reuses the hero the interrupted build already
  // has; the hero lands before the pages so every page can reference it.
  let heroAssetUrl = data.assets?.hero ?? null;
  if (!heroAssetUrl) {
    const existing = pickExistingHeroSource(data);
    if (existing) {
      heroAssetUrl = await adoptDesignerAsset({ shopId: input.shopId, key: "hero", url: existing, signal: input.signal });
    }
  }
  if (!heroAssetUrl) {
    const hero = await generateDesignerAsset({
      shopId: input.shopId,
      key: "hero",
      prompt: `Photorealistic lifestyle/product photograph for an online store. Brief: ${input.message.slice(0, 500)}. Mood: ${direction.mood}. Palette leaning: ${direction.palette}. Editorial commercial photography, natural light, no text, no logos, no watermarks, no people's identifiable faces.`,
      signal: input.signal,
      limits: firstBuildLimits,
    });
    heroAssetUrl = hero.url;
    photosQuotaBlocked = photosQuotaBlocked || hero.quotaBlocked;
  }
  if (heroAssetUrl) data.assets = { ...(data.assets ?? {}), hero: heroAssetUrl };
  const hasProductImagery = data.products.some((product) => product.imageUrl);

  const donePages: DesignerRoute[] = resuming
    ? DESIGNER_ROUTES.filter((route) => !existing.unbuilt.includes(route))
    : [];
  const builtRoutes = new Set<string>(donePages);
  const remaining: DesignerRoute[] = [...routesToBuild];
  let rejected = 0;
  const total = donePages.length + remaining.length;
  while (remaining.length > 0) {
    // The platform hard-kills this function at maxDuration with no error
    // path. Stop starting pages near the deadline so the build always ends
    // with saved work and an honest reply; the next message resumes it.
    if (donePages.length > 0 && Date.now() - startedAt > FIRST_BUILD_DEADLINE_MS) break;
    const route = remaining.shift() as DesignerRoute;
    const turn = await runEditTurn({
      shopId: input.shopId,
      files,
      templateId,
      route,
      userMessage: firstBuildInstruction({ brief: input.message, route, mode, templateId, direction, donePages, heroAssetUrl, hasProductImagery }),
      history: [],
      data,
      model: input.model,
      signal: input.signal,
      maxTokens: FIRST_BUILD_MAX_TOKENS,
      firstBuild: true,
    });
    files = turn.files;
    rejected += turn.rejectedEdits;
    const review = await reviewPage({ files, route, templateId, firstBuild: true, model: input.model, signal: input.signal, providedFacts: input.message });
    files = review.files;
    donePages.push(route);
    builtRoutes.add(route);
    // Persist after every page so the preview shows finished pages
    // immediately, and so an interruption never loses completed work.
    await saveDocuments(input.shopId, templateId, files, { builtRoutes });
    input.onEvent?.({
      kind: "page",
      page: route,
      index: donePages.length,
      total,
      // A page that ended up unchanged must not stream a confusing edit-turn
      // failure line — say what actually happened.
      reply: turn.changed
        ? turn.reply
        : `The ${route} page kept its starting layout for now — tell me what you'd like different there and I'll shape it.`,
    });
  }

  const quotaNote = photosQuotaBlocked
    ? " Today's photo-generation limit was reached, so some imagery uses placeholders — build again tomorrow to fill them in."
    : "";
  if (remaining.length > 0) {
    const summary = `I've designed ${donePages.length} of ${total} pages so far — the ${remaining.join(", ")} page${remaining.length > 1 ? "s are" : " is"} still on the way. Send any message and I'll finish the rest.${quotaNote}`;
    await appendHistory(input.shopId, "assistant", summary);
    return { reply: summary, changed: donePages.length > 0, rejectedEdits: rejected };
  }

  const summary = (mode === "scratch"
    ? "Your store is built from scratch across every page. Look around the pages and tell me what to push further."
    : "Every page is designed and ready. Look around and tell me what to change.") + quotaNote;
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

  // Chat-requested imagery: "generate a banner image for the sale" produces a
  // real photograph first, then the edit turn places it via its placeholder.
  // Generation verbs only, and the request must introduce a NEW image ("a",
  // "an", "new") — "make the hero image bigger" is an edit, not a paid
  // generation.
  let userMessage = input.message;
  if (/\b(?:generate|create)\b[^.!?]{0,60}\b(?:a|an|new|another|fresh)\b[^.!?]{0,40}\b(?:photo|photograph|image|picture|banner|visual)\b/i.test(input.message)) {
    const key = `img-${Date.now().toString(36)}`;
    const generated = await generateDesignerAsset({
      shopId: input.shopId,
      key,
      prompt: `Photorealistic commercial photograph for an online store. Request: ${input.message.slice(0, 400)}. Store: ${data.storeName}. Editorial lighting, no text, no logos, no watermarks.`,
      signal: input.signal,
    });
    if (generated.url) {
      data.assets = { ...(data.assets ?? {}), [key]: generated.url };
      userMessage = `${input.message}\n\n(A new photograph was just generated for this request. Place it with the placeholder {{asset.${key}}} as an image src where it belongs.)`;
    } else if (generated.quotaBlocked) {
      userMessage = `${input.message}\n\n(Today's photo-generation limit is reached, so no new photograph could be created — tell the merchant that in one honest clause and make the rest of the change without new imagery.)`;
    }
  }

  const turn = await runEditTurn({
    shopId: input.shopId,
    files: documents.files,
    templateId: documents.templateId,
    route,
    userMessage,
    history,
    data,
    model: input.model,
    signal: input.signal,
  });

  let changes: DesignerChange[] = [];
  if (turn.changed) {
    // Save only what this turn touched: a concurrent turn on another page
    // must not be clobbered by this turn's stale snapshot of it.
    const changedFiles = new Set(
      Object.keys(turn.files).filter((name) => turn.files[name] !== documents.files[name]),
    );
    await saveDocuments(input.shopId, documents.templateId, turn.files, { onlyFiles: changedFiles });
    changes = summarizeChanges(documents.files, turn.files);
  }
  await appendHistory(input.shopId, "user", input.message);
  await appendHistory(input.shopId, "assistant", turn.reply);

  return { reply: turn.reply, changed: turn.changed, rejectedEdits: turn.rejectedEdits, changes };
}
