// app/lib/storebuilder/fx/hydrate.test.ts
// Pins the lazy-load contract: the motion runtime (which carries gsap) is only
// imported when the fragment actually contains a data-fx-motion host, and a
// cleanup that runs before the chunk resolves mounts nothing. jsdom is not a
// dependency of this repo, so a minimal root stub covers the two DOM touchpoints
// hydrateStoreFx uses (dataset + querySelectorAll).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hydrateStoreFx } from "./hydrate";

const state = vi.hoisted(() => ({
  motionChunkLoaded: false,
  applyMotionCalls: 0,
  motionCleanupCalls: 0,
}));

// The factory runs only when ./motion is first imported — hydrate.ts has no
// static import of it, so this doubles as the chunk-load probe.
vi.mock("./motion", () => {
  state.motionChunkLoaded = true;
  return {
    parseMotionSpec: (raw: string) => (raw ? { to: { opacity: 1 } } : null),
    applyMotion: () => {
      state.applyMotionCalls += 1;
      return () => {
        state.motionCleanupCalls += 1;
      };
    },
  };
});

interface FakeHost {
  dataset: Record<string, string | undefined>;
}

function makeRoot(motionHosts: FakeHost[]): HTMLElement {
  const root = {
    dataset: {} as Record<string, string | undefined>,
    querySelectorAll(selector: string) {
      return selector === "[data-fx-motion]" ? motionHosts : [];
    },
  };
  return root as unknown as HTMLElement;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("hydrateStoreFx motion lazy-loading", () => {
  beforeEach(() => {
    // hydrateStoreFx bails on the server; these tests exercise the client path.
    vi.stubGlobal("window", {});
    state.applyMotionCalls = 0;
    state.motionCleanupCalls = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Ordering matters within this file: the chunk-load flag is monotonic once the
  // mocked module is in the registry, so the "never loads" case runs first.
  it("never imports the motion runtime for a fragment with no motion hosts", async () => {
    const cleanup = hydrateStoreFx(makeRoot([]));
    await tick();
    expect(state.motionChunkLoaded).toBe(false);
    expect(state.applyMotionCalls).toBe(0);
    cleanup();
  });

  it("mounts nothing when cleaned up before the motion chunk resolves", async () => {
    const cleanup = hydrateStoreFx(makeRoot([{ dataset: { fxMotion: "{}" } }]));
    cleanup(); // unmount races the in-flight import
    await tick();
    expect(state.motionChunkLoaded).toBe(true);
    expect(state.applyMotionCalls).toBe(0);
  });

  it("mounts motion hosts once the chunk resolves and disposes them on cleanup", async () => {
    const cleanup = hydrateStoreFx(makeRoot([{ dataset: { fxMotion: "{}" } }, { dataset: { fxMotion: "{}" } }]));
    await tick();
    expect(state.applyMotionCalls).toBe(2);
    cleanup();
    expect(state.motionCleanupCalls).toBe(2);
  });

  it("skips a fragment that is already hydrated", async () => {
    const root = makeRoot([{ dataset: { fxMotion: "{}" } }]);
    const first = hydrateStoreFx(root);
    const second = hydrateStoreFx(root);
    await tick();
    expect(state.applyMotionCalls).toBe(1);
    second();
    first();
  });
});
