import { describe, expect, it } from "vitest";
import { THINKING_PHRASES, thinkingPhraseAt } from "../thinking";

describe("thinkingPhraseAt", () => {
  it("starts with the Calderyn-branded analyzing phrase", () => {
    expect(thinkingPhraseAt(0)).toBe("Calderyn is analyzing…");
  });

  it("walks the phrases in order, one per tick", () => {
    THINKING_PHRASES.forEach((phrase, i) => {
      expect(thinkingPhraseAt(i)).toBe(phrase);
    });
  });

  it("holds on the last phrase instead of wrapping", () => {
    const last = THINKING_PHRASES[THINKING_PHRASES.length - 1];
    expect(thinkingPhraseAt(THINKING_PHRASES.length)).toBe(last);
    expect(thinkingPhraseAt(999)).toBe(last);
  });

  it("clamps negative steps to the first phrase", () => {
    expect(thinkingPhraseAt(-3)).toBe(THINKING_PHRASES[0]);
  });
});
