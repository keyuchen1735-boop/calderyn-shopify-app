// Request-hash quote cache (#6.3). Idempotent re-quotes are cheap and stable: an
// identical request within the TTL returns the exact same ShippingQuote.
//
// CEILING (v1): this is a per-process in-memory Map. It does NOT coordinate across
// instances — a multi-instance deployment would have one cache per instance (a quote
// cached on instance A is invisible to instance B). A shared store (e.g. Redis) is
// the upgrade path when the engine runs multi-instance.
import type { ShippingQuote } from "./quote";

interface CacheEntry {
  quote: ShippingQuote;
  expiresAt: number; // epoch ms; entry is dead once now >= expiresAt.
}

export class QuoteCache {
  private store = new Map<string, CacheEntry>();

  /** Live quote for `key`, or null when absent/expired (expired entries are evicted). */
  get(key: string, nowMs: number): ShippingQuote | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (nowMs >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.quote;
  }

  set(key: string, quote: ShippingQuote, nowMs: number, ttlMs: number): void {
    this.store.set(key, { quote, expiresAt: nowMs + ttlMs });
  }
}
