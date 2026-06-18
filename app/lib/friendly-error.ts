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
