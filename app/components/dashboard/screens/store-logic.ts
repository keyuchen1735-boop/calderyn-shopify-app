// Pure logic for the Store studio screen (kept out of Store.tsx so it is
// testable without rendering — same pattern as dashboard-layout.ts).
import type { Screen } from "../context";

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
  | { kind: "done"; status: "draft" | "no_products" }
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
  return {
    dot: "done",
    title: "Draft ready — review and publish",
    sub:
      phase.status === "no_products"
        ? "No products yet — attach images below to add some, or publish as is."
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
            } unfinished — the storefront will publish without them.`,
            action: "Finish products",
            screen: "catalog",
          }
        : {
            key: "products",
            label: "No products yet — the storefront will publish without a catalog.",
            action: "Add products",
            screen: "catalog",
          },
    );
  }
  if (!state.checkoutReady) {
    pieces.push({
      key: "checkout",
      label: "Payments aren't fully set up — finish Stripe onboarding to get paid for orders.",
      action: "Set up payments",
      screen: "payments",
    });
  }
  return pieces;
}
