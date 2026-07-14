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

  it("requires an explicit reset phrase before leaving edit mode", () => {
    expect(parseEditIntent("Make a completely new store from scratch")).toEqual({ kind: "startOver" });
    expect(parseEditIntent("Make the hero completely new").kind).toBe("structural");
  });

  it("carries compiler-issued route and region context into structural requests", () => {
    expect(parseEditIntent("Turn this into an editorial image mosaic", { routeId: "product", regionId: "product-media" })).toEqual({
      kind: "structural",
      context: { routeId: "product", regionId: "product-media" },
    });
  });
});
