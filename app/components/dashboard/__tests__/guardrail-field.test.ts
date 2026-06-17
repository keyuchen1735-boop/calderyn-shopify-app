import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { GuardrailField, activePreset } from "../GuardrailField";

const PRESETS = [
  { value: 25000, label: "$250" },
  { value: 50000, label: "$500" },
  { value: 100000, label: "$1,000" },
];

describe("activePreset", () => {
  it("returns the matching preset string", () => {
    expect(activePreset(50000, [25000, 50000, 100000])).toBe("50000");
  });
  it("returns __custom__ for an off-preset value", () => {
    expect(activePreset(75000, [25000, 50000, 100000])).toBe("__custom__");
  });
});

describe("GuardrailField render", () => {
  it("does not show the custom input when the value matches a preset", () => {
    const html = renderToString(
      h(GuardrailField, { value: 50000, presets: PRESETS, onCommit: () => {} }),
    );
    expect(html).toContain("Custom");
    expect(html).not.toContain('type="number"');
  });
  it("shows the custom input pre-filled when the value is off-preset", () => {
    const html = renderToString(
      h(GuardrailField, {
        value: 75000,
        presets: PRESETS,
        onCommit: () => {},
        toInput: (c: number) => String(c / 100),
        suffix: "USD/day",
      }),
    );
    expect(html).toContain('type="number"');
    expect(html).toContain('value="750"');
    expect(html).toContain("USD/day");
  });
});
