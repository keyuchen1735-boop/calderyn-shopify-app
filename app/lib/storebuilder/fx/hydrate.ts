// app/lib/storebuilder/fx/hydrate.ts
// Client entry point for the rawHtml effect channels. The generator's sanitized
// HTML fragment carries `data-fx-shader` / `data-fx-motion` attributes on its own
// elements; this walks the freshly-rendered fragment and mounts the trusted
// runtimes onto them. Called only from a client effect, so it is a no-op on the
// server by construction.
//
// The motion runtime (and its gsap dependency) loads on demand: a page whose
// markup has no data-fx-motion host never fetches that chunk.
import { mountShader } from "./shader";

const SHADER_LIMIT = 2;
const MOTION_LIMIT = 8;

export function hydrateStoreFx(root: HTMLElement): () => void {
  if (typeof window === "undefined") return () => {};
  // Guard against a second pass over an already-hydrated fragment.
  if (root.dataset.fxHydrated === "1") return () => {};
  root.dataset.fxHydrated = "1";

  const cleanups: Array<() => void> = [];
  let disposed = false;

  const shaderHosts = Array.from(root.querySelectorAll<HTMLElement>("[data-fx-shader]")).slice(0, SHADER_LIMIT);
  for (const host of shaderHosts) {
    const cleanup = mountShader(host);
    if (cleanup) cleanups.push(cleanup);
  }

  const motionHosts = Array.from(root.querySelectorAll<HTMLElement>("[data-fx-motion]")).slice(0, MOTION_LIMIT);
  if (motionHosts.length > 0) {
    import("./motion")
      .then(({ parseMotionSpec, applyMotion }) => {
        // Unmounted while the chunk was in flight: mount nothing.
        if (disposed) return;
        for (const host of motionHosts) {
          const spec = parseMotionSpec(host.dataset.fxMotion ?? "");
          if (spec) cleanups.push(applyMotion(host, spec));
        }
      })
      .catch(() => {
        // Chunk fetch failed (offline, stale deploy): motion is a progressive
        // enhancement, so the markup simply stays static. The browser has
        // already logged the underlying network error.
      });
  }

  return () => {
    disposed = true;
    for (const cleanup of cleanups) cleanup();
    delete root.dataset.fxHydrated;
  };
}
