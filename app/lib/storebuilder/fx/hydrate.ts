// app/lib/storebuilder/fx/hydrate.ts
// Client entry point for the rawHtml effect channels. The sanitized storefront
// fragment carries optional motion attributes on its own elements; this
// walks the freshly-rendered fragment and mounts that runtime. Called only from
// a client effect, so it is a no-op on the
// server by construction.
//
// The motion runtime (and its gsap dependency) loads on demand: a page whose
// markup has no data-fx-motion host never fetches that chunk.
const MOTION_LIMIT = 8;

export function hydrateStoreFx(root: HTMLElement): () => void {
  if (typeof window === "undefined") return () => {};
  // Guard against a second pass over an already-hydrated fragment.
  if (root.dataset.fxHydrated === "1") return () => {};
  root.dataset.fxHydrated = "1";

  const cleanups: Array<() => void> = [];
  let disposed = false;

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
