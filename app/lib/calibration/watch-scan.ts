// Pure (browser-safe, no .server imports) builder for the Live Engine hero's
// per-rectangle scan tickers. Turns real SKU + campaign data into bounded name
// lists. Deterministic — no Date.now()/Math.random() — so it is unit-testable
// and stable across renders. `ret` is reserved: there is no real cohort source
// yet, so it stays empty and the hero falls back to a neutral activity line.
import type { LiveEnginePageData } from "./live-engine-types";

export type WatchScan = LiveEnginePageData["watchScan"];
export interface ScanSku {
  title: string;
  velocity?: number | null;
}
export interface ScanCampaign {
  name: string;
}

const CAP = 8;

function clean(names: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const s = (raw ?? "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= CAP) break;
  }
  return out;
}

export function buildWatchScan(skus: ScanSku[], campaigns: ScanCampaign[]): WatchScan {
  const inv = clean(skus.map((s) => s.title));
  const byVelocity = [...skus].sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0));
  let price = clean(byVelocity.map((s) => s.title));
  // Guarantee a visual difference from inv even when velocity is flat/equal:
  // rotate by half-length so the two rows never lead with the same name.
  if (price.length > 1 && price.every((n, i) => n === inv[i])) {
    const k = Math.floor(price.length / 2) || 1;
    price = [...price.slice(k), ...price.slice(0, k)];
  }
  const ads = clean(campaigns.map((c) => c.name));
  return { inv, price, ads, ret: [] };
}

/** Name to show in a row at a given tick: the list item (cycled), else an
 *  aspect-activity line (cycled), else empty. */
export function scanLineFor(list: string[], aspects: string[], idx: number): string {
  if (list.length) return list[((idx % list.length) + list.length) % list.length];
  if (aspects.length) return aspects[((idx % aspects.length) + aspects.length) % aspects.length];
  return "";
}
