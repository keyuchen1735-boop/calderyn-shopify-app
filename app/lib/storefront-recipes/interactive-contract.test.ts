import { describe, expect, it } from "vitest";
import type { CompiledNode, RouteArtifact } from "../storefront-bundle/types";
import { STOREFRONT_RECIPES } from ".";

function elements(nodes: readonly CompiledNode[]): Array<Extract<CompiledNode, { kind: "element" }>> {
  return nodes.flatMap((node) => node.kind === "text" ? [] : [node, ...elements(node.children)]);
}

function routeTargets(route: RouteArtifact): string[] {
  return elements(route.tree).flatMap((node) => node.routeTarget ? [node.routeTarget.routeId] : []);
}

function sourceNode(route: RouteArtifact, sourceId: string) {
  return elements(route.tree).find((node) => node.id === sourceId);
}

function topology(nodes: readonly CompiledNode[], depth = 0): string {
  return nodes.flatMap((node) => node.kind === "text"
    ? []
    : [`${depth}:${node.tag}`, topology(node.children, depth + 1)]).join("|");
}

function duplicateTemplateIds(keyFor: (recipe: typeof STOREFRONT_RECIPES[number], index: number) => string): string[][] {
  const groups = new Map<string, string[]>();
  STOREFRONT_RECIPES.forEach((recipe, index) => {
    const key = keyFor(recipe, index);
    groups.set(key, [...(groups.get(key) ?? []), recipe.config.templateId]);
  });
  return [...groups.values()].filter((templateIds) => templateIds.length > 1);
}

