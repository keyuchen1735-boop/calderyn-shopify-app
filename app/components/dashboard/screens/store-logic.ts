import type { Screen } from "../context";

export interface StoreReadiness {
  productCount: number;
  draftProductCount: number;
  checkoutReady: boolean;
}

export interface MissingPiece {
  key: "products" | "checkout";
  label: string;
  action: string;
  screen: Screen;
}

export type MerchantStage = "understanding" | "preparing_products" | "checking_preview";
export type BuildPhase =
  | { kind: "running"; stage?: MerchantStage }
  | { kind: "failed"; message: string };

export interface BuildStepView {
  dot: "run" | "done" | "wait";
  dotColor?: string;
  title: string;
  sub: string;
}

const COMMAND_STAGE_ROWS: ReadonlyArray<{ stage: MerchantStage; title: string; sub: string }> = [
  { stage: "understanding", title: "Understanding your request", sub: "Reading your store and the direction you described." },
  { stage: "preparing_products", title: "Preparing your catalog", sub: "Connecting the full product collection to the new direction." },
  { stage: "checking_preview", title: "Checking your preview", sub: "Opening every storefront page before saving the change." },
];

export function buildSteps(phase: BuildPhase): BuildStepView[] {
  if (phase.kind === "failed") return [buildStep(phase)];
  if (!phase.stage) return [buildStep(phase)];
  const current = COMMAND_STAGE_ROWS.findIndex(({ stage }) => stage === phase.stage);
  return COMMAND_STAGE_ROWS.map((row, index) => ({
    dot: index < current ? "done" : index === current ? "run" : "wait",
    title: row.title,
    sub: row.sub,
  }));
}

export function buildStep(phase: BuildPhase): BuildStepView {
  if (phase.kind === "failed") {
    return { dot: "wait", dotColor: "var(--red)", title: "Change failed", sub: phase.message };
  }
  const row = phase.stage && COMMAND_STAGE_ROWS.find(({ stage }) => stage === phase.stage);
  return row
    ? { dot: "run", title: row.title, sub: row.sub }
    : { dot: "run", title: "Preparing your store", sub: "This can take a moment." };
}

export function missingPieces(state: StoreReadiness): MissingPiece[] {
  const pieces: MissingPiece[] = [];
  if (state.productCount === 0) {
    pieces.push(state.draftProductCount > 0
      ? {
          key: "products",
          label: `${state.draftProductCount} draft product${state.draftProductCount === 1 ? " is" : "s are"} unfinished; the storefront will publish without them.`,
          action: "Finish products",
          screen: "catalog",
        }
      : {
          key: "products",
          label: "No products yet. The storefront will publish without a catalog.",
          action: "Add products",
          screen: "catalog",
        });
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

export function canSendComposer(input: { prompt: string; busy: boolean }): boolean {
  return !input.busy && input.prompt.trim().length > 0;
}

export type WelcomeBranch = { kind: "importing" } | { kind: "empty" } | { kind: "ready" };

export interface WelcomeSignals {
  shopDomain: string | null;
  productCount: number;
  draftProductCount: number;
  importInProgress: boolean;
}

export function decideWelcomeBranch(signals: WelcomeSignals): WelcomeBranch {
  if (signals.importInProgress) return { kind: "importing" };
  if (signals.shopDomain === null && signals.productCount === 0 && signals.draftProductCount === 0) {
    return { kind: "empty" };
  }
  return { kind: "ready" };
}

export function welcomeSubline(params: {
  branch: WelcomeBranch;
  buildPhase: BuildPhase | null;
  productCount: number;
}): string {
  const { branch, buildPhase, productCount } = params;
  if (branch.kind === "importing") {
    return "Bringing your Shopify store over. I'll start building the moment it lands.";
  }
  if (buildPhase) return buildStep(buildPhase).sub;
  if (branch.kind === "empty") {
    return "I'm Calderyn. Your store is empty so far. Let's get you something to sell, then I'll build everything around it.";
  }
  if (productCount > 0) {
    return `I've read the ${productCount} product${productCount === 1 ? "" : "s"} you have so far. Tell me how the store should feel and I'll build around ${productCount === 1 ? "it" : "them"}.`;
  }
  return "Let's build your store. You can add products anytime; I'll design around whatever you have.";
}

export function shouldShowWelcome(state: {
  hasDraft: boolean;
  hasPublished: boolean;
  generation: unknown;
}): boolean {
  return !state.hasDraft && !state.hasPublished && !state.generation;
}

export function showPromptCanvas(state: { hasDraft: boolean; hasPublished: boolean; generation: unknown }): boolean {
  return !state.hasDraft && !state.hasPublished && !state.generation;
}

export interface ParsedProductLine {
  title: string;
  priceCents: number | null;
}

export function parseProductLine(text: string): ParsedProductLine {
  const trimmed = text.trim();
  const priceMatch = trimmed.match(/\$?\s?(\d{1,4}(?:\.\d{1,2})?)\s*$/);
  const priceCents = priceMatch ? Math.round(parseFloat(priceMatch[1]) * 100) : null;
  const withoutPrice = priceMatch ? trimmed.slice(0, priceMatch.index).replace(/[,$\s]+$/, "") : trimmed;
  const title = withoutPrice
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
    .replace(/[.,!?]+$/, "");
  return { title: title || "First product", priceCents };
}

export interface ImportStepRow {
  title: string;
  sub: string;
  state: "run" | "done" | "wait";
}

interface ImportRunLike {
  state: "pulling" | "promoting" | "done" | "error";
  counts: { products: number; variants: number; collections: number; balances: number } | null;
}

export function importStepRows(run: ImportRunLike | null): ImportStepRow[] {
  const pulling = run?.state === "pulling";
  const promoting = run?.state === "promoting";
  const counts = run?.counts ?? null;
  return [
    { title: "Connecting to your Shopify store", sub: "secure sign-in", state: run ? "done" : "run" },
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
