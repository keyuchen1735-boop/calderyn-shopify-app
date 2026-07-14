import { resolveStorefrontPolicyPath } from "../storefront/policies.server";

export interface StorefrontPolicyProofLink {
  id: string;
  href: string;
}

export interface StorefrontPolicyRouteResponse {
  status: number;
  policyId: string | null;
  contentType: string;
}

export async function verifyStorefrontPolicyRoutes(
  links: readonly StorefrontPolicyProofLink[],
  fetchRoute: (href: string) => Promise<StorefrontPolicyRouteResponse>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const link of links) {
    const policyId = link.href.startsWith("/") ? resolveStorefrontPolicyPath(new URL(link.href, "https://storefront.invalid").pathname) : null;
    if (!policyId || policyId !== link.id) {
      failures.push(`${link.href}:not-same-origin-policy-route`);
      continue;
    }
    const response = await fetchRoute(link.href);
    if (response.status !== 200) {
      failures.push(`${link.href}:status-${response.status}`);
    } else if (!response.contentType.toLowerCase().startsWith("text/html")) {
      failures.push(`${link.href}:content-type-${response.contentType || "missing"}`);
    } else if (response.policyId !== policyId) {
      failures.push(`${link.href}:policy-marker-${response.policyId ?? "missing"}`);
    }
  }
  return failures;
}
