// Pure parsing of a Shopify landing_site URL into UTM params + ad click-IDs.
// Untrusted input: values are capped and malformed URLs degrade to empty —
// never throws (rule 12: a bad URL must not abort order ingestion).

import type { Utm, ClickIds, ClickIdKind, Platform } from "./types";

const MAX_LEN = 512;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
const CLICK_KEYS: ClickIdKind[] = ["fbclid", "gclid", "ttclid"];

const CLICK_PLATFORM: Record<ClickIdKind, Platform> = {
  fbclid: "meta",
  gclid: "google",
  ttclid: "tiktok",
};

export function clickIdPlatform(kind: ClickIdKind): Platform {
  return CLICK_PLATFORM[kind];
}

function clean(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.slice(0, MAX_LEN);
  return trimmed.length ? trimmed : null;
}

export function parseLandingSite(landingSite: string | null): { utm: Utm; clickIds: ClickIds } {
  const utm: Utm = {};
  const clickIds: ClickIds = {};
  if (!landingSite) return { utm, clickIds };

  // Resolve against a dummy base so relative paths ("/products/x?...") parse.
  let params: URLSearchParams;
  try {
    params = new URL(landingSite, "https://placeholder.invalid").searchParams;
  } catch {
    return { utm, clickIds };
  }

  for (const key of UTM_KEYS) {
    const v = clean(params.get(key));
    if (v) utm[key] = v;
  }
  for (const key of CLICK_KEYS) {
    const v = clean(params.get(key));
    if (v) clickIds[key] = v;
  }
  return { utm, clickIds };
}
