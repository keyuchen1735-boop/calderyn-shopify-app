import { describe, expect, it } from "vitest";
import type { InteractionManifestV1 } from "~/lib/storefront-bundle/types";
import {
  RuntimeManifestError,
  createInitialRuntimeState,
  reduceRuntimeState,
} from "./state";

const manifest: InteractionManifestV1 = {
  version: 1,
  state: [
    { id: "cd-home-state-open", type: "boolean", initial: false },
    { id: "cd-home-state-mode", type: "enum", initial: "grid", allowedValues: ["grid", "list"] },
    { id: "cd-home-state-count", type: "boundedNumber", initial: 2, min: 0, max: 3 },
    { id: "cd-home-state-slide", type: "index", initial: 0, min: 0, max: 2 },
    { id: "cd-home-state-query", type: "textQuery", initial: "" },
  ],
  bindings: [],
  transitions: [],
};

describe("storefront runtime state", () => {
  it("initializes only compiler-issued, typed, bounded state", () => {
    expect(createInitialRuntimeState(manifest)).toEqual({
      "cd-home-state-open": false,
      "cd-home-state-mode": "grid",
      "cd-home-state-count": 2,
      "cd-home-state-slide": 0,
      "cd-home-state-query": "",
    });
    expect(() => createInitialRuntimeState({
      ...manifest,
      state: [{ id: "merchant-state", type: "boolean", initial: false }],
    })).toThrow(RuntimeManifestError);
  });

  it("applies typed transitions without exceeding declared bounds", () => {
    const initial = createInitialRuntimeState(manifest);
    const opened = reduceRuntimeState(manifest, initial, {
      type: "set", stateId: "cd-home-state-open", value: true,
    });
    const incremented = reduceRuntimeState(manifest, opened, {
      type: "increment", stateId: "cd-home-state-count",
    });
    const clamped = reduceRuntimeState(manifest, {
      ...incremented, "cd-home-state-count": 3,
    }, {
      type: "increment", stateId: "cd-home-state-count",
    });
    expect(opened["cd-home-state-open"]).toBe(true);
    expect(incremented["cd-home-state-count"]).toBe(3);
    expect(clamped["cd-home-state-count"]).toBe(3);
    expect(initial["cd-home-state-open"]).toBe(false);
  });

  it("rejects invalid enum, text, and non-finite values", () => {
    const initial = createInitialRuntimeState(manifest);
    expect(() => reduceRuntimeState(manifest, initial, {
      type: "set", stateId: "cd-home-state-mode", value: "table",
    })).toThrow(RuntimeManifestError);
    expect(() => reduceRuntimeState(manifest, initial, {
      type: "set", stateId: "cd-home-state-query", value: "x".repeat(201),
    })).toThrow(RuntimeManifestError);
    expect(() => reduceRuntimeState(manifest, initial, {
      type: "set", stateId: "cd-home-state-count", value: Number.POSITIVE_INFINITY,
    })).toThrow(RuntimeManifestError);
  });
});
