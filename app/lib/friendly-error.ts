// Turn raw provider/API error strings and unresolved ids into merchant-safe text
// for the action history. The raw error stays available behind the row's
// "details" expansion for support (P2-12). Pure module — safe on both surfaces.

export function friendlyActionError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (
    s.includes("does not exist") ||
    s.includes("invalid global id") ||
    s.includes("(code 100)") ||
    s.includes("unsupported")
  ) {
    return "Couldn't reach this on the ad platform — it may have been changed or deleted there.";
  }
  if (s.includes("developer_token") || s.includes("not approved")) {
    return "This ad platform connection isn't fully approved yet.";
  }
  if (
    s.includes("over_qps") ||
    s.includes("rate limit") ||
    s.includes("too many calls") ||
    s.includes("throttl")
  ) {
    return "The ad platform was busy — Calderyn will retry automatically.";
  }
  if (
    s.includes("access token") ||
    s.includes("expired") ||
    s.includes("oauth") ||
    s.includes("permission") ||
    s.includes("(code 190)") ||
    s.includes("(code 200)")
  ) {
    return "Calderyn's access to this platform needs reconnecting.";
  }
  return "The platform couldn't complete this action — see details.";
}

/**
 * Turn a raw integration `sync_error` (the provider/API string we persist to
 * shop_integrations.sync_error) into a plain-language line for the Settings and
 * dashboard integration cards. Returns null when there is no error to translate,
 * so callers can fall back to the account id / connected date.
 *
 * The raw string stays in shop_integrations.sync_error for support and
 * diagnosis; the merchant only ever sees this friendly form — same principle as
 * friendlyActionError / P2-12 ("never show a raw provider error string"). Order
 * matters: the specific Google Ads codes (CUSTOMER_NOT_ENABLED,
 * DEVELOPER_TOKEN_NOT_APPROVED) all contain the word "permission", so they are
 * matched before the generic permission fallback.
 */
export function friendlyIntegrationError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();

  // The merchant authorized a Google login whose Google Ads account isn't
  // usable: it was never finished/billed, or it has been deactivated.
  // Reconnecting the SAME account won't help — it has to be set up in Google Ads
  // first (or a different, active account reconnected).
  if (s.includes("customer_not_enabled")) {
    return "The Google account you connected doesn't have an active Google Ads account. Finish setting it up in Google Ads (including billing), then reconnect. If you have a different account, reconnect and choose that one.";
  }

  // Calderyn-side approval gate, not a merchant problem — don't tell them to reconnect.
  if (s.includes("developer_token") || s.includes("not approved")) {
    return "Google Ads access is still being approved on Calderyn's side. This connection will start syncing automatically once approval completes.";
  }

  // A dead, expired, or revoked credential: reconnecting fixes it. Covers the
  // Google invalid_grant token-exchange failure (a manual sync records it as a
  // plain "error"; the cron maps it to the "reauth" status upstream, which never
  // reaches here) AND the already-friendly "<provider> access was revoked"
  // sentence the QuickBooks cron records — both should read as one consistent
  // reconnect prompt. The card already shows the provider name separately.
  if (s.includes("invalid_grant") || s.includes("revoked") || s.includes("expired")) {
    return "This connection needs to be reconnected to resume syncing.";
  }

  // Other permission/access failures: likely the wrong account was granted, or
  // access was revoked on the provider's side.
  if (s.includes("permission") || s.includes("not_ads_user") || s.includes("unauthorized")) {
    return "Calderyn couldn't access this account. Reconnect and make sure you grant access to the right account.";
  }

  // Anything else: never dump the raw provider string at the merchant.
  return "We couldn't sync this connection. Reconnect, and contact support if it keeps happening.";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string | null | undefined): boolean {
  return typeof s === "string" && UUID_RE.test(s.trim());
}

/**
 * An audit row's target for display: a real campaign/SKU name passes through,
 * but a bare UUID (an id the engine didn't resolve to a name) is hidden rather
 * than shown raw to the merchant.
 */
export function displayAuditTarget(target: string | null | undefined): string {
  if (!target) return "";
  return isUuid(target) ? "" : target;
}
