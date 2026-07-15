import { describe, expect, it } from "vitest";
import { canonicalizeCompiledBundle, compileBundle, hashCompiledBundle } from "./compile";
import { VALID_BUNDLE_SOURCE } from "./__fixtures__/valid-bundle";

describe("compileBundle", () => {
  it("rejects shell policy links that would render before route content", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.shell.html = `<header>Store header</header><nav data-cd-policy-links></nav>`;

    expect(() => compileBundle(source)).toThrow(/policy links.*footer/i);
  });

  it("compiles and hashes the same source deterministically", async () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    const first = await compileBundle(source);
    const second = await compileBundle(source);
    expect(first.hash).toBe(second.hash);
    expect(first.hash).toBe(await hashCompiledBundle(first.bundle));
    expect(first.report.ok).toBe(true);

    const changedTree = structuredClone(first.bundle);
    changedTree.routes.home.tree.push({ kind: "text", value: "changed" });
    expect(hashCompiledBundle(changedTree)).not.toBe(first.hash);
    const changedBinding = structuredClone(first.bundle);
    changedBinding.routes.home.bindings[0]!.ref = { kind: "literal", value: "changed" };
    expect(hashCompiledBundle(changedBinding)).not.toBe(first.hash);

    expect(first.bundle.shell.requiredData).toEqual([{ kind: "storeIdentity" }]);
    expect(first.bundle.routes.collection.requiredData).toEqual([{ kind: "currentCollection" }]);
    expect(first.bundle.routes.collection.requiredCapabilities).toContain("catalogFiltering");
    expect(first.bundle.routes.product.requiredData).toEqual([{ kind: "currentProduct" }]);
    expect(first.bundle.routes.product.requiredCapabilities).toContain("commerce");
    expect(first.bundle.routes.cart.requiredData).toEqual([{ kind: "cart" }]);
    expect(first.bundle.routes.cart.requiredCapabilities).toContain("commerce");
  });

  it("uses fixed code-unit key order for canonical hashes", () => {
    const bundle = compileBundle(structuredClone(VALID_BUNDLE_SOURCE)).bundle;
    bundle.designSystem.tokens = { "ä": "3", a: "2", Z: "1" };
    expect(canonicalizeCompiledBundle(bundle)).toContain('"tokens":{"Z":"1","a":"2","ä":"3"}');
  });

  it.each([
    `#buy { display: none }`,
    `.product * { visibility: hidden }`,
    `.product { opacity: 0 }`,
    `#buy::before { content: "fake buy" }`,
  ])("rejects CSS that can match a trusted slot or its ancestor: %s", (css) => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.routes.product.css = css;
    expect(() => compileBundle(source)).toThrow(/protected/i);
  });

  it("rejects global CSS that can match a protected node in any route", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.designSystem.globalCss = `.product { display: none }`;
    expect(() => compileBundle(source)).toThrow(/protected/i);
  });

  it("requires compiler-owned assets to use exact SHA-256 metadata", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.assets.entries = [{ key: "hero", contentHash: "a".repeat(16), mediaType: "image/webp", byteSize: 42 }];
    expect(() => compileBundle(source)).toThrow(/hash/i);
  });

  it("rejects CSS and commerce manifests that reference missing design tokens", () => {
    const cssSource = structuredClone(VALID_BUNDLE_SOURCE);
    cssSource.routes.home.css = `.hero { color: var(--missing-accent) } .never-matches { --missing-accent:#f00 }`;
    expect(() => compileBundle(cssSource)).toThrow(/missing design token/i);

    const slotSource = structuredClone(VALID_BUNDLE_SOURCE);
    slotSource.routes.cart.html = slotSource.routes.cart.html.replace(
      `data-cd-host-size="page"`,
      `data-cd-host-size="page" data-cd-theme-tokens="missing-commerce-token"`,
    );
    expect(() => compileBundle(slotSource)).toThrow(/missing design token/i);

    const tokenSource = structuredClone(VALID_BUNDLE_SOURCE);
    tokenSource.designSystem.tokens.ink = "var(--missing-accent)";
    expect(() => compileBundle(tokenSource)).toThrow(/cannot reference/i);
  });

  it("allows compiler-owned runtime progress CSS", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.routes.home.css = `.hero { opacity:var(--cd-progress) }`;

    expect(compileBundle(source).report.ok).toBe(true);
  });
});
