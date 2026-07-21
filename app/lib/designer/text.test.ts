// D6: dock activity lines showed raw entities ("Maple &amp; Wick Candle Co.")
// because the model's prose carries HTML escaping out of the documents it
// edits. Decoding must produce text, never interpretable markup.
import { describe, expect, it } from "vitest";
import { decodeHtmlEntities } from "./text";

describe("decodeHtmlEntities", () => {
  it("decodes the walkthrough's actual failure shape", () => {
    expect(decodeHtmlEntities("Maple &amp; Wick Candle Co. is ready")).toBe("Maple & Wick Candle Co. is ready");
  });

  it("decodes the common named entities", () => {
    expect(decodeHtmlEntities("&lt;3 &quot;quoted&quot; &apos;solo&apos; a&nbsp;b &gt;")).toBe(
      "<3 \"quoted\" 'solo' a b >",
    );
  });

  it("decodes decimal and hex numeric references", () => {
    expect(decodeHtmlEntities("caf&#233; &#x2014; open")).toBe("café — open");
  });

  it("leaves unknown or malformed references verbatim", () => {
    expect(decodeHtmlEntities("&bogus; &#; R&D")).toBe("&bogus; &#; R&D");
  });

  it("returns plain strings untouched", () => {
    expect(decodeHtmlEntities("No entities here")).toBe("No entities here");
  });

  it("produces text, not markup (single pass, no double-decode)", () => {
    // "&amp;lt;b&amp;gt;" is the ESCAPED form of "&lt;b&gt;" — one decode step
    // must yield the entity text, never an actual <b> tag's characters.
    expect(decodeHtmlEntities("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });
});
