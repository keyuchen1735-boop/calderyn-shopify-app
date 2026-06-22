// Refresh-on-focus: quietly re-fetch a surface's data the moment its tab becomes
// visible again, in place (no page reload). Pure decision core + thin React hook
// — same split as pollLiveTick / useLiveFeed.
import { useEffect, useRef } from "react";

export interface FocusRefresherOptions {
  /** Monotonic clock in ms (injected for tests; pass () => Date.now()). */
  now: () => number;
  /** Minimum gap between fires; rapid returns within this window are skipped. */
  minIntervalMs: number;
  /** The in-place refresh to run (e.g. Remix revalidate / dashboard refresh). */
  onRefresh: () => void;
}

export interface FocusRefresher {
  /** Call when the tab becomes visible / the window regains focus. */
  handleVisible: () => void;
}

/**
 * Pure cooldown gate. Fires onRefresh on the first call, then skips any call
 * landing within minIntervalMs of the last fire.
 */
export function createFocusRefresher(opts: FocusRefresherOptions): FocusRefresher {
  const { now, minIntervalMs, onRefresh } = opts;
  let lastFire = -Infinity;
  return {
    handleVisible() {
      const t = now();
      if (t - lastFire < minIntervalMs) return;
      lastFire = t;
      onRefresh();
    },
  };
}

export interface UseRefreshOnFocusOptions {
  /** When false the hook attaches nothing (e.g. dashboard "Live sync" off). */
  enabled?: boolean;
  /** Cooldown between focus-refreshes. */
  minIntervalMs?: number;
}

/**
 * Run `onRefresh` in place whenever the tab becomes visible again or the window
 * regains focus, throttled by a cooldown. Thin DOM glue over createFocusRefresher
 * (the tested part); mirrors useLiveFeed. The effect is client-only, so server
 * render never touches document/window.
 */
export function useRefreshOnFocus(
  onRefresh: () => void,
  { enabled = true, minIntervalMs = 10_000 }: UseRefreshOnFocusOptions = {},
): void {
  // Keep the latest callback in a ref so a changing onRefresh identity doesn't
  // tear down and rebind the listeners (and reset the cooldown) every render.
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    if (!enabled) return;

    const refresher = createFocusRefresher({
      // performance.now() is monotonic — measuring the cooldown with it can't be
      // skewed by a wall-clock (NTP/DST) jump the way Date.now() could.
      now: () => performance.now(),
      minIntervalMs,
      onRefresh: () => onRefreshRef.current(),
    });

    const onVisible = () => {
      if (document.visibilityState === "visible") refresher.handleVisible();
    };
    const onFocus = () => refresher.handleVisible();

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, minIntervalMs]);
}