describe("interactive storefront recipe contracts", () => {
  it("keeps every template's HTML and CSS while binding merchant identity and catalog photography", () => {
    expect(STOREFRONT_RECIPES).toHaveLength(21);
    for (const recipe of STOREFRONT_RECIPES) {
      const { bundle } = recipe;
      expect(bundle.shell.bindings.some((binding) =>
        binding.ref.kind === "data" && binding.ref.path === "store.name"
      ), `${recipe.config.templateId} store name`).toBe(true);
      expect(bundle.shell.css, `${recipe.config.templateId} shell styling`).toBeTruthy();
      for (const routeId of ["home", "collection", "product"] as const) {
        expect(bundle.routes[routeId].bindings.some((binding) =>
          binding.kind === "src" && binding.ref.kind === "data" && binding.ref.path === "product.primaryImage"
        ), `${recipe.config.templateId} ${routeId} product image`).toBe(true);
        expect(bundle.routes[routeId].css, `${recipe.config.templateId} ${routeId} styling`).toBeTruthy();
      }
    }
  });

  it("keeps home commerce slots scoped to real repeated products", () => {
    for (const recipe of STOREFRONT_RECIPES) {
      for (const slot of recipe.bundle.routes.home.trustedSlots.filter((candidate) => candidate.kind === "quickViewCommerce")) {
        expect(slot.scopeId, `${recipe.config.templateId} home quick view`).toMatch(/^cd-/);
      }
    }
  });

  it("provides buyer-entered search and complete shell commerce navigation", () => {
    const iconMarks = new Set<string>();
    for (const recipe of STOREFRONT_RECIPES) {
      const shellPaths = recipe.bundle.shell.bindings.flatMap((binding) =>
        binding.ref.kind === "data" ? [binding.ref.path] : [],
      );
      expect(shellPaths, `${recipe.config.templateId} shell`).toContain("cart.count");
      expect(routeTargets(recipe.bundle.shell), `${recipe.config.templateId} shell`).toEqual(
        expect.arrayContaining(["home", "collection", "search", "cart", "account"]),
      );
      expect(recipe.bundle.shell.html).toContain('data-cd-platform-content="policyLinks"');
      expect(recipe.bundle.shell.html).toContain("niche-icon");
      const icon = elements(recipe.bundle.shell.tree).find((node) =>
        node.attributes.class?.split(/\s+/).includes("niche-icon")
      );
      const iconText = icon?.children.flatMap((node) => node.kind === "text" ? [node.value] : []).join("").trim();
      expect(iconText, `${recipe.config.templateId} niche icon`).toBeTruthy();
      iconMarks.add(iconText!);

      const searchElements = elements(recipe.bundle.routes.search.tree);
      expect(searchElements.some((node) => node.tag === "input" && node.attributes.type === "search"),
        `${recipe.config.templateId} search input`).toBe(true);
      const searchTransitions = recipe.bundle.routes.search.interactions.transitions;
      expect(searchTransitions.map((transition) => transition.action.type)).toEqual(
        expect.arrayContaining(["search.update", "search.submit", "search.clear"]),
      );
      const update = searchTransitions.find((transition) => transition.action.type === "search.update")!;
      expect(sourceNode(recipe.bundle.routes.search, update.sourceId)?.tag,
        `${recipe.config.templateId} search update source`).toBe("input");
    }
    expect(iconMarks.size).toBe(STOREFRONT_RECIPES.length);
  });

  it("gives every stateful control a valid value and a visible target binding", () => {
    for (const recipe of STOREFRONT_RECIPES) {
      const artifacts = [recipe.bundle.shell, ...Object.values(recipe.bundle.routes).filter(
        (route): route is RouteArtifact => "tree" in route,
      )];
      for (const artifact of artifacts) {
        const nodes = new Map(elements(artifact.tree).map((node) => [node.id, node]));
        for (const transition of artifact.interactions.transitions) {
          if (transition.action.type === "state.set") {
            expect(nodes.get(transition.sourceId)?.attributes.value,
              `${recipe.config.templateId} state control ${transition.sourceId}`).toBeTruthy();
          }
          if (transition.action.type === "accordion.toggle") {
            const targetId = transition.action.targetId;
            expect(artifact.interactions.bindings.some((binding) =>
              binding.targetId === targetId &&
              (binding.property === "expanded" || binding.property === "hidden"),
            ), `${recipe.config.templateId} accordion ${targetId}`).toBe(true);
            expect(artifact.css).toContain('[aria-expanded="true"]');
          }
          if (transition.action.type === "tabs.select" || transition.action.type === "gallery.select") {
            expect(nodes.get(transition.sourceId)?.attributes.value,
              `${recipe.config.templateId} selection value ${transition.sourceId}`).toBeTruthy();
            expect(artifact.css).toContain("data-cd-active-value");
          }
        }
      }
    }
  });

  it("emits collection intents accepted by the public adapter and search parser", () => {
    const facets = new Set(["category", "tag", "available", "fact-material", "fact-compatibility", "fact-ingredient", "fact-concern", "fact-heat-level"]);
    const sorts = new Set([
      "relevance", "title_asc", "title_desc", "price_asc", "price_desc",
      "featured", "low", "high", "protocol", "battery", "servings",
    ]);
    for (const recipe of STOREFRONT_RECIPES) {
      const nodes = new Map(elements(recipe.bundle.routes.collection.tree).map((node) => [node.id, node]));
      for (const transition of recipe.bundle.routes.collection.interactions.transitions) {
        const value = nodes.get(transition.sourceId)?.attributes.value;
        if (transition.action.type === "collection.filter") {
          expect(facets.has(transition.action.facetId),
            `${recipe.config.templateId} facet ${transition.action.facetId}`).toBe(true);
          expect(value !== undefined || nodes.get(transition.sourceId)?.tag === "input", `${recipe.config.templateId} filter value`).toBe(true);
        }
        if (transition.action.type === "collection.sort") {
          const node = nodes.get(transition.sourceId);
          const values = node?.tag === "select"
            ? node.children.flatMap((child) => child.kind === "element" ? [child.attributes.value] : []).filter(Boolean)
            : [value];
          expect(values.some((candidate) => sorts.has(candidate ?? "")), `${recipe.config.templateId} sort ${values.join(",")}`).toBe(true);
        }
      }
    }
  });

  it("ships a narrow-width navigation treatment for every recipe shell", () => {
    for (const recipe of STOREFRONT_RECIPES) {
      expect(recipe.bundle.shell.css, `${recipe.config.templateId} responsive shell`).toMatch(/@media\s*\(max-width:/);
    }
  });

  it("renders each declared scroll system as visible behavior with reduced-motion parity", () => {
    for (const recipe of STOREFRONT_RECIPES) {
      const home = recipe.bundle.routes.home;
      expect(home.css, `${recipe.config.templateId} visible scroll behavior`).toMatch(
        /scroll-snap-type|scroll-behavior|scroll-margin|position:sticky|position: sticky/,
      );
      expect(home.css, `${recipe.config.templateId} reduced motion`).toMatch(/prefers-reduced-motion:reduce/);
    }
  });

  it("keeps buyer route topologies materially distinct across all stores", () => {
    for (const routeId of ["product", "search", "cart"] as const) {
      expect(duplicateTemplateIds((recipe) => topology(recipe.bundle.routes[routeId].tree)), routeId).toEqual([]);
    }
    const checkoutFingerprints = STOREFRONT_RECIPES.map((recipe) =>
      `${topology(recipe.bundle.routes.checkout.decorativeTree)}|${recipe.bundle.routes.checkout.layout.columnMode}|${recipe.bundle.routes.checkout.layout.sectionOrder.join(",")}`,
    );
    expect(duplicateTemplateIds((_, index) => checkoutFingerprints[index]!), "checkout").toEqual([]);
  });
});
