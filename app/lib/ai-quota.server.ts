// app/lib/ai-quota.server.ts
//
// Per-shop daily caps + cooldowns for the paid Anthropic endpoints (store
// designer, assistant, listing drafts), layered on the same Postgres
// fixed-window limiter as the existing per-minute burst caps. The daily
// window is 86,400s and epoch-aligned, so allowances reset at midnight UTC.
//
// Like rate_limit_touch itself this fails OPEN — quota is spend-abuse
// defense-in-depth; the Anthropic workspace spend limit is the hard backstop.
import { rateLimit } from "./rate-limit.server";

export type AiFeature = "designer" | "assistant" | "listing";

type QuotaConfig = {
  cooldownMs: number;
  daily: { base: number; trusted: number };
};

// Caps are sized so a genuine evaluator never notices them while a scripted
// account is bounded to roughly a dollar of spend per day.
const QUOTAS: Record<AiFeature, QuotaConfig> = {
  // Store generation is a multi-prompt run — the most expensive call in the
  // product. A real merchant redesigns a handful of times, not dozens.
  designer: { cooldownMs: 20_000, daily: { base: 5, trusted: 20 } },
  // Chat turns are cheap individually; the cap exists to stop scripts, not
  // to meter humans.
  assistant: { cooldownMs: 4_000, daily: { base: 30, trusted: 300 } },
  // Listing drafts sit between the two in cost and frequency.
  listing: { cooldownMs: 3_000, daily: { base: 30, trusted: 200 } },
};

const DAY_MS = 86_400_000;
const TRUST_AGE_MS = 7 * DAY_MS;

export type QuotaVerdict =
  | { allowed: true }
  | { allowed: false; code: "ai_cooldown" | "ai_daily_limit"; message: string };

/**
 * Record one hit for `feature` against the shop's cooldown and daily buckets
 * and report whether the request may proceed. Cooldown is checked first so a
 * hammering client burns its own cooldown window, not the shop's daily
 * allowance.
 */
export async function checkAiQuota(opts: {
  shopId: string;
  feature: AiFeature;
  trusted: boolean;
}): Promise<QuotaVerdict> {
  const cfg = QUOTAS[opts.feature];
  const cd = await rateLimit(`ai:cd:${opts.feature}:${opts.shopId}`, 1, cfg.cooldownMs);
  if (!cd) {
    return {
      allowed: false,
      code: "ai_cooldown",
      message: `Going a little fast — try again in ${Math.ceil(cfg.cooldownMs / 1000)} seconds.`,
    };
  }
  const cap = opts.trusted ? cfg.daily.trusted : cfg.daily.base;
  const day = await rateLimit(`ai:day:${opts.feature}:${opts.shopId}`, cap, DAY_MS);
  if (!day) {
    return {
      allowed: false,
      code: "ai_daily_limit",
      message: "You've hit today's limit for this feature. It resets at midnight UTC.",
    };
  }
  return { allowed: true };
}

/**
 * Trusted tier gets the higher daily caps: Shopify-embedded sessions (the app
 * is installed on a real store; `userId` is null by construction) and
 * first-party accounts older than seven days. Email verification is not a
 * tier — it is already a hard gate at the API door.
 */
export function quotaTrusted(session: {
  userId: string | null;
  accountCreatedAt: string | null;
}): boolean {
  if (session.userId === null) return true;
  const created = session.accountCreatedAt ? Date.parse(session.accountCreatedAt) : NaN;
  return Number.isFinite(created) && Date.now() - created >= TRUST_AGE_MS;
}
