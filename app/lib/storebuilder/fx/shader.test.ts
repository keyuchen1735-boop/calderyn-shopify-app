// app/lib/storebuilder/fx/shader.test.ts
import { describe, it, expect } from "vitest";
import { shaderSourceWithinCap, parseShaderColors, hexToRgb, SHADER_SOURCE_CAP } from "./shader";

describe("shaderSourceWithinCap", () => {
  it("accepts source at or under the cap", () => {
    expect(shaderSourceWithinCap("void main() {}")).toBe(true);
    expect(shaderSourceWithinCap("x".repeat(SHADER_SOURCE_CAP))).toBe(true);
  });

  it("rejects source over the cap", () => {
    expect(shaderSourceWithinCap("x".repeat(SHADER_SOURCE_CAP + 1))).toBe(false);
  });
});

describe("hexToRgb", () => {
  it("parses a #rrggbb value into normalized floats", () => {
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
    expect(hexToRgb("#ffffff")).toEqual([1, 1, 1]);
    expect(hexToRgb("#ff0000")).toEqual([1, 0, 0]);
  });

  it("tolerates surrounding whitespace and mixed case", () => {
    expect(hexToRgb("  #00FF00 ")).toEqual([0, 1, 0]);
  });

  it("rejects malformed hex (shorthand, missing hash, non-hex)", () => {
    expect(hexToRgb("#fff")).toBeNull();
    expect(hexToRgb("ff0000")).toBeNull();
    expect(hexToRgb("#gggggg")).toBeNull();
    expect(hexToRgb("")).toBeNull();
  });
});

describe("parseShaderColors", () => {
  it("returns three default colors when input is absent", () => {
    const colors = parseShaderColors(undefined);
    expect(colors).toHaveLength(3);
    for (const c of colors) {
      expect(c).toHaveLength(3);
      for (const channel of c) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it("overrides only the parsed entries, keeping defaults for the rest", () => {
    const defaults = parseShaderColors(undefined);
    const colors = parseShaderColors("#ff0000,#00ff00");
    expect(colors[0]).toEqual([1, 0, 0]);
    expect(colors[1]).toEqual([0, 1, 0]);
    expect(colors[2]).toEqual(defaults[2]);
  });

  it("keeps the default for a malformed entry", () => {
    const defaults = parseShaderColors(undefined);
    const colors = parseShaderColors("#ff0000,nope,#0000ff");
    expect(colors[0]).toEqual([1, 0, 0]);
    expect(colors[1]).toEqual(defaults[1]);
    expect(colors[2]).toEqual([0, 0, 1]);
  });

  it("ignores entries beyond the third", () => {
    const colors = parseShaderColors("#ff0000,#00ff00,#0000ff,#ffffff");
    expect(colors).toHaveLength(3);
    expect(colors[2]).toEqual([0, 0, 1]);
  });
});
