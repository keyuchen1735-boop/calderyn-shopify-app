// app/lib/storegen/block-plan.test.ts
import { describe, it, expect } from "vitest";
import { parseBlockPlan, parseBrandPlan, PALETTE_LIBRARY } from "./block-plan";

describe("parseBlockPlan", () => {
  it("parses a fenced JSON block plan", () => {
    const raw = '```json\n{"blocks":[{"type":"hero","props":{"headline":"Hi"},"layout":{"x":0,"y":0,"w":12,"h":2}}]}\n```';
    expect(parseBlockPlan(raw)?.blocks[0].type).toBe("hero");
  });
  it("returns null on non-JSON", () => {
    expect(parseBlockPlan("sorry I cannot do that")).toBeNull();
  });
  it("returns null when blocks is missing/!array", () => {
    expect(parseBlockPlan('{"foo":1}')).toBeNull();
  });
  it("drops malformed block entries but keeps valid ones", () => {
    const plan = parseBlockPlan('{"blocks":[{"type":"hero","props":{}},{"nope":1},{"type":42}]}');
    expect(plan?.blocks).toHaveLength(1);
    expect(plan?.blocks[0]).toEqual({ type: "hero", props: {}, layout: undefined });
  });
});

// WCAG 2.x relative luminance + contrast ratio — the library's stated contract is that every
// entry is AA-safe, so compute it rather than trusting the hand-picked hex values.
function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("PALETTE_LIBRARY", () => {
  it("has 24 uniquely named palettes (single capitalized words)", () => {
    expect(PALETTE_LIBRARY).toHaveLength(24);
    const names = PALETTE_LIBRARY.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z][a-z]+$/);
  });
  it("every palette passes WCAG AA: text on background >= 4.5:1", () => {
    for (const p of PALETTE_LIBRARY) {
      expect(contrast(p.text, p.background), `${p.name} text/background`).toBeGreaterThanOrEqual(4.5);
    }
  });
  // All 24 entries clear 3:1 (the original 12 were checked and already pass — lowest is
  // Sand at ~4.8 — so no exemption for the pre-expansion entries is needed).
  it("every palette keeps the primary legible on the background (>= 3:1)", () => {
    for (const p of PALETTE_LIBRARY) {
      expect(contrast(p.primary, p.background), `${p.name} primary/background`).toBeGreaterThanOrEqual(3);
    }
  });
  it("stays a light-background library (no dark canvases sneak in)", () => {
    for (const p of PALETTE_LIBRARY) {
      expect(luminance(p.background), `${p.name} background`).toBeGreaterThanOrEqual(0.8);
    }
  });
});

describe("parseBrandPlan", () => {
  it("resolves a curated palette by name and passes the vibe through", () => {
    const b = parseBrandPlan('{"storeName":"Acme","paletteName":"Midnight","vibe":"bold","voiceTagline":"Go"}');
    expect(b?.storeName).toBe("Acme");
    expect(b?.palette).toEqual({ primary: "#1e3a8a", background: "#f8fafc", text: "#0f172a" });
    expect(b?.vibe).toBe("bold");
  });
  it("returns null when storeName is missing", () => {
    expect(parseBrandPlan('{"palette":{}}')).toBeNull();
  });
  it("defaults to the minimal vibe when vibe is missing or junk", () => {
    expect(parseBrandPlan('{"storeName":"Acme"}')?.vibe).toBe("minimal");
    expect(parseBrandPlan('{"storeName":"Acme","vibe":"spicy"}')?.vibe).toBe("minimal");
  });
  it("snaps a hallucinated/legacy free-hex palette to the nearest curated palette by hue, never the raw hex", () => {
    // Pure green (hue 120°) sits closest to Forest's ~143° among the 12 curated primaries.
    const b = parseBrandPlan('{"storeName":"Acme","palette":{"primary":"#00ff00","background":"#fff","text":"#000"}}');
    const forest = PALETTE_LIBRARY.find((p) => p.name === "Forest")!;
    expect(b?.palette).toEqual({ primary: forest.primary, background: forest.background, text: forest.text });
  });
  it("falls back to the default curated palette when no name and no usable hex is present", () => {
    const b = parseBrandPlan('{"storeName":"Acme"}');
    expect(b?.palette).toEqual({ primary: PALETTE_LIBRARY[0].primary, background: PALETTE_LIBRARY[0].background, text: PALETTE_LIBRARY[0].text });
  });
  it("snaps an achromatic (gray/black/white) hex to Charcoal — a neutral brief must not turn teal", () => {
    const charcoal = PALETTE_LIBRARY.find((p) => p.name === "Charcoal")!;
    const gray = parseBrandPlan('{"storeName":"Acme","palette":{"primary":"#808080","background":"#fff","text":"#000"}}');
    expect(gray?.palette).toEqual({ primary: charcoal.primary, background: charcoal.background, text: charcoal.text });
    const black = parseBrandPlan('{"storeName":"Acme","palette":{"primary":"#000000","background":"#fff","text":"#000"}}');
    expect(black?.palette).toEqual({ primary: charcoal.primary, background: charcoal.background, text: charcoal.text });
  });
  it("parses typeStyle and density, defaulting invalid/missing to classic/standard", () => {
    const ok = parseBrandPlan('{"storeName":"Acme","paletteName":"Midnight","vibe":"bold","typeStyle":"editorial","density":"roomy","voiceTagline":"Go"}');
    expect(ok?.typeStyle).toBe("editorial");
    expect(ok?.density).toBe("roomy");

    const bad = parseBrandPlan('{"storeName":"Acme","paletteName":"Midnight","vibe":"bold","typeStyle":"comic-sans","density":"huge"}');
    expect(bad?.typeStyle).toBe("classic");
    expect(bad?.density).toBe("standard");

    const missing = parseBrandPlan('{"storeName":"Acme","paletteName":"Midnight","vibe":"bold"}');
    expect(missing?.typeStyle).toBe("classic");
    expect(missing?.density).toBe("standard");
  });
});
