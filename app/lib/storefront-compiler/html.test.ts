import { describe, expect, it } from "vitest";
import { MALICIOUS_HTML_CASES } from "./__fixtures__/malicious";
import { CompilerError, compileHtml } from "./html";

describe("compileHtml", () => {
  it.each(MALICIOUS_HTML_CASES)("rejects %s", (_name, source) => {
    expect(() => compileHtml(source, { namespace: "route" })).toThrow(CompilerError);
  });

  it("allows presentation HTML, strips source attributes, and issues local IDs", () => {
    const result = compileHtml(
      `<section id="hero" class="hero" data-cd-text="store.name"><span aria-hidden="true">→</span></section>`,
      { namespace: "home" },
    );

    expect(result.html).toContain('id="cd-home-hero"');
    expect(result.html).not.toContain("data-cd-text");
    expect(result.html).toContain("data-cd-bind-text");
    expect(result.bindings).toEqual([
      expect.objectContaining({
        kind: "text",
        ref: { kind: "data", path: "store.name", scopeId: "root" },
      }),
    ]);
  });

  it("preserves only a valueless empty-state marker", () => {
    expect(compileHtml(`<p data-cd-empty-state>No products yet.</p>`, { namespace: "home" }).html)
      .toContain("data-cd-empty-state");
    expect(() => compileHtml(`<p data-cd-empty-state="true">No products yet.</p>`, { namespace: "home" }))
      .toThrow(CompilerError);
  });

  it("removes route and action source attributes from deterministic HTML", () => {
    const result = compileHtml(
      `<a id="home" data-cd-route="home">Home</a><button data-cd-on="click" data-cd-action="scroll.to" data-cd-target="home">Top</button>`,
      { namespace: "shell" },
    );
    expect(result.html).not.toContain("data-cd-route=");
    expect(result.html).not.toContain("data-cd-on=");
    expect(result.html).not.toContain("data-cd-action=");
    expect(result.html).not.toContain("data-cd-target=");
  });

  it("allows bounded standalone catalog-search inputs and stable control values", () => {
    const result = compileHtml(
      `<input type="search" name="q" placeholder="Search products" value="room-mode" aria-label="Search catalog"><button value="featured" data-cd-on="click" data-cd-action="collection.sort">Featured</button>`,
      { namespace: "search", rootScopeKind: "search" },
    );

    expect(result.html).toContain('<input aria-label="Search catalog"');
    expect(result.html).toContain('name="q"');
    expect(result.html).toContain('placeholder="Search products"');
    expect(result.html).toContain('type="search"');
    expect(result.html).toContain('value="room-mode"');
    expect(result.interactions.transitions).toEqual([
      expect.objectContaining({ action: expect.objectContaining({ type: "collection.sort" }) }),
    ]);
    expect(result.html).toContain('value="featured"');
  });

  it("preserves source form structure while compiling controls into safe runtime actions", () => {
    const result = compileHtml(
      `<button data-cd-route="collection">Shop</button><label><input type="radio" name="kind" value="dog" data-cd-on="change" data-cd-action="collection.filter" data-cd-facet="category"> Dog</label><select aria-label="Sort products" value="relevance" data-cd-on="change" data-cd-action="collection.sort"><option value="featured">Featured</option></select>`,
      { namespace: "home" },
    );

    expect(result.tree[0]).toMatchObject({ tag: "button", routeTarget: { routeId: "collection" } });
    expect(result.html).toContain('type="radio"');
    expect(result.html).toContain('<label');
    expect(result.html).toContain('<select');
    expect(result.html).toContain('<option');
    expect(result.interactions.transitions.map(({ action }) => action.type)).toEqual([
      "collection.filter",
      "collection.sort",
    ]);
  });

  it.each([
    `<input type="password">`,
    `<input type="hidden">`,
    `<input type="search" placeholder="${"x".repeat(161)}">`,
    `<input type="search" value="${"x".repeat(121)}">`,
    `<input type="search" name="not a safe name">`,
    `<div value="machine-value"></div>`,
  ])("rejects unsafe or out-of-bounds static input/control attributes: %s", (source) => {
    expect(() => compileHtml(source, { namespace: "search", rootScopeKind: "search" })).toThrow(CompilerError);
  });

  it("rejects duplicate IDs", () => {
    expect(() => compileHtml(`<div id="same"></div><p id="same"></p>`, { namespace: "x" })).toThrow(
      /duplicate id/i,
    );
  });

  it("namespaces resolved IDREF attributes and fragment hrefs", () => {
    const result = compileHtml(
      `<nav id="menu" aria-labelledby="label"><span id="label">Menu</span><a href="#menu">Skip</a></nav>`,
      { namespace: "shell" },
    );
    expect(result.html).toContain('aria-labelledby="cd-shell-label"');
    expect(result.html).toContain('href="#cd-shell-menu"');
  });

  it.each([
    `<div aria-controls="missing"></div>`,
    `<a href="#missing">Missing</a>`,
    `<a>Inert link</a>`,
    `<button>Inert button</button>`,
  ])("rejects unresolved IDREFs and inert visible controls: %s", (source) => {
    expect(() => compileHtml(source, { namespace: "x" })).toThrow();
  });
});
