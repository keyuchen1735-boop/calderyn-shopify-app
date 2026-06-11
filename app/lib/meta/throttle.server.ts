// Client-side governor for Meta Graph API calls. Two layers, both per shop
// key and per process: a minimum interval between calls (burst smoothing) and
// a fixed-window hourly budget kept BELOW Meta's dev-tier ads-management
// limit (300 calls/rolling hour), so we self-throttle before Meta blocks the
// whole ad account (error code 80004). A budget overrun throws RateLimitError
// WITHOUT hitting Meta — visible to callers (rule 12) and classified
// transient by the executor, which parks the action for the retry cron.
// retryAfterMs is deliberately NOT set: withRetry would honor it and sleep
// until the window resets (up to an hour) inside a serverless invocation.
//
// Per-process state (same caveat as the dashboard API rate limiter): coarse
// abuse damping, not a distributed guarantee.

import { RateLimitError } from "../ads/backoff";
import type { MetaClient } from "./campaigns.server";

export interface MetaThrottleOptions {
  maxCallsPerHour: number;
  minIntervalMs: number;
  /** Injectable for tests; defaults to Date.now / real setTimeout. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const HOUR_MS = 3_600_000;

function envDefaults(): Pick<MetaThrottleOptions, "maxCallsPerHour" | "minIntervalMs"> {
  return {
    maxCallsPerHour: Number(process.env.META_MAX_CALLS_PER_HOUR || 250),
    minIntervalMs: Number(process.env.META_MIN_CALL_INTERVAL_MS || 200),
  };
}

interface Bucket {
  count: number;
  resetAt: number;
  lastCallAt: number;
  /** Serializes admissions per key so concurrent calls space correctly. */
  queue: Promise<void>;
}

const buckets = new Map<string, Bucket>();

export function __resetMetaThrottleForTests(): void {
  buckets.clear();
}

/** Wrap a MetaClient so every get/post is paced and budget-capped under `key`. */
export function throttleMetaClient(
  client: MetaClient,
  key: string,
  opts?: Partial<MetaThrottleOptions>,
): MetaClient {
  const o = { ...envDefaults(), ...opts };
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  function bucket(): Bucket {
    let b = buckets.get(key);
    if (!b) {
      b = { count: 0, resetAt: now() + HOUR_MS, lastCallAt: Number.NEGATIVE_INFINITY, queue: Promise.resolve() };
      buckets.set(key, b);
    }
    return b;
  }

  async function admit(): Promise<void> {
    const b = bucket();
    const turn = b.queue.then(async () => {
      const t = now();
      if (t >= b.resetAt) {
        b.count = 0;
        b.resetAt = t + HOUR_MS;
      }
      if (b.count >= o.maxCallsPerHour) {
        throw new RateLimitError(
          `Meta call budget self-throttled for ${key} (${b.count} of ${o.maxCallsPerHour} calls this hour)`,
        );
      }
      const wait = b.lastCallAt + o.minIntervalMs - t;
      if (wait > 0) await sleep(wait);
      b.count += 1;
      b.lastCallAt = now();
    });
    // Keep the chain alive past a rejected turn so later calls still admit.
    b.queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  return {
    async get(path, params) {
      await admit();
      return client.get(path, params);
    },
    async post(path, body) {
      await admit();
      return client.post(path, body);
    },
  };
}
