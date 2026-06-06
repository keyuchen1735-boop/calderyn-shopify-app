// Retry helper for ad-platform API calls. Retries ONLY rate-limit/throttle
// failures (surfaced as RateLimitError) with exponential backoff + jitter,
// honoring a server-provided Retry-After when available. Non-rate errors fail
// fast (rule 12: do not mask real failures behind retries).

export class RateLimitError extends Error {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  /** Injectable for tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter in [0,1); defaults to Math.random. */
  random?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RateLimitError)) throw err;
      lastErr = err;
      if (attempt === opts.maxAttempts) break;
      const expo = opts.baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.floor(random() * opts.baseDelayMs);
      await sleep(err.retryAfterMs ?? expo + jitter);
    }
  }
  throw lastErr;
}
