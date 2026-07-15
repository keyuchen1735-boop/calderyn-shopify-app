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
// shippo (Phase 2) is a co-branded OAuth ship-cost connector (per-merchant token, contract
// C8). shiphero is NOT here: it is credential/token-based (refresh-token paste), so it lives
// in APIKEY_PROVIDERS below — see that comment.
export const OAUTH_PROVIDERS = ["meta", "google", "tiktok", "quickbooks", "shippo"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/**
 * OAuth providers whose connect handshake is NOT live yet — the app-side client isn't
 * registered, so an actual Connect would throw. Such a provider stays in OAUTH_PROVIDERS
 * (the eventual mechanism IS OAuth), but the settings card renders a disabled "Coming soon"
 * affordance instead of an active Connect button. Currently EMPTY: shiphero used to be here
 * under the (wrong) assumption it was OAuth — it is actually credential/refresh-token based,
 * so it moved to APIKEY_PROVIDERS and the "Coming soon" gate no longer applies to it.
 */
export const OAUTH_PENDING_PROVIDERS = [] as const;
export type OAuthPendingProvider = (typeof OAUTH_PENDING_PROVIDERS)[number];

/**
 * Providers whose connect mechanism is an API-KEY PASTE, not OAuth (contract C8).
 * EasyPost reads the merchant's existing account via a key they paste — there is
 * no app-level client id/secret and no redirect round-trip, so it is deliberately
 * NOT in OAUTH_PROVIDERS (isConnectable stays false for it). The settings card
 * branches on this set to render an inline key field instead of a Connect button.
 */
// shipbob (Phase 3 Part B) is a pasted Personal Access Token (billing_read scope), the
// same API-key model as EasyPost (C8) — deliberately NOT in OAUTH_PROVIDERS.
// shiphero (Phase 3 Part B) is credential/token-based, NOT OAuth: the merchant creates a
// dedicated "3rd Party Developer" user in ShipHero and pastes the issued REFRESH token —
// there is no authorize-redirect and no app client_id/secret. So it is a paste connector
// like EasyPost/ShipBob (the adapter mints a short-lived access token from the stored
// refresh token each run via /auth/refresh — a net-new token-refresh wrinkle).
export const APIKEY_PROVIDERS = ["easypost", "shipbob", "shiphero"] as const;
export type ApiKeyProvider = (typeof APIKEY_PROVIDERS)[number];

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
  // Paired before but the credential died — prompt a reconnect, don't read as
  // never-connected. isPaired stays false for "reauth", so the card re-renders
  // the Connect button (which is the reconnect affordance).
  if (status === "reauth") return { label: "Reconnect needed", tone: "attention" };
  return { label: "Not connected", tone: "attention" };
}

/** Provider short-name -> persisted integration kind (inverse of KIND_TO_PROVIDER). */
const PROVIDER_TO_KIND: Record<string, string> = {
  meta: "meta_ads",
  google: "google_ads",
  tiktok: "tiktok_ads",
  // Ship-cost connectors use the `<provider>_ship` kind (contract C9).
  easypost: "easypost_ship",
  shippo: "shippo_ship",
  shipbob: "shipbob_ship",
  shiphero: "shiphero_ship",
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

/**
 * Provider short-name -> display label, for the one-shot post-connect redirect
 * param. OAuth callbacks append `?<provider>=connected|error`; the API-key connect
 * action (EasyPost) reuses the same channel, so easypost is listed here too.
 */
const PROVIDER_DISPLAY: Record<string, string> = {
  google: "Google Ads",
  meta: "Meta Ads",
  tiktok: "TikTok Ads",
  quickbooks: "QuickBooks",
  easypost: "EasyPost",
  shippo: "Shippo",
  shipbob: "ShipBob",
  shiphero: "ShipHero",
};

/**
 * Read the one-shot post-OAuth redirect param the connect callbacks append
 * (e.g. `?google=connected`, or `?meta=error&reason=...`) into a connection
 * notice for the settings page to confirm a pairing, or null when absent.
 * `key` is the matched query param (the provider short name), so a consumer
 * that strips the one-shot params from the URL can remove exactly what it
 * consumed and leave unrelated params intact.
 */
export function connectionNotice(
  params: URLSearchParams,
): { key: string; provider: string; ok: boolean; reason?: string } | null {
  for (const short of Object.keys(PROVIDER_DISPLAY)) {
    const value = params.get(short);
    if (value === "connected") {
      return { key: short, provider: PROVIDER_DISPLAY[short], ok: true, reason: undefined };
    }
    if (value === "error") {
      return {
        key: short,
        provider: PROVIDER_DISPLAY[short],
        ok: false,
        reason: params.get("reason") ?? undefined,
      };
    }
  }
  return null;
}

/** Legacy dashboard OAuth returns opened Connectors from the dashboard root. */
export function shouldOpenConnectorsAfterOAuth(pathname: string): boolean {
  return pathname === "/dashboard" || pathname === "/dashboard/";
}

const KIND_TO_PROVIDER: Record<string, string> = {
  meta_ads: "meta",
  google_ads: "google",
  tiktok_ads: "tiktok",
  easypost_ship: "easypost",
  shippo_ship: "shippo",
  shipbob_ship: "shipbob",
  shiphero_ship: "shiphero",
};

/** Map a persisted integration `kind` to its OAuth `provider` short name. */
export function kindToProvider(kind: string): string {
  return KIND_TO_PROVIDER[kind] ?? kind;
}

/** True when the integration has a wired OAuth connect flow. */
export function isConnectable(kind: string): boolean {
  return (OAUTH_PROVIDERS as readonly string[]).includes(kindToProvider(kind));
}

/**
 * True when the integration is an OAuth provider whose handshake isn't live yet
 * (OAUTH_PENDING_PROVIDERS) — the card shows a disabled "Coming soon" badge instead of
 * an active Connect button. isConnectable still returns true for it, so callers that
 * render Connect must check this first.
 */
export function isOauthPending(kind: string): boolean {
  return (OAUTH_PENDING_PROVIDERS as readonly string[]).includes(kindToProvider(kind));
}

/**
 * True when the integration connects by an API-KEY PASTE (contract C8) rather
 * than OAuth — the settings card renders an inline key field + Save for these
 * instead of the OAuth Connect button. Mutually exclusive with isConnectable.
 */
export function isApiKeyConnect(kind: string): boolean {
  return (APIKEY_PROVIDERS as readonly string[]).includes(kindToProvider(kind));
}
