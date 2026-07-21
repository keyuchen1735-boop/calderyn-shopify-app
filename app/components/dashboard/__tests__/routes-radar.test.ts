import { describe, expect, it } from "vitest";
import { parsePath, pathFor } from "../routes";

describe("Radar route", () => {
  it("round-trips /dashboard/radar", () => {
    const nav = { screen: "radar" as const, param: null, sub: null };
    expect(pathFor(nav)).toBe("/dashboard/radar");
    expect(parsePath("/dashboard/radar")).toEqual(nav);
  });
  it("rejects unknown radar sub-paths", () => {
    expect(parsePath("/dashboard/radar/extra")).toBeNull();
  });
});
