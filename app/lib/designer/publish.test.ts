import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishDesignerSite } from "./publish.server";

const { getSupabase, requirePublishableTenantDomain, expireOverdueExperiment, hasRunningExperiment } =
  vi.hoisted(() => ({
    getSupabase: vi.fn(),
    requirePublishableTenantDomain: vi.fn(),
    expireOverdueExperiment: vi.fn(),
    hasRunningExperiment: vi.fn(),
  }));

vi.mock("~/lib/supabase.server", () => ({ getSupabase }));
vi.mock("~/lib/storebuilder/studio.server", () => ({ requirePublishableTenantDomain }));
vi.mock("~/lib/experiments/store-experiment.server", () => ({
  expireOverdueExperiment,
  hasRunningExperiment,
}));

const SHOP = "00000000-0000-0000-0000-000000000010";

function installRows(rows: Array<Record<string, unknown>>) {
  const publicationUpsert = vi.fn().mockResolvedValue({ error: null });
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn().mockResolvedValue({ data: rows, error: null }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  getSupabase.mockReturnValue({
    from: (table: string) =>
      table === "designer_documents" ? query : { upsert: publicationUpsert },
  });
  return { publicationUpsert };
}

beforeEach(() => {
  vi.clearAllMocks();
  expireOverdueExperiment.mockResolvedValue(undefined);
  hasRunningExperiment.mockResolvedValue(false);
  requirePublishableTenantDomain.mockResolvedValue("https://maple.example/storefront");
});

describe("publishDesignerSite imagery recovery gate", () => {
  it("refuses any relevant route saved as built=false and names its Studio page", async () => {
    const { publicationUpsert } = installRows([
      { route: "home", html: "<main>ok</main>", css: "", template_id: "scratch", built: true },
      { route: "search", html: "<main>repairing</main>", css: "", template_id: "scratch", built: false },
    ]);

    await expect(publishDesignerSite(SHOP)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("Search (/storefront/search)"),
    });
    expect(publicationUpsert).not.toHaveBeenCalled();
  });

  it("names every affected merchant page and broken path in the 422", async () => {
    installRows([
      {
        route: "home",
        html: '<img src="/storefront-recipes/candle-home.jpg">',
        css: "",
        template_id: "ritual-almanac",
        built: true,
      },
      {
        route: "search",
        html: '<img src="/storefront-recipes/candle-search.jpg">',
        css: "",
        template_id: "ritual-almanac",
        built: true,
      },
    ]);

    await expect(publishDesignerSite(SHOP)).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(
        /Home \(\/storefront\).*candle-home\.jpg[\s\S]*Search \(\/storefront\/search\).*candle-search\.jpg/,
      ),
    });
  });
});
