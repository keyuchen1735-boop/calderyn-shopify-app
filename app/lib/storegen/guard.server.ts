// app/lib/storegen/guard.server.ts
// Shared generate-time guard for both entry points that can trigger a store
// generation run (/dashboard/api/store's "generate" action and
// /dashboard/builder/generate.tsx): one rate limit, one brief cap, one
// mid-test refusal, so a merchant can't dodge one entry point's guard by
// hitting the other.
import { CalderynError } from "~/lib/calderyn.server";
import { rateLimit } from "~/lib/dashboard/http.server";
import { expireOverdueExperiment, hasRunningExperiment } from "~/lib/experiments/store-experiment.server";
import { checkAiQuota } from "~/lib/ai-quota.server";
import { createHash, randomUUID } from "node:crypto";

// A brief is a short prompt, not a document; the cap bounds LLM input spend
// (the brief is interpolated into several generation prompts per run).
const BRIEF_MAX = 4000;

/**
 * The cheap pre-checks: an oversized brief, the per-shop burst limit (5/60s,
 * shared across both call sites), and a regeneration mid-test (would rewrite
 * the drafts a later publish pushes over arm A of the running experiment).
 * Split from the designer cooldown so the multipart attach path can run these
 * before intent classification without making a needs_intent response delay
 * the merchant's follow-up generation request.
 */
export async function assertGeneratePrechecks(
  shopId: string,
  brief: string | undefined,
  opts?: { skipExperimentCheck?: boolean },
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
  // A test past its max duration decides itself here, so an abandoned
  // experiment can never block regeneration forever (failure-isolated inside).
  // Draft-only surfaces (the designer's chat edits) skip the experiment gate:
  // they never touch what shoppers see until an explicit publish, and the
  // designer publish path carries its own experiment check.
  if (opts?.skipExperimentCheck) return;
  await expireOverdueExperiment(shopId);
  if (await hasRunningExperiment(shopId)) {
    throw new CalderynError({
      code: "experiment_running",
      status: 409,
      message: "An experiment is running on your store. Decide it before rebuilding.",
    });
  }
}

/**
 * The designer AI cooldown. Call this only once a generation run is certain —
 * never for classification-only or products-only outcomes.
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
 * then the designer cooldown. Throws a CalderynError; callers map it to their
 * own response shape (dashboardJson already does this for the API route).
 */
export async function assertCanGenerate(
  shopId: string,
  brief: string | undefined,
  opts: { trusted: boolean; skipExperimentCheck?: boolean },
): Promise<void> {
  await assertGeneratePrechecks(shopId, brief, { skipExperimentCheck: opts.skipExperimentCheck });
  await assertDesignerQuota(shopId, opts);
}

interface GenerateQuotaReservation {
  shopId: string;
  promptHash: string;
  expiresAt: number;
}

const reservationStore = globalThis as typeof globalThis & {
  __storefrontGenerateQuotaReservations?: Map<string, GenerateQuotaReservation>;
};
const reservations = reservationStore.__storefrontGenerateQuotaReservations ??= new Map();
const RESERVATION_TTL_MS = 15 * 60_000;

function promptHash(prompt: string | undefined): string {
  return createHash("sha256").update(prompt ?? "").digest("hex");
}

/** Consume the paid quota before a streaming response is opened and return a
 * one-use capability carried only inside the server-side prepared build. */
export async function reserveGenerateQuota(
  shopId: string,
  prompt: string | undefined,
  opts: { trusted: boolean },
): Promise<string> {
  await assertCanGenerate(shopId, prompt, opts);
  const now = Date.now();
  for (const [token, reservation] of reservations) if (reservation.expiresAt <= now) reservations.delete(token);
  const token = randomUUID();
  reservations.set(token, { shopId, promptHash: promptHash(prompt), expiresAt: now + RESERVATION_TTL_MS });
  return token;
}

export function consumeGenerateQuotaReservation(input: {
  token: string;
  shopId: string;
  prompt: string | undefined;
}): void {
  const reservation = reservations.get(input.token);
  reservations.delete(input.token);
  if (!reservation || reservation.expiresAt <= Date.now() || reservation.shopId !== input.shopId ||
    reservation.promptHash !== promptHash(input.prompt)) {
    throw new CalderynError({
      code: "invalid_quota_reservation",
      status: 409,
      message: "This storefront generation reservation expired. Start the build again.",
    });
  }
}
