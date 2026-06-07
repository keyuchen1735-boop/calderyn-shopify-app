// Bounded-concurrency map with per-item failure isolation. Used by the ingest
// cron so one shop/adapter failure never aborts the rest, and so we never fan
// out into hundreds of simultaneous ad-platform calls (thundering herd).

export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export async function mapWithConcurrency<I, T>(
  items: readonly I[],
  limit: number,
  worker: (item: I, index: number) => Promise<T>,
): Promise<Settled<T>[]> {
  const results = new Array<Settled<T>>(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length || 1));

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: size }, run));
  return results;
}
