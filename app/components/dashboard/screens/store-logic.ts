// Pure logic for the Store studio screen (kept out of Store.tsx so it is
// testable without rendering — same pattern as dashboard-layout.ts).
import type { Screen } from "../context";
import type { StudioVibe } from "~/lib/storebuilder/studio-types";

export interface StoreReadiness {
  /** Live (active) products the storefront actually renders. */
  productCount: number;
  /** Products stuck in draft status (created but not finished). */
  draftProductCount: number;
  checkoutReady: boolean;
}

export interface MissingPiece {
  key: "products" | "checkout";
  /** What's missing, shown in the pre-publish warning. */
  label: string;
  /** Call-to-action copy for fixing it inline. */
  action: string;
  /** Dashboard screen that fixes it. */
  screen: Screen;
}

export type BuildPhase =
  | { kind: "running" }
  | { kind: "done"; status: "draft" | "no_products" | "failed" }
  | { kind: "failed"; message: string };

export interface BuildStepView {
  dot: "run" | "done" | "wait";
  dotColor?: string;
  title: string;
  sub: string;
}

/** Progress copy for the floating build step. A no-products run still drafted
 *  every page, so it reads as done — adding products is a suggestion, not a
 *  prerequisite. */
export function buildStep(phase: BuildPhase): BuildStepView {
  if (phase.kind === "running") {
    return {
      dot: "run",
      title: "Generating with your brand kit",
      sub: "This can take a few seconds.",
    };
  }
  if (phase.kind === "failed") {
    return { dot: "wait", dotColor: "var(--red)", title: "Generation failed", sub: phase.message };
  }
  // Soft-degraded: a draft exists, but the AI designer was unreachable so every
  // page is a deterministic starter layout that ignored the prompt. Say so
  // plainly instead of claiming the design is ready (rule 12).
  if (phase.status === "failed") {
    return {
      dot: "wait",
      dotColor: "var(--orange)",
      title: "Showing a starter layout",
      sub: "The AI designer was unavailable, so your prompt wasn't applied. Try Build again in a moment.",
    };
  }
  return {
    dot: "done",
    title: "Draft ready: review and publish",
    sub:
      phase.status === "no_products"
        ? "No products yet. Attach images below to add some, or publish as is."
        : "Home, collection and product pages were drafted.",
  };
}

/** What an about-to-publish store still lacks. Warn-only — publishing proceeds
 *  regardless when the merchant declines to fix these. (The hard go-live gates
 *  for cutover live in app/lib/cutover/go-live.server.ts; this panel is a
 *  softer, pre-publish nudge and deliberately does not block.) */
export function missingPieces(state: StoreReadiness): MissingPiece[] {
  const pieces: MissingPiece[] = [];
  if (state.productCount === 0) {
    pieces.push(
      state.draftProductCount > 0
        ? {
            key: "products",
            label: `${state.draftProductCount} draft product${
              state.draftProductCount === 1 ? " is" : "s are"
            } unfinished; the storefront will publish without them.`,
            action: "Finish products",
            screen: "catalog",
          }
        : {
            key: "products",
            label: "No products yet. The storefront will publish without a catalog.",
            action: "Add products",
            screen: "catalog",
          },
    );
  }
  if (!state.checkoutReady) {
    pieces.push({
      key: "checkout",
      label: "Payments aren't fully set up. Finish Stripe onboarding to get paid for orders.",
      action: "Set up payments",
      screen: "payments",
    });
  }
  return pieces;
}

// ---- chat intent parsing (the "Build with Calderyn" rail) ------------------
//
// The chat is client-orchestrated, not an LLM turn: a message maps to exactly
// ONE of a small set of real API calls, and the reply is generated from that
// real call's result. Deterministic edits (vibe word, accent color, an
// explicit headline rewrite) win first because they're unambiguous and cheap;
// "test/optimize" starts a real experiment; everything else becomes a real
// generateStudioStore() brief — the chat never fakes a change it didn't make.

export type ChatIntent =
  | { kind: "vibe"; vibe: StudioVibe }
  | { kind: "accent"; color: string }
  | { kind: "hero"; headline: string }
  | { kind: "experiment"; expKind: "headline" | "vibe" }
  | { kind: "generate"; brief: string };

const VIBE_WORDS: Record<StudioVibe, RegExp> = {
  bold: /\b(bold|dark|dramatic|loud)\b/i,
  warm: /\b(warm|earthy|cozy|craft|rustic)\b/i,
  minimal: /\b(minimal|clean|simple|quiet)\b/i,
};
const VIBE_PRIORITY: StudioVibe[] = ["bold", "warm", "minimal"];

// Curated color words -> hex, matching the storefront accent palette. A raw
// #rrggbb typed by the merchant wins over a word match.
const ACCENT_WORDS: Record<string, string> = {
  blue: "#2D7FF9",
  green: "#1F8A5B",
  orange: "#C2410C",
  purple: "#7C5CFC",
  teal: "#0F766E",
  red: "#DB4B41",
};

