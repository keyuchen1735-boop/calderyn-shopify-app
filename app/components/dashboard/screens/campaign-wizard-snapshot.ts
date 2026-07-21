// Snapshot the campaign wizard across a provider-connect full-page round-trip:
// leaving for the consent screen unloads the SPA, and losing the merchant's
// step/product/budget on return reads as the wizard forgetting them. The
// snapshot lives in sessionStorage (this tab only), is written just before
// navigating out, and is consumed by the next wizard mount. preflight is
// dropped both ways so the fresh connection is always re-checked on return.

const CONNECT_SNAPSHOT_KEY = "cd-campaign-wizard-connect";
const CONNECT_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

/** Structural minimum the snapshot round-trip needs from the wizard state. */
type SnapshotableState = {
  runId: string;
  step: string;
  budgetCents: number;
  preflight: unknown;
};

export function saveConnectSnapshot<T extends SnapshotableState>(state: T): void {
  try {
    sessionStorage.setItem(
      CONNECT_SNAPSHOT_KEY,
      JSON.stringify({ savedAt: Date.now(), state: { ...state, preflight: null } }),
    );
  } catch {
    // Storage unavailable (private mode / quota) — the connect still works,
    // the wizard just restarts on return.
  }
}

export function clearConnectSnapshot(): void {
  try {
    sessionStorage.removeItem(CONNECT_SNAPSHOT_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Read (without consuming — reducer initializers must stay pure) a fresh,
 * shape-valid snapshot, or null. The wizard's mount effect clears it, so one
 * departure buys exactly one restore. `validSteps` pins the step to the
 * caller's live step machine, so a corrupt/stale payload can never crash the
 * wizard; anything off falls back to a clean start.
 */
export function peekConnectSnapshot<T extends SnapshotableState>(
  validSteps: readonly string[],
): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(CONNECT_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: number; state?: T };
    const s = parsed?.state;
    if (!s || typeof parsed.savedAt !== "number") return null;
    if (Date.now() - parsed.savedAt > CONNECT_SNAPSHOT_TTL_MS) return null;
    if (typeof s.runId !== "string" || !s.runId) return null;
    if (!validSteps.includes(s.step)) return null;
    if (typeof s.budgetCents !== "number" || !Number.isFinite(s.budgetCents)) return null;
    return { ...s, preflight: null };
  } catch {
    return null;
  }
}
