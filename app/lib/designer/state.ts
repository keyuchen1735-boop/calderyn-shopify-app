// Client-side designer engine-state store: the screen-cache entry plus the
// merchant's latest local toggle intent, reconciled against server fetches.
//
// Why intent tracking exists: flipping the sparkle in Settings writes
// store_settings.composer_enabled through a POST, but the Store screen also
// re-fetches designer state on its own mount. When the merchant toggles and
// navigates immediately, that GET can be answered from a snapshot taken
// BEFORE the POST committed — a stale `enabled:false` that used to clobber
// the freshly written cache and mount the wrong engine for the whole visit.
// The toggle therefore records its intent here first, and every fetched
// state is reconciled against it: while the server still reports the old
// value, the local intent wins; the first fetch that agrees with the intent
// retires it and the server becomes authoritative again.
import { cacheScreenData, cachedScreenData } from "~/lib/dashboard/screen-cache";
import type { DesignerStateVM } from "./client";

export const DESIGNER_STATE_CACHE_KEY = "designer-studio";

const EMPTY_STATE: DesignerStateVM = { enabled: false, ready: false, unbuiltRoutes: [], chat: [] };

/** The merchant's latest sparkle flip, until the server confirms it. */
let toggleIntent: boolean | null = null;

/** Last-known designer state, or null before any fetch or toggle. */
export function readDesignerState(): DesignerStateVM | null {
  return cachedScreenData<DesignerStateVM>(DESIGNER_STATE_CACHE_KEY);
}

/** Call SYNCHRONOUSLY when the sparkle is flipped, before the save request is
 *  even sent — a Store visit during the round-trip must already route to the
 *  chosen engine. */
export function recordDesignerToggle(next: boolean): void {
  toggleIntent = next;
  cacheScreenData(DESIGNER_STATE_CACHE_KEY, { ...(readDesignerState() ?? EMPTY_STATE), enabled: next });
}

/** The save request failed: the server flag never moved, so drop the intent
 *  and put the cache back on the previous value. */
export function revertDesignerToggle(previous: boolean): void {
  toggleIntent = null;
  cacheScreenData(DESIGNER_STATE_CACHE_KEY, { ...(readDesignerState() ?? EMPTY_STATE), enabled: previous });
}

/** Reconcile a fetched designer state against the local toggle intent and
 *  write the winner through the cache. A response that still disagrees with
 *  an unretired intent is a stale read (it raced the toggle's save); the
 *  intent keeps winning until the server catches up. */
export function reconcileDesignerState(fetched: DesignerStateVM): DesignerStateVM {
  if (toggleIntent !== null && fetched.enabled !== toggleIntent) {
    const effective = { ...fetched, enabled: toggleIntent };
    cacheScreenData(DESIGNER_STATE_CACHE_KEY, effective);
    return effective;
  }
  toggleIntent = null;
  cacheScreenData(DESIGNER_STATE_CACHE_KEY, fetched);
  return fetched;
}

/** Tests only — module state would otherwise leak between cases. */
export function resetDesignerToggleIntent(): void {
  toggleIntent = null;
}
