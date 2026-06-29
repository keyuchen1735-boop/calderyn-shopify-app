// app/lib/storegen/block-plan.test.ts
import { describe, it, expect } from "vitest";
import { parseBlockPlan, parseBrandPlan } from "./block-plan";

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

describe("parseBrandPlan", () => {
  it("parses a brand plan with palette", () => {
    const b = parseBrandPlan('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":"Go"}');
    expect(b?.storeName).toBe("Acme");
    expect(b?.palette.primary).toBe("#000");
  });
  it("returns null when storeName is missing", () => {
    expect(parseBrandPlan('{"palette":{}}')).toBeNull();
  });
});
