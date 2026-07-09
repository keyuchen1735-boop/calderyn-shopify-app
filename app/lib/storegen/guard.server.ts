// app/lib/storegen/guard.server.ts
// Shared generate-time guard for both entry points that can trigger a store
// generation run (/dashboard/api/store's "generate" action and
// /dashboard/builder/generate.tsx): one rate limit, one brief cap, one
// mid-test refusal, so a merchant can't dodge one entry point's guard by
// hitting the other.
import { CalderynError } from "~/lib/calderyn.server";
import { rateLimit } from "~/lib/dashboard/http.server";
import { hasRunningExperiment } from "~/lib/experiments/store-experiment.server";
import { checkAiQuota } from "~/lib/ai-quota.server";

// A brief is a short prompt, not a document; the cap bounds LLM input spend
// (the brief is interpolated into several generation prompts per run).
const BRIEF_MAX = 4000;

/**
 * The cheap pre-checks: an oversized brief, the per-shop burst limit (5/60s,
 * shared across both call sites), and a regeneration mid-test (would rewrite
 * the drafts a later publish pushes over arm A of the running experiment).
 * Split from the daily quota so the multipart attach path can run these BEFORE
 * its intent-classification call without touching the designer allowance —
 * checkAiQuota records a hit at check time, so a needs_intent or products-only
 * outcome (no generation) must never consume one of the day's 5 base-tier
 * slots. The classification call itself is still model spend, bounded by the
 * burst limit here — an accepted tradeoff (one cheap Haiku call per burst slot).
 */
export async function assertGeneratePrechecks(
  shopId: string,
  brief: string | undefined,
): Promise<void> {
  if (typeof brief === "string" && brief.length > BRIEF_MAX) {
    throw new CalderynError({
      code: "brief_too_long",
      status: 422,
      message: "Keep the brief under 4,000 characters.",
    });
  }
  if (!(await rateLimit(`storegen:${shopId}`, 5, 60_000))) {
    throw new CalderynError({
      code: "rate_limited",
      status: 429,
      message: "Too many generations. Please wait a moment.",
    });
  }
  if (await hasRunningExperiment(shopId)) {
    throw new CalderynError({
      code: "experiment_running",
      status: 409,
      message: "An experiment is running on your store. Decide it before rebuilding.",
    });
  }
}

/**
 * The daily "designer" AI quota. checkAiQuota RECORDS the hit as it checks
 * (cooldown + daily buckets), so call this only once a generation run is
 * certain — never for classification-only or products-only outcomes.
 */
export async function assertDesignerQuota(
  shopId: string,
  opts: { trusted: boolean },
): Promise<void> {
  const quota = await checkAiQuota({ shopId, feature: "designer", trusted: opts.trusted });
  if (!quota.allowed) {
    throw new CalderynError({ code: quota.code, status: 429, message: quota.message });
  }
}

/**
 * Refuses a generation before any paid Anthropic call: the pre-checks above,
 * then the daily AI quota — checked last so requests refused for any other
 * reason never burn the day's allowance. Throws a CalderynError; callers map
 * it to their own response shape (dashboardJson already does this for the API
 * route).
 */
export async function assertCanGenerate(
  shopId: string,
  brief: string | undefined,
  opts: { trusted: boolean },
): Promise<void> {
  await assertGeneratePrechecks(shopId, brief);
  await assertDesignerQuota(shopId, opts);
}
