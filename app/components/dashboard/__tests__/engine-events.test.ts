import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { emitEngine, onEngine } from "../engine-events";

// The repo's vitest environment is "node" (no jsdom), but the engine-event seam
// is intentionally window-based. Provide a minimal EventTarget-backed `window`
// (and a CustomEvent shim if the runtime lacks one) so we can test the real
// dispatch/subscribe contract without pulling in a DOM environment dependency.
beforeAll(() => {
  if (typeof (globalThis as { CustomEvent?: unknown }).CustomEvent === "undefined") {
    (globalThis as { CustomEvent?: unknown }).CustomEvent = class<T> extends Event {
      detail: T;
      constructor(type: string, init?: { detail?: T }) {
        super(type);
        this.detail = init?.detail as T;
      }
    };
  }
  (globalThis as { window?: unknown }).window = new EventTarget();
});

afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("engine-events", () => {
  it("delivers a typed detail to a subscriber", () => {
    const seen: unknown[] = [];
    const off = onEngine("le-dock", (d) => seen.push(d));
    emitEngine("le-dock", { group: "ads", label: "Pause campaign", money: "$420" });
    expect(seen).toEqual([{ group: "ads", label: "Pause campaign", money: "$420" }]);
    off();
  });

  it("unsubscribe stops delivery", () => {
    const fn = vi.fn();
    const off = onEngine("le-calibrate", fn);
    off();
    emitEngine("le-calibrate", { kind: "approve", delta: 6 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("emit is a no-op with no subscribers (no throw)", () => {
    expect(() => emitEngine("le-openreason")).not.toThrow();
  });
});
