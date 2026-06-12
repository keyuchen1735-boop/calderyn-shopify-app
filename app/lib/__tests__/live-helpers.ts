// Shared gates + polling helper for the LIVE Meta test suites (*.live.test.ts).
// Live tests are env-gated: META_LIVE_TEST=1 enables the read-only suites,
// META_LIVE_MUTATE=1 additionally enables the reversible mutating suites, and
// the explicit campaign ids name the ONLY campaigns a test may mutate (paused,
// ad-set-free CBO test campaigns — no ad sets means nothing can ever deliver).
export const LIVE = process.env.META_LIVE_TEST === "1";
export const MUTATE = process.env.META_LIVE_MUTATE === "1";
export const liveShopDomain = process.env.META_LIVE_SHOP_DOMAIN ?? "";
export const liveShopId = process.env.META_LIVE_SHOP_ID ?? "";
export const liveSourceCampaignId = process.env.META_LIVE_SOURCE_CAMPAIGN_ID ?? "";
export const liveDestCampaignId = process.env.META_LIVE_DEST_CAMPAIGN_ID ?? "";

/**
 * Read a campaign's CBO daily budget, throwing if absent — a null here means
 * the target is not a campaign-budget campaign and must not be mutated (a
 * null fed to a finally-restore would post daily_budget "null" to Meta).
 */
export async function budgetCentsOrThrow(
  adapter: { getState: (id: string) => Promise<{ dailyBudgetCents: number | null }> },
  externalId: string,
): Promise<number> {
  const cents = (await adapter.getState(externalId)).dailyBudgetCents;
  if (cents == null) throw new Error(`campaign ${externalId} has no campaign-level daily budget (not CBO?)`);
  return cents;
}

// Poll pacing knobs. Every waitFor read is a real Graph API call against the
// ad account's ads-management rate budget (Meta code 80004 when exhausted) —
// raise META_LIVE_POLL_MS / lower the volume when the account is near it.
const POLL_MS = Number(process.env.META_LIVE_POLL_MS || 1000);
const WAIT_TIMEOUT_MS = Number(process.env.META_LIVE_WAIT_TIMEOUT_MS || 15000);

/**
 * Poll until `read()` returns `expected` — Meta's read-after-write is
 * eventually consistent, so an immediate read can return the stale value.
 * Returns the last observed value (== expected on success, or the final read
 * on timeout so the caller's assertion shows the real mismatch).
 */
export async function waitFor<T>(read: () => Promise<T>, expected: T, timeoutMs = WAIT_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = await read();
    if (last === expected || Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