// Requires an explicit rewrite instruction ("headline to ..."); bare
// criticism ("the headline is boring") falls through to the other checks
// instead of silently becoming the new headline.
const HERO_QUOTE_RE = /headline (?:to say|to|says?|reading) ["']?([^"']{4,60})["']?$/i;
const HEX_RE = /#[0-9a-f]{6}\b/i;
const EXPERIMENT_RE = /\b(test|optimi[sz]e|experiment|a\/b)\b/i;
const EXPERIMENT_VIBE_HINT_RE = /\b(vibe|look|style|design)\b/i;

/** Parse a chat (or markup-note) message into the one real action it maps to. */
export function parseChatIntent(text: string): ChatIntent {
  const t = text.trim();

  const heroMatch = t.match(HERO_QUOTE_RE);
  if (heroMatch) return { kind: "hero", headline: heroMatch[1].trim() };

  for (const vibe of VIBE_PRIORITY) {
    if (VIBE_WORDS[vibe].test(t)) return { kind: "vibe", vibe };
  }

  const hex = t.match(HEX_RE);
  if (hex) return { kind: "accent", color: hex[0].toLowerCase() };
  for (const word of Object.keys(ACCENT_WORDS)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(t)) return { kind: "accent", color: ACCENT_WORDS[word] };
  }

  if (EXPERIMENT_RE.test(t)) {
    return { kind: "experiment", expKind: EXPERIMENT_VIBE_HINT_RE.test(t) ? "vibe" : "headline" };
  }

  return { kind: "generate", brief: t };
}

/** The subset of intents that are cheap, deterministic edits with a real
 *  setter — used to gate the markup-note flow, where an unmatched scribble
 *  should read as "noted" rather than kick off a full rebuild or a test. */
export function isDeterministicChatIntent(
  intent: ChatIntent,
): intent is Extract<ChatIntent, { kind: "vibe" | "accent" | "hero" }> {
  return intent.kind === "vibe" || intent.kind === "accent" || intent.kind === "hero";
}

// ---- composer attachments (staging) -----------------------------------------
//
// Images picked/dropped in the chat composer are STAGED as chips, not converted
// on the spot — they travel with the next message. The rules below mirror the
// server's multipart caps (app/routes/dashboard.api.store.tsx) so an over-limit
// pick is rejected in chat before it can fail at the API boundary.

export const MAX_STAGED_ATTACHMENTS = 4;
// Mirrors the route's MAX_IMAGE_BYTES: 3,932,160 raw bytes (~3.75 MiB) stays
// under Anthropic's per-image ceiling once base64-inflated.
export const MAX_ATTACHMENT_BYTES = 3_932_160;

export interface StagePlan {
  /** Files accepted for staging, in order (image, within size, within the cap). */
  accepted: File[];
  /** Non-image files, rejected with the "images only" message. */
  skipped: File[];
  /** Images over the byte cap, rejected by name. */
  oversize: File[];
  /** How many within-size images were dropped because the 4-image cap was hit. */
  overflow: number;
}

/** Decide which picked/dropped files can be staged, given how many are already
 *  staged. Pure so the non-image / oversize / over-cap rules stay unit-testable
 *  apart from the object-URL + React state work the screen layers on top. */
export function planStagedAttachments(files: File[], alreadyStaged: number): StagePlan {
  const skipped = files.filter((f) => !f.type.startsWith("image/"));
  const images = files.filter((f) => f.type.startsWith("image/"));
  const oversize = images.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
  const withinSize = images.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);
  const slots = Math.max(0, MAX_STAGED_ATTACHMENTS - alreadyStaged);
  const accepted = withinSize.slice(0, slots);
  return { accepted, skipped, oversize, overflow: withinSize.length - accepted.length };
}

/** Whether the composer's send button (and Enter) fires: some text OR at least
 *  one staged attachment, and not mid-build (busy) or mid-add (attaching). */
export function canSendComposer(input: {
  prompt: string;
  attachmentCount: number;
  busy: boolean;
  attaching: boolean;
}): boolean {
  if (input.busy || input.attaching) return false;
  return input.prompt.trim().length > 0 || input.attachmentCount > 0;
}

// ---- welcome overlay (first run) --------------------------------------------

export type WelcomeBranch = { kind: "importing" } | { kind: "empty" } | { kind: "ready" };

export interface WelcomeSignals {
  /** DashboardCtx.shopDomain — null for owned (non-Shopify) stores. */
  shopDomain: string | null;
  productCount: number;
  draftProductCount: number;
  importInProgress: boolean;
}

