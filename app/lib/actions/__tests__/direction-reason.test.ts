import { describe, it, expect } from "vitest";
import { directionTemplate, type ReasonFacts } from "../direction-reason.server";

const facts: ReasonFacts = { roas: 1.5, breakEvenRoas: 1, dataSufficient: true, status: "active" };

describe("directionTemplate", () => {
  it("explains scale_up in plain English referencing the return and break-even", () => {
    const t = directionTemplate("scale_up", facts);
    expect(t).toMatch(/winning|earning/i);
    expect(t).toContain("1.5×");
    expect(t).not.toMatch(/ROAS/); // no jargon (matches scale-reason.ts house style)
  });
  it("explains pause as losing money", () => {
    expect(directionTemplate("pause", { ...facts, roas: 0.5 })).toMatch(/losing|pause/i);
  });
  it("explains scale_down as trimming an underperformer", () => {
    expect(directionTemplate("scale_down", { ...facts, roas: 0.8 })).toMatch(/below|trim|underperform/i);
  });
  it("explains keep for an at-break-even campaign", () => {
    expect(directionTemplate("keep", { ...facts, roas: 1.0 })).toMatch(/hold|steady|break/i);
  });
  it("says paused when the campaign is paused", () => {
    expect(directionTemplate("keep", { ...facts, status: "paused" })).toMatch(/paused/i);
  });
  it("says not enough data when dataSufficient is false", () => {
    expect(directionTemplate("keep", { ...facts, dataSufficient: false })).toMatch(/not enough|yet/i);
  });
});
