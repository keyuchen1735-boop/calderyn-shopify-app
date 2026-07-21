import { describe, expect, it } from "vitest";
import { parsePath } from "../routes";

// The standalone Radar screen is gone; its queue lives inside Autopilot. Old
// bookmarks must keep working, so the retired paths parse straight to
// Autopilot (parse-only aliases — pathFor never emits them).
describe("retired Radar paths", () => {
  it("aliases /dashboard/radar to Autopilot", () => {
    expect(parsePath("/dashboard/radar")).toEqual({ screen: "autopilot", param: null, sub: null });
  });
  it("aliases /dashboard/grow/radar to Autopilot", () => {
    expect(parsePath("/dashboard/grow/radar")).toEqual({ screen: "autopilot", param: null, sub: null });
  });
  it("still rejects unknown radar sub-paths (shell falls back to Mission Control)", () => {
    expect(parsePath("/dashboard/radar/extra")).toBeNull();
    expect(parsePath("/dashboard/grow/other")).toBeNull();
  });
});
