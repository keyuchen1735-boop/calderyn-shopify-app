import { describe, expect, it } from "vitest";
import { rendersOwnDocument } from "./shell-bypass";

describe("rendersOwnDocument", () => {
  it("bypasses the shell for runtime-1 bundle pages", () => {
    expect(rendersOwnDocument({ runtime: 1, bundle: {}, data: {}, nonce: "n" })).toBe(true);
  });

  it("bypasses the shell for published designer pages", () => {
    // Regression: designer pages carry their own header/footer and full-bleed
    // CSS. Wrapping them in .cd-store renders the whole site inside a centered
    // max-width column with background bars on both sides.
    expect(
      rendersOwnDocument({ designer: true, bodyHtml: "<div></div>", css: "", nonce: "n", cartScript: "" }),
    ).toBe(true);
  });

  it("keeps the shell for classic block-built pages", () => {
    expect(rendersOwnDocument({ doc: { blocks: [] }, data: {}, seoMeta: [] })).toBe(false);
    expect(rendersOwnDocument({ settings: {}, experimentVibe: null, collections: [] })).toBe(false);
  });

  it("keeps the shell for non-object payloads", () => {
    expect(rendersOwnDocument(null)).toBe(false);
    expect(rendersOwnDocument(undefined)).toBe(false);
    expect(rendersOwnDocument("designer")).toBe(false);
  });

  it("does not bypass on look-alike values", () => {
    expect(rendersOwnDocument({ runtime: 2 })).toBe(false);
    expect(rendersOwnDocument({ designer: "true" })).toBe(false);
  });
});
