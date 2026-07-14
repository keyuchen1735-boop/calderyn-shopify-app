import { describe, expect, it, vi } from "vitest";
import { verifyStorefrontPolicyRoutes } from "./policy-routes";

describe("browser proof policy routes", () => {
  it("fetches each exact same-origin policy route and verifies its rendered policy marker", async () => {
    const fetchRoute = vi.fn(async (href: string) => href.endsWith("/privacy")
      ? { status: 200, policyId: "privacy", contentType: "text/html; charset=utf-8" }
      : { status: 404, policyId: null, contentType: "text/plain" });

    const failures = await verifyStorefrontPolicyRoutes([
      { id: "privacy", href: "/storefront/policies/privacy" },
      { id: "refund", href: "/storefront/policies/refund" },
      { id: "shipping", href: "https://attacker.example/policy" },
    ], fetchRoute);

    expect(fetchRoute).toHaveBeenCalledTimes(2);
    expect(failures).toEqual([
      "/storefront/policies/refund:status-404",
      "https://attacker.example/policy:not-same-origin-policy-route",
    ]);
  });
});
