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
 * Refuses a generation before any paid Anthropic call: an oversized brief,
 * the per-shop burst limit (5/60s, shared across both call sites), a
 * regeneration mid-test (would rewrite the drafts a later publish pushes
 * over arm A of the running experiment), and finally the daily AI quota —
 * checked last so requests refused for any other reason never burn the
 * day's allowance. Throws a CalderynError; callers map it to their own
 * response shape (dashboardJson already does this for the API route).
 */
export async function assertCanGenerate(
  shopId: string,
  brief: string | undefined,
  opts: { trusted: boolean },
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
      message: "An experiment is running on your home page. Decide it before rebuilding.",
    });
  }
  const quota = await checkAiQuota({ shopId, feature: "designer", trusted: opts.trusted });
  if (!quota.allowed) {
    throw new CalderynError({ code: quota.code, status: 429, message: quota.message });
  }
}
