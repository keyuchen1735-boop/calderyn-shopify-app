// Client-safe integration metadata shared by the settings UI and its action.
//
// Two namespaces exist and must not be confused:
//   - `kind`     — the persisted shop_integrations key (e.g. "meta_ads").
//   - `provider` — the OAuth identity the connect/disconnect flow speaks
//                  (e.g. "meta"); see startOAuth/disconnect in calderyn.server.
// The settings list is keyed by `kind`, but connect/disconnect expect `provider`,
// so the UI maps one to the other before rendering buttons or submitting forms.

import type { Integration } from "./types";

/** Providers that have a wired OAuth connect flow (startOAuth handles these). */
export const OAUTH_PROVIDERS = ["meta", "google", "tiktok", "quickbooks"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/**
 * True when an integration has a stored credential — i.e. the merchant has
 * paired the account, whether it is actively synced ("connected") or still
 * running its first backfill ("pending"). Only a paired integration shows a
 * Disconnect (not a Connect) button.
 */
export function isPaired(status: Integration["status"]): boolean {
  return status === "connected" || status === "pending";
}

/**
 * Badge label + Polaris tone for an integration's pairing state. A pending
 * pairing reads as "Connected" (it IS paired) but with an info tone to signal
 * the initial sync is still running.
 */
export function integrationBadge(status: Integration["status"]): {
  label: string;
  tone: "success" | "info" | "attention";
} {
  if (status === "connected") return { label: "Connected", tone: "success" };
  if (status === "pending") return { label: "Connected", tone: "info" };
  return { label: "Not connected", tone: "attention" };
}

/** OAuth provider short-name -> persisted integration kind (inverse of KIND_TO_PROVIDER). */
const PROVIDER_TO_KIND: Record<string, string> = {
  meta: "meta_ads",
  google: "google_ads",
  tiktok: "tiktok_ads",
};

/**
 * Is the given OAuth provider (short name, e.g. "google") paired, looked up in
 * a kind-keyed integrations map? Bridges provider->kind first — the map is
 * keyed by kind ("google_ads"), so indexing it by the short name silently reads
 * undefined and reports every account as never-paired.
 */
export function providerPaired(
  integrations: Record<string, { status: Integration["status"] }>,
  provider: string,
): boolean {
  const kind = PROVIDER_TO_KIND[provider] ?? provider;
  const status = integrations[kind]?.status;
  return status ? isPaired(status) : false;
}

/** OAuth provider short-name -> display label, for post-OAuth redirect params. */
const PROVIDER_DISPLAY: Record<string, string> = {
  google: "Google Ads",
  meta: "Meta Ads",
  tiktok: "TikTok Ads",
  quickbooks: "QuickBooks",
};

/**
 * Read the one-shot post-OAuth redirect param the connect callbacks append
 * (e.g. `?google=connected`, or `?meta=error&reason=...`) into a connection
 * notice for the settings page to confirm a pairing, or null when absent.
 */
export function connectionNotice(
  params: URLSearchParams,
): { provider: string; ok: boolean; reason?: string } | null {
  for (const short of Object.keys(PROVIDER_DISPLAY)) {
    const value = params.get(short);
    if (value === "connected") {
      return { provider: PROVIDER_DISPLAY[short], ok: true, reason: undefined };
    }
    if (value === "error") {
      return {
        provider: PROVIDER_DISPLAY[short],
        ok: false,
        reason: params.get("reason") ?? undefined,
      };
    }
  }
  return null;
}

const KIND_TO_PROVIDER: Record<string, string> = {
  meta_ads: "meta",
  google_ads: "google",
  tiktok_ads: "tiktok",
};

/** Map a persisted integration `kind` to its OAuth `provider` short name. */
export function kindToProvider(kind: string): string {
  return KIND_TO_PROVIDER[kind] ?? kind;
}

/** True when the integration has a wired OAuth connect flow. */
export function isConnectable(kind: string): boolean {
  return (OAUTH_PROVIDERS as readonly string[]).includes(kindToProvider(kind));
}
