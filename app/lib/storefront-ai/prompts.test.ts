import { describe, expect, it } from "vitest";
import { createContext } from "./__fixtures__/deterministic";
import { COMPILER_SYSTEM_PROMPT, CONCEPT_SCHEMA, EXPANSION_GROUP_SCHEMAS, JUDGE_SCHEMA, conceptPrompt, conceptRepairPrompt, routeRepairPrompt } from "./prompts";

describe("COMPILER_SYSTEM_PROMPT", () => {
  it("distinguishes repeater source attributes from compiler-owned output markers", () => {
    expect(COMPILER_SYSTEM_PROMPT).toContain("data-cd-repeat");
    expect(COMPILER_SYSTEM_PROMPT).toContain("data-cd-key");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Never emit compiler-owned output markers");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Never emit compiler-owned output markers such as data-cd-repeat-id");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Trusted commerce hosts use data-cd-slot, never data-cd-trusted-slot-id");
  });

  it("keeps structured storefront output below the provider completion ceiling", () => {
    expect(COMPILER_SYSTEM_PROMPT).toContain("below 20,000 output tokens");
  });

  it("keeps judge rationale within the parser bound", () => {
    const schema = JUDGE_SCHEMA as { properties: { rationale: { maxLength?: number } } };
    expect(schema.properties.rationale.maxLength).toBe(2_000);
  });

  it("documents every public binding path and route values as compiler IDs", () => {
    expect(COMPILER_SYSTEM_PROMPT).toContain("Path-valued data-cd attributes never contain literal record values");
    expect(COMPILER_SYSTEM_PROMPT).toContain("data-cd-product uses only product.id");
    expect(COMPILER_SYSTEM_PROMPT).toContain("At shell/home root scope, never use data-cd-param-handle");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Inside a product repeat, product links require data-cd-param-handle=\"product.handle\"");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Root catalog links use search, never parameterless product or collection routes");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Allowed data-cd-route values are home");
    expect(COMPILER_SYSTEM_PROMPT).toContain("never URL paths");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Every product or collection route target requires data-cd-param-handle");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Every policy route target requires data-cd-param-policy-id");
  });

  it("documents the closed CSS, ID, repeat, slot, and checkout contracts", () => {
    expect(COMPILER_SYSTEM_PROMPT).toContain("Every element must omit the style attribute; put all declarations in CSS");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Allowed CSS at-rules are @media, @supports, @container, and @keyframes");
    expect(COMPILER_SYSTEM_PROMPT).toContain("position: fixed");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Any position: fixed declaration fails compilation");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Every local ID reference");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Never emit href; every anchor uses data-cd-route");
    expect(COMPILER_SYSTEM_PROMPT).toContain("data-cd-active-value and data-cd-class-token are compiler output hooks");
    expect(COMPILER_SYSTEM_PROMPT).toContain("data-cd-key on a descendant");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Allowed data-cd-repeat values are collection.products, featured.products, related.products, search.results, cart.lines, product.images, and product.variants");
    expect(COMPILER_SYSTEM_PROMPT).toContain('For featured.products, set data-cd-repeat="featured.products" on the parent and data-cd-key="product.id" on a descendant');
    expect(COMPILER_SYSTEM_PROMPT).not.toContain("featured.products/product.id");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Allowed data-cd-slot values are variantPicker");
    expect(COMPILER_SYSTEM_PROMPT).toContain("quickViewCommerce is unscoped only on product, or scoped inside any product repeat");
    expect(COMPILER_SYSTEM_PROMPT).toContain("data-cd-theme-tokens is a space-separated list of local identifiers");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Checkout is decorative only");
    expect(COMPILER_SYSTEM_PROMPT).toContain("grid tracks are only 1fr, 1fr 1fr, 2fr 1fr, or minmax(0, 1fr) minmax(0, 1fr)");
    expect(COMPILER_SYSTEM_PROMPT).toContain("font-family is only inherit, var(--font-body), or var(--font-display)");
    expect(COMPILER_SYSTEM_PROMPT).toContain("font weight is normal, bold, 400, 500, 600, 700, 800, or 900");
    expect(COMPILER_SYSTEM_PROMPT).toContain("font-body and font-display are runtime-owned");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Token values never contain quotes, escapes, colons, semicolons, braces, angle brackets, or line breaks");
    expect(COMPILER_SYSTEM_PROMPT).toContain("grid placement is one local identifier");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Numeric state ranges span at most 10000");
    expect(COMPILER_SYSTEM_PROMPT).toContain("hidden and expanded bind only boolean states");

    const commerce = EXPANSION_GROUP_SCHEMAS.commerce as {
      properties: {
        checkout: { properties: { layout: { properties: {
          columnMode: { enum?: readonly string[] };
          sectionOrder: { minItems?: number; maxItems?: number; uniqueItems?: boolean };
          spacingTokenId: { pattern?: string };
          surfaceTokenIds: { maxItems?: number; items?: { pattern?: string } };
        } } } };
        assetRequests: { maxItems?: number };
      };
    };
    const layout = commerce.properties.checkout.properties.layout.properties;
    expect(layout.columnMode.enum).toEqual(["single", "summaryAside", "summaryFirst"]);
    expect(layout.sectionOrder).toMatchObject({ minItems: 6, maxItems: 6, uniqueItems: true });
    expect(layout.spacingTokenId.pattern).toBe("^[A-Za-z0-9_-]{1,80}$");
    expect(layout.surfaceTokenIds).toMatchObject({ maxItems: 16, items: { pattern: "^[A-Za-z0-9_-]{1,80}$" } });
    expect(commerce.properties.assetRequests.maxItems).toBe(8);
  });

  it("can repair a provider failure that returned no prior candidate", () => {
    const prompt = conceptRepairPrompt(
      createContext(),
      "asymmetric-commerce",
      "concept-1",
      "Structured storefront output reached the token limit",
      undefined,
    );

    expect(prompt).toContain("Candidate ID must remain concept-1");
    expect(prompt).toContain("PRIOR_OUTPUT:null");
  });

  it("requires the initial concept call to return a complete candidate", () => {
    const prompt = conceptPrompt(createContext(), "asymmetric-commerce", "concept-1");
    expect(prompt).toContain("Return the complete candidate object matching the forced schema, never a partial patch");
    expect(prompt).toContain("Concept shell/home are static compiler-safe previews");
    expect(prompt).toContain("Use no buttons, trusted slots, states, bindings to state, or interaction actions");
    expect(prompt).toContain("Product bindings appear only inside a featured.products repeat");
    expect(prompt).toContain("Root anchors use no route parameters and never target product or collection");
    expect(prompt).toContain("Product anchors inside featured.products require data-cd-param-handle=\"product.handle\"");
    expect(prompt).toContain("globalCss must be empty; keep concept styles in shell.css and home.css");
    expect(prompt).toContain("The repeat parent has only data-cd-repeat");
    expect(prompt).toContain('set data-cd-repeat="featured.products" on it');
    expect(prompt).toContain("Neither shell.html nor home.html may contain the literal <slot tag or data-cd-slot");
    expect(prompt).toContain("In shell.css and home.css, never select any data-cd-* attribute (including [data-cd-key])");
    expect(prompt).toContain("Every CSS selector stays away from trusted commerce hosts because concepts contain no slots");

    const schema = CONCEPT_SCHEMA as { properties: { designSystem: { properties: { globalCss: { maxLength?: number } } } } };
    expect(schema.properties.designSystem.properties.globalCss.maxLength).toBe(0);
  });

  it("preserves the static concept constraints during repair", () => {
    const prompt = conceptRepairPrompt(createContext(), "asymmetric-commerce", "concept-1", "invalid", {});
    expect(prompt).toContain("Concept shell/home are static compiler-safe previews");
    expect(prompt).toContain("Fix DIAGNOSTICS, then re-check the complete candidate against every compiler rule");
    expect(prompt).toContain("do not preserve other invalid syntax from PRIOR_OUTPUT");
  });

  it("requires targeted browser repairs to return a complete route object", () => {
    const diagnostic = { routeId: "product" as const, code: "hit-test", message: "covered" };

    expect(routeRepairPrompt("product", undefined, diagnostic, {})).toContain("complete route object matching the forced schema, never a partial patch");
    expect(routeRepairPrompt("product", undefined, diagnostic, {})).toContain("html, css, requiredData, and requiredCapabilities");
    expect(routeRepairPrompt("checkout", undefined, { ...diagnostic, routeId: "checkout" }, {})).toContain("html, css, and the complete layout");
  });
});
