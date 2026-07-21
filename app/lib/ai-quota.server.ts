// app/lib/ai-quota.server.ts
//
// Per-shop cooldowns for the paid Anthropic endpoints, plus daily caps for
// assistant and listing drafts. These use the same Postgres fixed-window
// limiter as the existing per-minute burst caps.
//
// Like rate_limit_touch itself this fails OPEN — quota is spend-abuse
// defense-in-depth; the Anthropic workspace spend limit is the hard backstop.
import { rateLimit } from "./rate-limit.server";

export type AiFeature = "designer" | "assistant" | "listing" | "radar" | "radar_apply";

type QuotaConfig = {
  cooldownMs: number;
  daily?: { base: number; trusted: number };
};

const QUOTAS: Record<AiFeature, QuotaConfig> = {
  // Store generation stays unlimited across the day; the cooldown prevents
  // accidental duplicate submissions.
  designer: { cooldownMs: 20_000 },
  // Chat turns are cheap individually; the cap exists to stop scripts, not
  // to meter humans.
  assistant: { cooldownMs: 4_000, daily: { base: 30, trusted: 300 } },
  // Listing drafts sit between the two in cost and frequency.
  listing: { cooldownMs: 3_000, daily: { base: 30, trusted: 200 } },
  // Radar's overnight drafter: no human in the loop, calls run back-to-back
  // inside one cron tick, so a cooldown would only false-block call 2 of 5.
  // The 5/night spec cap IS the daily bucket; the drafter also hard-caps its
  // own loop so quota-bypassed (dev) shops cannot overspend either.
  radar: { cooldownMs: 0, daily: { base: 5, trusted: 5 } },
  // A merchant clicking Apply on a drafted move. Deliberately a SEPARATE
  // bucket from `radar`: sharing one meant the drafter's 5-attempt overnight
  // run could exhaust the day's allowance before the merchant ever saw the
  // dashboard, 429ing their morning Apply. No human-facing cooldown either -
  // a merchant applying several moves back-to-back is normal use, not abuse.
  radar_apply: { cooldownMs: 0, daily: { base: 10, trusted: 10 } },
};

const DAY_MS = 86_400_000;
const TRUST_AGE_MS = 7 * DAY_MS;

export type QuotaVerdict =
  | { allowed: true }
  | { allowed: false; code: "ai_cooldown" | "ai_daily_limit"; message: string };

/**
 * Shops that skip all AI caps: local development and any shop id in
 * AI_QUOTA_BYPASS_SHOPS
 * (comma-separated). The allowlist lives in the deployment env, not source, so
 * exempting an account is a config change; empty allowlist = every shop capped.
 * ponytail: env allowlist; move to a shop_settings flag if it outgrows a handful.
 */
function isQuotaBypassed(shopId: string): boolean {
  if (process.env.NODE_ENV === "development") return true;
  const raw = process.env.AI_QUOTA_BYPASS_SHOPS;
  return !!raw && raw.split(",").some((s) => s.trim() === shopId);
}

/**
 * Record one hit for `feature` against the shop's cooldown and optional daily
 * bucket and report whether the request may proceed.
 */
export async function checkAiQuota(opts: {
  shopId: string;
  feature: AiFeature;
  trusted: boolean;
}): Promise<QuotaVerdict> {
  if (isQuotaBypassed(opts.shopId)) return { allowed: true };
  const cfg = QUOTAS[opts.feature];
  if (cfg.cooldownMs > 0) {
    const cd = await rateLimit(`ai:cd:${opts.feature}:${opts.shopId}`, 1, cfg.cooldownMs);
    if (!cd) {
      return {
        allowed: false,
        code: "ai_cooldown",
        message: `Going a little fast — try again in ${Math.ceil(cfg.cooldownMs / 1000)} seconds.`,
      };
    }
  }
  if (!cfg.daily) return { allowed: true };
  const cap = opts.trusted ? cfg.daily.trusted : cfg.daily.base;
  const day = await rateLimit(`ai:day:${opts.feature}:${opts.shopId}`, cap, DAY_MS);
  if (!day) {
    return {
      allowed: false,
      code: "ai_daily_limit",
      // First-use-relative phrasing, not a claimed midnight-UTC reset: the
      // window is a fixed UTC-day bucket, but merchants read "midnight UTC"
      // as needing to convert their own timezone to figure out when that is.
      message: "You've hit today's limit for this feature. It resets about 24 hours after you started.",
    };
  }
  return { allowed: true };
}

/**
 * Trusted tier gets the higher configured daily caps: Shopify-embedded
 * sessions (the app is installed on a real store; `userId` is null by
 * construction) and
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
