// Client-safe integration metadata shared by the settings UI and its action.
//
// Two namespaces exist and must not be confused:
//   - `kind`     — the persisted shop_integrations key (e.g. "meta_ads").
//   - `provider` — the OAuth identity the connect/disconnect flow speaks
//                  (e.g. "meta"); see startOAuth/disconnect in calderyn.server.
// The settings list is keyed by `kind`, but connect/disconnect expect `provider`,
// so the UI maps one to the other before rendering buttons or submitting forms.

/** Providers that have a wired OAuth connect flow (startOAuth handles these). */
export const OAUTH_PROVIDERS = ["meta", "google", "tiktok"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

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
