// The sparkle-toggle race (designer-flagship spec D1 / walkthrough F1): the
// merchant flips the designer on in Settings and navigates straight to Store.
// The Store screen's own designer-state fetch can be answered from a snapshot
// taken before the toggle's save committed — that stale read must never win
// over the recorded local intent.
import { beforeEach, describe, expect, it } from "vitest";
import { clearScreenCache } from "~/lib/dashboard/screen-cache";
import type { DesignerStateVM } from "./client";
import {
  readDesignerState,
  reconcileDesignerState,
  recordDesignerToggle,
  resetDesignerToggleIntent,
  revertDesignerToggle,
} from "./state";

const serverState = (enabled: boolean, extra?: Partial<DesignerStateVM>): DesignerStateVM => ({
  enabled,
  ready: false,
  unbuiltRoutes: [],
  chat: [],
  ...extra,
});

beforeEach(() => {
  clearScreenCache();
  resetDesignerToggleIntent();
});

describe("recordDesignerToggle", () => {
  it("writes the flipped value through the cache synchronously", () => {
    recordDesignerToggle(true);
    expect(readDesignerState()?.enabled).toBe(true);
  });

  it("preserves the rest of the cached state", () => {
    reconcileDesignerState(serverState(false, { ready: true, chat: [{ role: "user", body: "hi" }] }));
    recordDesignerToggle(true);
    const state = readDesignerState();
    expect(state?.enabled).toBe(true);
    expect(state?.ready).toBe(true);
    expect(state?.chat).toEqual([{ role: "user", body: "hi" }]);
  });
});

describe("reconcileDesignerState", () => {
  it("lets a stale fetch through untouched when no toggle is pending", () => {
    const out = reconcileDesignerState(serverState(false));
    expect(out.enabled).toBe(false);
    expect(readDesignerState()?.enabled).toBe(false);
  });

  it("overrides a stale read that raced the toggle's save (the F1 race)", () => {
    recordDesignerToggle(true);
    // The GET was answered before the POST committed: server still says off.
    const out = reconcileDesignerState(serverState(false));
    expect(out.enabled).toBe(true);
    expect(readDesignerState()?.enabled).toBe(true);
  });

  it("keeps overriding until the server catches up, then trusts it again", () => {
    recordDesignerToggle(true);
    expect(reconcileDesignerState(serverState(false)).enabled).toBe(true);
    // Server caught up: the intent retires…
    expect(reconcileDesignerState(serverState(true)).enabled).toBe(true);
    // …so a later authoritative change (another tab flips it off) applies.
    expect(reconcileDesignerState(serverState(false)).enabled).toBe(false);
  });

  it("applies to a toggle-off just the same", () => {
    recordDesignerToggle(false);
    expect(reconcileDesignerState(serverState(true)).enabled).toBe(false);
  });
});

describe("revertDesignerToggle", () => {
  it("drops the intent and restores the previous value after a failed save", () => {
    recordDesignerToggle(true);
    revertDesignerToggle(false);
    expect(readDesignerState()?.enabled).toBe(false);
    // No intent left: server answers stand.
    expect(reconcileDesignerState(serverState(false)).enabled).toBe(false);
  });
});