/** Which first-run branch the welcome overlay shows. An in-progress Shopify
 *  import always wins (the merchant is mid-connect, nothing to build yet);
 *  a Shopify-less shop with no catalog at all needs a product before a build
 *  is worth doing; everyone else can jump straight to building. */
export function decideWelcomeBranch(signals: WelcomeSignals): WelcomeBranch {
  if (signals.importInProgress) return { kind: "importing" };
  if (signals.shopDomain === null && signals.productCount === 0 && signals.draftProductCount === 0) {
    return { kind: "empty" };
  }
  return { kind: "ready" };
}

/** The welcome overlay's subline copy: importing wins over everything (nothing
 *  to build yet); a live build phase reports its own progress; otherwise the
 *  branch decides between the empty-catalog prompt and the ready state, which
 *  itself names the product count when there is one. */
export function welcomeSubline(params: {
  branch: WelcomeBranch;
  buildPhase: BuildPhase | null;
  productCount: number;
}): string {
  const { branch, buildPhase, productCount } = params;
  if (branch.kind === "importing") {
    return "Bringing your Shopify store over. I'll start building the moment it lands.";
  }
  if (buildPhase) {
    return buildPhase.kind === "running" ? "Building your store. This usually takes about a minute." : buildStep(buildPhase).sub;
  }
  if (branch.kind === "empty") {
    return "I'm Calderyn. Your store is empty so far. Let's get you something to sell, then I'll build everything around it.";
  }
  if (productCount > 0) {
    return `I've read the ${productCount} product${productCount === 1 ? "" : "s"} you have so far. Give me a minute and I'll build your store around ${productCount === 1 ? "it" : "them"}.`;
  }
  return "Let's build your store. You can add products anytime; I'll design around whatever you have.";
}

/** Whether the first-run welcome overlay should show at all. Only meaningful
 *  after a FRESH fetch — the session-cache seed used for the instant first
 *  paint may be stale (or belong to a different, already-built session), so
 *  callers must not evaluate this against the cache seed. */
export function shouldShowWelcome(state: {
  hasDraft: boolean;
  hasPublished: boolean;
  generation: unknown;
}): boolean {
  return !state.hasDraft && !state.hasPublished && !state.generation;
}

/** The studio shows the empty "prompt anything" canvas only until the merchant's
 *  first build — no draft, no published store, no generation on record. After one
 *  prompt the studio hands off to the full store interface and all tools, even
 *  before there are products: a hollow store still previews (and does so
 *  stunningly, via the fallback composition). */
export function showPromptCanvas(state: { hasDraft: boolean; hasPublished: boolean; generation: unknown }): boolean {
  return !state.hasDraft && !state.hasPublished && !state.generation;
}

export interface ParsedProductLine {
  title: string;
  /** Null when no price was typed — never fabricate a number the merchant
   *  didn't give. */
  priceCents: number | null;
}

/** "Hand-poured cedar candle, $18" -> { title: "Hand-poured Cedar Candle",
 *  priceCents: 1800 }. A trailing dollar amount becomes the price; whatever's
 *  left becomes a short title-cased name (first 6 words). */
export function parseProductLine(text: string): ParsedProductLine {
  const trimmed = text.trim();
  const priceMatch = trimmed.match(/\$?\s?(\d{1,4}(?:\.\d{1,2})?)\s*$/);
  const priceCents = priceMatch ? Math.round(parseFloat(priceMatch[1]) * 100) : null;
  const withoutPrice = priceMatch
    ? trimmed.slice(0, priceMatch.index).replace(/[,$\s]+$/, "")
    : trimmed;
  const words = withoutPrice.split(/\s+/).filter(Boolean).slice(0, 6);
  const title = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .replace(/[.,!?]+$/, "");
  return { title: title || "First product", priceCents };
}

// ---- Shopify import progress (folded into the welcome overlay) -------------

export interface ImportStepRow {
  title: string;
  sub: string;
  state: "run" | "done" | "wait";
}

interface ImportRunLike {
  state: "pulling" | "promoting" | "done" | "error";
  counts: { products: number; variants: number; collections: number; balances: number } | null;
}

/** Live import-progress rows for the welcome overlay — grounded in the real
 *  run state and counts, never a synthetic timer standing in for real numbers. */
export function importStepRows(run: ImportRunLike | null): ImportStepRow[] {
  const pulling = run?.state === "pulling";
  const promoting = run?.state === "promoting";
  const counts = run?.counts ?? null;
  return [
    {
      title: "Connecting to your Shopify store",
      sub: "secure sign-in",
      state: run ? "done" : "run",
    },
    {
      title: "Importing products, collections and stock",
      sub: counts ? `${counts.products} products so far` : "reading your catalog",
      state: pulling ? "run" : run ? "done" : "wait",
    },
    {
      title: "Bringing everything into Calderyn",
      sub: "organizing what was imported",
      state: promoting ? "run" : pulling || !run ? "wait" : "done",
    },
  ];
}
