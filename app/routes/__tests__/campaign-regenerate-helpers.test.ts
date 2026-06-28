import { describe, it, expect, vi } from "vitest";

// app.campaigns.$campaignId.regenerate imports shopify.server (authenticate),
// which calls shopifyApp({ appUrl }) at module load and throws without
// SHOPIFY_APP_URL — stub it exactly like route-helpers.test.ts. From
// app/routes/__tests__/ the module path is "../../shopify.server".
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));

/* eslint-disable import/first -- imports must follow vi.mock */
import { parseRegenForm } from "../app.campaigns.$campaignId.regenerate";
import { parseRegenBody } from "../dashboard.api.campaigns.$id.regenerate";
import { DEFAULT_SPEND_CENTS, MIN_SPEND_CENTS } from "~/lib/screener/types";
/* eslint-enable import/first */

describe("parseRegenForm (embedded, FormData)", () => {
  function fd(entries: Record<string, string>): FormData {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  }
  it("parses a JSON adIds array and defaults spend", () => {
    const r = parseRegenForm(fd({ adIds: JSON.stringify(["a", "b"]) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.adIds).toEqual(["a", "b"]);
    expect(r.assumedSpendCents).toBe(DEFAULT_SPEND_CENTS);
  });
  it("drops blanks and rejects when no adIds remain", () => {
    expect(parseRegenForm(fd({ adIds: JSON.stringify(["", "  "]) })).ok).toBe(false);
    expect(parseRegenForm(fd({})).ok).toBe(false);
    expect(parseRegenForm(fd({ adIds: "not json" })).ok).toBe(false);
  });
  it("clamps spend", () => {
    const r = parseRegenForm(fd({ adIds: JSON.stringify(["a"]), assumedSpendCents: "1" }));
    expect(r.ok && r.assumedSpendCents).toBe(MIN_SPEND_CENTS);
  });
});

describe("parseRegenBody (dashboard, JSON)", () => {
  it("parses adIds array and defaults spend", () => {
    const r = parseRegenBody({ adIds: ["a", "b"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.adIds).toEqual(["a", "b"]);
    expect(r.assumedSpendCents).toBe(DEFAULT_SPEND_CENTS);
  });
  it("rejects empty/non-array adIds", () => {
    expect(parseRegenBody({}).ok).toBe(false);
    expect(parseRegenBody({ adIds: [] }).ok).toBe(false);
    expect(parseRegenBody({ adIds: "a" }).ok).toBe(false);
  });
  it("clamps spend", () => {
    const r = parseRegenBody({ adIds: ["a"], assumedSpendCents: 1 });
    expect(r.ok && r.assumedSpendCents).toBe(MIN_SPEND_CENTS);
  });
});
