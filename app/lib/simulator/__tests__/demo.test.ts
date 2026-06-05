// app/lib/simulator/__tests__/demo.test.ts
import { describe, it, expect } from "vitest";
import { DEMO_MODEL } from "../demo";
import { sampleFunnel, seedFromString } from "../sample";

describe("DEMO_MODEL", () => {
  it("is a well-formed behavior model", () => {
    expect(DEMO_MODEL.archetypes.length).toBeGreaterThanOrEqual(5);
    expect(DEMO_MODEL.findings.length).toBeGreaterThan(0);
    for (const a of DEMO_MODEL.archetypes) {
      expect(a.weight).toBeGreaterThan(0);
    }
    // weights are a population share and should roughly sum to 1
    const total = DEMO_MODEL.archetypes.reduce((s, a) => s + a.weight, 0);
    expect(total).toBeGreaterThan(0.95);
    expect(total).toBeLessThan(1.05);
  });

  it("only references archetype ids that exist", () => {
    const ids = new Set(DEMO_MODEL.archetypes.map((a) => a.id));
    for (const f of DEMO_MODEL.findings) {
      for (const pid of f.personaIds) {
        expect(ids.has(pid)).toBe(true);
      }
    }
  });

  it("produces a believable funnel with shipping as the biggest leak", () => {
    const res = sampleFunnel(DEMO_MODEL, 1000, seedFromString("demo"));
    expect(res.stages[0].reached).toBe(1000);
    expect(res.bought).toBeGreaterThan(0);
    expect(res.bought).toBeLessThan(1000);
    expect(res.biggestLeak?.stageId).toBe("shipping_reveal");
  });
});
