import {
  DESIGN_GUIDANCE_CORE,
  STOREFRONT_DESIGN_GUIDANCE_VERSION,
} from "./design-guidance-core.server";

export { STOREFRONT_DESIGN_GUIDANCE_VERSION };

export const STOREFRONT_GENERATION_GUIDANCE = `Return only the requested structured compiler-source object. Build from the supplied source, merchant context, allowed design tokens, curated font IDs, owned asset keys, bindings, and closed interaction vocabulary. Maintain consistent authored patterns across routes and keep the requested route scope exact.

For a full redesign, commit to one concrete concept and design system before composing routes. Cover shell, navigation, home, collection, product, search, cart, decorative checkout, and their relevant responsive and interaction states. For a scoped edit, replace only the requested route and preserve every untargeted route.

Platform constraints are absolute:
- Do not emit script, executable JavaScript, event-handler attributes, imports, or network calls.
- Do not use remote assets or fonts, data URLs, invented asset keys, or non-curated font IDs.
- Do not create arbitrary actions; use only the supplied declarative interaction vocabulary.
- Do not invent catalog values, product facts, prices, availability, policies, reviews, claims, or merchant copy.
- Do not remove or replace trusted commerce slots. Variant selection, add-to-cart, quick view, cart controls, checkout fields, payment, and order submission remain platform-owned.
- Do not alter bindings, checkout authority, source provenance, or deterministic overrides.

Use authored markup and scoped CSS only within the provided compiler schema. The compiler and server own validation, retries, persistence, installation, and status.`;

export function storefrontGenerationSystemPrompt(): string {
  return [DESIGN_GUIDANCE_CORE, STOREFRONT_GENERATION_GUIDANCE].join("\n\n");
}
