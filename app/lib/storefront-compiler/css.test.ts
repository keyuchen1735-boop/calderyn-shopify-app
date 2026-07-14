import { describe, expect, it } from "vitest";
import { MALICIOUS_CSS_CASES } from "./__fixtures__/malicious";
import { compileCss } from "./css";

describe("compileCss", () => {
  it.each(MALICIOUS_CSS_CASES)("rejects %s", (_name, source) => {
    expect(() => compileCss(source, { namespace: "home" })).toThrow();
  });

  it.each([
    `.card { background-image: image-set("https://evil.example/a.png" 1x) }`,
    `.card { background: -webkit-image-set("//evil.example/a.png" 1x) }`,
    `.card { background: cross-fade("/asset", red, 50%) }`,
    `.card { background: paint(evil) }`,
    `.card { content: "https://evil.example/track" }`,
  ])("rejects network-capable CSS values: %s", (source) => {
    expect(() => compileCss(source, { namespace: "home" })).toThrow(/network/i);
  });

  it.each([
    String.raw`.card { background: u\72l("/local.png") }`,
    String.raw`.card { content: "h\74tps://evil.example/track" }`,
  ])("rejects CSS-escaped network values after canonical parsing: %s", (source) => {
    expect(() => compileCss(source, { namespace: "home" })).toThrow(/network/i);
  });

  it("scopes selectors and namespaces IDs and keyframes", () => {
    const result = compileCss(
      `.hero, #feature:hover { animation: reveal 250ms ease; color: var(--accent) } @keyframes reveal { from { opacity: 0 } to { opacity: 1 } }`,
      { namespace: "home" },
    );
    expect(result.css).toContain("[data-cd-bundle=home] .hero");
    expect(result.css).toContain("#cd-home-feature:hover");
    expect(result.css).toContain("@keyframes cd-home-reveal");
    expect(result.css).toContain("animation: cd-home-reveal 250ms ease");
  });

  it("allows only closed runtime presentation-state attributes in recipe selectors", () => {
    const result = compileCss(
      `[data-cd-active-value="play"] .panel { opacity: 1 } [data-cd-class-token="studio"] { color: var(--accent) }`,
      { namespace: "home" },
    );

    expect(result.css).toContain('data-cd-active-value="play"');
    expect(result.css).toContain('data-cd-class-token="studio"');
    expect(() => compileCss(`[data-cd-trusted-slot-id] { display: none }`, { namespace: "home" })).toThrow(
      /protected|compiler/i,
    );
    expect(() => compileCss(`[data-cd-instance] { opacity: 0 }`, { namespace: "home" })).toThrow(/compiler/i);
  });
});
