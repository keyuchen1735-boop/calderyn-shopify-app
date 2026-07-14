import type { CheckoutLayoutManifest, CheckoutRouteArtifact } from "../storefront-bundle/types";
import { CompilerError } from "./bindings";
import { compileCss } from "./css";
import { compileHtml } from "./html";

const CHECKOUT_SECTIONS = new Set<CheckoutLayoutManifest["sectionOrder"][number]>([
  "contact", "shipping", "delivery", "consent", "payment", "summary",
]);
const COLUMN_MODES = new Set<CheckoutLayoutManifest["columnMode"]>(["single", "summaryAside", "summaryFirst"]);

function isTokenId(value: string): boolean {
  if (value.length === 0 || value.length > 80) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || character === "-" || character === "_")) {
      return false;
    }
  }
  return true;
}

function validateLayout(layout: CheckoutLayoutManifest): CheckoutLayoutManifest {
  if (!COLUMN_MODES.has(layout.columnMode)) throw new CompilerError("checkout.layout", "Unsupported checkout column mode");
  if (layout.sectionOrder.length !== CHECKOUT_SECTIONS.size || new Set(layout.sectionOrder).size !== layout.sectionOrder.length) {
    throw new CompilerError("checkout.section_order", "Checkout section order must contain every trusted section exactly once");
  }
  for (const section of layout.sectionOrder) {
    if (!CHECKOUT_SECTIONS.has(section)) throw new CompilerError("checkout.section", `Unsupported checkout section ${section}`);
  }
  if (!isTokenId(layout.spacingTokenId) || layout.surfaceTokenIds.length > 16 || layout.surfaceTokenIds.some((token) => !isTokenId(token))) {
    throw new CompilerError("checkout.token", "Checkout layout tokens must be bounded local token IDs");
  }
  return {
    columnMode: layout.columnMode,
    sectionOrder: [...layout.sectionOrder],
    spacingTokenId: layout.spacingTokenId,
    surfaceTokenIds: [...layout.surfaceTokenIds],
  };
}

export interface CheckoutSource {
  html: string;
  css: string;
  layout: CheckoutLayoutManifest;
}

export function compileCheckout(source: CheckoutSource): CheckoutRouteArtifact {
  const html = compileHtml(source.html, {
    namespace: "checkout",
    rootScopeKind: "store",
    checkoutDecorative: true,
  });
  if (html.interactions.transitions.length > 0 || html.interactions.state.length > 0) {
    throw new CompilerError("checkout.interaction", "Checkout decoration cannot define interactions");
  }
  if (html.routeTargets.some((target) => target.routeId !== "policy" && target.routeId !== "home")) {
    throw new CompilerError("checkout.route", "Checkout decoration may only navigate to policy or home routes");
  }
  const css = compileCss(source.css, { namespace: "checkout", checkoutDecorative: true });
  const hasStoreIdentity = html.bindings.some(
    (binding) => binding.ref.kind === "data" && (binding.ref.path === "store.name" || binding.ref.path === "store.logo"),
  );
  return {
    decorativeHtml: html.html,
    decorativeTree: html.tree,
    bindings: html.bindings,
    decorativeCss: css.css,
    layout: validateLayout(source.layout),
    requiredData: [
      ...(hasStoreIdentity ? [{ kind: "storeIdentity" as const }] : []),
      ...(html.policyLinks ? [{ kind: "policyLinks" as const }] : []),
    ],
  };
}
