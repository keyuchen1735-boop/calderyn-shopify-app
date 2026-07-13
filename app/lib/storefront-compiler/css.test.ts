import { describe, expect, it } from "vitest";
import { MALICIOUS_CSS_CASES } from "./__fixtures__/malicious";
import { compileCss } from "./css";

describe("compileCss", () => {
  it.each(MALICIOUS_CSS_CASES)("rejects %s", (_name, source) => {
    expect(() => compileCss(source, { namespace: "home" })).toThrow();
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
});
