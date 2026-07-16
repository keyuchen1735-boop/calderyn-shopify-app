import { describe, expect, it } from "vitest";
import { parseEditIntent } from "./intent";

describe("parseEditIntent", () => {
  it("recognizes bounded deterministic edits without requesting a model", () => {
    expect(parseEditIntent("Make the accent #ff5500")).toEqual({
      kind: "deterministic",
      operations: [{ kind: "setToken", tokenId: "accent", value: "#ff5500" }],
    });
    expect(parseEditIntent('Change this headline to "Summer essentials"', { routeId: "home", regionId: "home-title" })).toEqual({
      kind: "deterministic",
      operations: [{ kind: "setText", routeId: "home", targetId: "home-title", value: "Summer essentials" }],
    });
    expect(parseEditIntent("Use Fraunces for headings")).toEqual({
      kind: "deterministic",
      operations: [{ kind: "setFont", target: "display", fontId: "fraunces" }],
    });
    expect(parseEditIntent("Move this section up", { routeId: "home", regionId: "home-story" })).toEqual({
      kind: "deterministic",
      operations: [{ kind: "moveRegion", routeId: "home", targetId: "home-story", direction: "up" }],
    });
  });

  it("routes a bare fresh-build command through auto selection while explicit resets stay custom", () => {
    expect(parseEditIntent("make store")).toEqual({ kind: "startOver", mode: "auto" });
    expect(parseEditIntent("Make a completely new store from scratch")).toEqual({ kind: "startOver", mode: "custom" });
    expect(parseEditIntent("Redesign the entire store from scratch")).toEqual({ kind: "startOver", mode: "custom" });
    expect(parseEditIntent("Create an entirely original storefront with no template")).toEqual({ kind: "startOver", mode: "custom" });
    expect(parseEditIntent("Don't redesign the entire store").kind).toBe("structural");
    expect(parseEditIntent("Make the hero completely new").kind).toBe("structural");
    expect(parseEditIntent("Make store more minimal").kind).toBe("structural");
  });

  it("carries compiler-issued route and region context into structural requests", () => {
    expect(parseEditIntent("Turn this into an editorial image mosaic", { routeId: "product", regionId: "product-media" })).toEqual({
      kind: "structural",
      context: { routeId: "product", regionId: "product-media" },
    });
  });

  it("does not let a stale preview selection narrow an explicitly store-wide redesign", () => {
    const selected = { routeId: "product" as const, regionId: "product-media" };
    expect(parseEditIntent("Take the entire storefront in a warmer editorial direction", selected)).toEqual({
      kind: "structural",
    });
    expect(parseEditIntent("Restyle every page so the whole shop feels cohesive", selected)).toEqual({
      kind: "structural",
    });
  });
});
