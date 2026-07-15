// app/lib/storefront/vercel-domain.server.ts
//
// Attaches <org_slug>.calderyncompany.com to the Vercel project at shop
// provisioning. Wildcard DNS (*.calderyncompany.com) already points the zone
// at Vercel, but Vercel only serves hostnames registered on the project — so
// each new tenant needs this one API call before its storefront URL passes
// TLS. Automates the manual `vercel domains add` step in docs/DOMAINS.md.
//
// Best-effort by contract: returns false on any failure and never throws,
// because a Vercel hiccup must not fail signup. Failed registrations can be
// replayed with scripts/backfill-tenant-domains.mjs.

const TENANT_ZONE = "calderyncompany.com";
const REQUEST_TIMEOUT_MS = 5_000;

// Vercel error codes that mean the hostname is already attached (re-provision,
// manual add, backfill overlap) — success for our purposes. Live-verified
// 2026-07-05: re-adding a domain this project already owns returns 409
// "domain_already_in_use".
const BENIGN_CODES = new Set([
  "domain_already_in_use",
  "domain_already_exists",
  "domain_already_in_use_by_project",
]);

export function tenantDomain(orgSlug: string): string {
  return `${orgSlug}.${TENANT_ZONE}`;
}

/** A successful app health check on the tenant hostname proves working TLS and
 * routing to this Vercel project without creating a synthetic storefront view. */
export async function isTenantDomainReachable(orgSlug: string): Promise<boolean> {
  try {
    const response = await fetch(`https://${tenantDomain(orgSlug)}/healthz`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function registerTenantDomain(orgSlug: string): Promise<boolean> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    console.warn("[tenant-domain] VERCEL_TOKEN unset — skipping domain registration", {
      orgSlug,
    });
    return false;
  }
  const project = process.env.VERCEL_PROJECT_ID || "shopify-app";
  const teamId = process.env.VERCEL_TEAM_ID;
  const qs = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
  const name = tenantDomain(orgSlug);
  try {
    const res = await fetch(
      `https://api.vercel.com/v10/projects/${encodeURIComponent(project)}/domains${qs}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (res.ok) return true;
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    const code = body?.error?.code ?? "";
    if (BENIGN_CODES.has(code)) return true;
    console.error("[tenant-domain] Vercel domain add failed", {
      domain: name,
      status: res.status,
      code,
      message: body?.error?.message,
    });
    return false;
  } catch (e) {
    console.error("[tenant-domain] Vercel domain add errored", {
      domain: name,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}
