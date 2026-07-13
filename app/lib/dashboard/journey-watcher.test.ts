import { describe, expect, it } from "vitest";
import { diffNewlyDone } from "./journey-watcher";

describe("diffNewlyDone", () => {
  it("returns nothing on the baseline payload", () => {
    expect(diffNewlyDone(null, ["account", "first_product"])).toEqual([]);
  });
  it("returns only keys that flipped to done", () => {
    expect(diffNewlyDone(new Set(["account"]), ["account", "payouts"])).toEqual(["payouts"]);
  });
  it("ignores removals (stickiness is server-side)", () => {
    expect(diffNewlyDone(new Set(["account", "payouts"]), ["account"])).toEqual([]);
  });
});
