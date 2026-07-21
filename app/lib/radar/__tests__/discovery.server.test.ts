import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  checkAiQuota: vi.fn(),
  isShowcaseShop: vi.fn(),
  countCompetitors: vi.fn(),
  insertSuggestion: vi.fn(),
  stampRadarState: vi.fn(),
  getStoreSettings: vi.fn(),
  getSeoSettings: vi.fn(),
  listProducts: vi.fn(),
  getShopStorefrontOrigin: vi.fn(),
}));
vi.mock("~/lib/assistant/anthropic.server", () => ({
  getAnthropic: () => ({ messages: { create: mocks.messagesCreate } }),
  radarDiscoveryModel: () => "test-model",
}));
vi.mock("~/lib/ai-quota.server", () => ({ checkAiQuota: mocks.checkAiQuota }));
vi.mock("~/lib/demo/showcase.server", () => ({ isShowcaseShop: mocks.isShowcaseShop }));
vi.mock("../competitor-store.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  countCompetitors: mocks.countCompetitors,
  insertSuggestion: mocks.insertSuggestion,
}));
vi.mock("../store.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stampRadarState: mocks.stampRadarState,
}));
vi.mock("~/lib/storefront/settings.server", () => ({ getStoreSettings: mocks.getStoreSettings }));
vi.mock("~/lib/seo/seo-store.server", () => ({ getSeoSettings: mocks.getSeoSettings }));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: () => ({ listProducts: mocks.listProducts }) }));
vi.mock("~/lib/storefront/shop.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getShopStorefrontOrigin: mocks.getShopStorefrontOrigin,
}));

// eslint-disable-next-line import/first -- hoisted mocks must be defined before imports
import { DISCOVERY_MAX_SEARCHES, discoverShopCompetitors } from "../discovery.server";

const SHOP = "11111111-1111-4111-8111-111111111111";

function textResponse(text: string, stopReason = "end_turn") {
  return { stop_reason: stopReason, content: [{ type: "text", text }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isShowcaseShop.mockResolvedValue(false);
  mocks.checkAiQuota.mockResolvedValue({ allowed: true });
  mocks.countCompetitors.mockResolvedValue(0);
  mocks.insertSuggestion.mockResolvedValue("inserted");
  mocks.stampRadarState.mockResolvedValue(undefined);
  mocks.getStoreSettings.mockResolvedValue({ storeName: "Peak & Pine", voiceTagline: null });
  mocks.getSeoSettings.mockResolvedValue({ orgDescription: "Outdoor gear for weekend hikers" });
  mocks.listProducts.mockResolvedValue([{ title: "Trail Boots" }, { title: "Summit Pack" }]);
  mocks.getShopStorefrontOrigin.mockResolvedValue("https://peak.calderyncompany.com");
  mocks.messagesCreate.mockResolvedValue(textResponse(JSON.stringify([
    { url: "https://rivalgear.example/collections/all", name: "Rival Gear", reason: "Sells hiking boots and packs" },
    { url: "https://peak.calderyncompany.com/", name: "Self", reason: "own store" },
    { url: "https://www.amazon.com/s?k=boots", name: "Amazon", reason: "marketplace" },
    { url: "not-a-url", name: "junk", reason: "" },
  ])));
});

describe("discoverShopCompetitors", () => {
  it("declares the web_search_20250305 server tool with max_uses and checks quota FIRST", async () => {
    const out = await discoverShopCompetitors(SHOP);
    expect(out).toEqual({ suggested: 1 });
    const req = mocks.messagesCreate.mock.calls[0][0];
    expect(req.model).toBe("test-model");
    expect(req.tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: DISCOVERY_MAX_SEARCHES },
    ]);
    expect(mocks.checkAiQuota).toHaveBeenCalledWith({ shopId: SHOP, feature: "radar_discovery", trusted: true });
    expect(mocks.checkAiQuota.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.messagesCreate.mock.invocationCallOrder[0]);
  });
  it("normalizes suggestions to the site origin, drops self + marketplaces + junk, writes suggested only", async () => {
    await discoverShopCompetitors(SHOP);
    expect(mocks.insertSuggestion).toHaveBeenCalledTimes(1);
    expect(mocks.insertSuggestion).toHaveBeenCalledWith(SHOP, expect.objectContaining({
      url: "https://rivalgear.example/",
      name: "Rival Gear",
    }));
    expect(mocks.stampRadarState).toHaveBeenCalledWith(SHOP, expect.objectContaining({
      lastDiscoveredAt: expect.any(String),
    }));
  });
  it("never runs for demo/fixture shops or when quota is exhausted", async () => {
    expect(await discoverShopCompetitors("demo-shop")).toEqual({ skipped: "fixture_shop" });
    mocks.isShowcaseShop.mockResolvedValue(true);
    expect(await discoverShopCompetitors(SHOP)).toEqual({ skipped: "demo_shop" });
    mocks.isShowcaseShop.mockResolvedValue(false);
    mocks.checkAiQuota.mockResolvedValue({ allowed: false, code: "ai_daily_limit", message: "cap" });
    expect(await discoverShopCompetitors(SHOP)).toEqual({ skipped: "ai_daily_limit" });
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
  });
  it("skips when the suggestion backlog is already full", async () => {
    mocks.countCompetitors.mockImplementation(async (_shop: string, status: string) =>
      status === "suggested" ? 5 : 0);
    expect(await discoverShopCompetitors(SHOP)).toEqual({ skipped: "suggestion_backlog" });
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
  });
  it("resumes pause_turn with single upfront quota check and survives junk JSON", async () => {
    mocks.messagesCreate
      .mockResolvedValueOnce({ stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }] })
      .mockResolvedValueOnce(textResponse(JSON.stringify([
        { url: "https://rivalgear.example/", name: "Rival Gear", reason: "similar" },
      ])));
    const out = await discoverShopCompetitors(SHOP);
    expect(out).toEqual({ suggested: 1 });
    expect(mocks.messagesCreate).toHaveBeenCalledTimes(2);
    expect(mocks.checkAiQuota).toHaveBeenCalledTimes(1);

    mocks.messagesCreate.mockReset();
    mocks.messagesCreate.mockResolvedValue(textResponse("sorry, no JSON here"));
    expect(await discoverShopCompetitors(SHOP)).toEqual({ suggested: 0 });
    expect(mocks.insertSuggestion).toHaveBeenCalledTimes(1); // only the earlier run
  });
  it("rejects http:// suggestions, accepts https:// only", async () => {
    mocks.messagesCreate.mockResolvedValue(textResponse(JSON.stringify([
      { url: "http://insecure.example/", name: "Insecure", reason: "http not allowed" },
      { url: "https://secure.example/", name: "Secure", reason: "https allowed" },
    ])));
    const out = await discoverShopCompetitors(SHOP);
    expect(out).toEqual({ suggested: 1 });
    expect(mocks.insertSuggestion).toHaveBeenCalledTimes(1);
    expect(mocks.insertSuggestion).toHaveBeenCalledWith(SHOP, expect.objectContaining({
      url: "https://secure.example/",
      name: "Secure",
    }));
  });
  it("extracts JSON from Markdown code fences", async () => {
    mocks.messagesCreate.mockResolvedValue(textResponse(
      `Here are some suggestions:\n\`\`\`json\n${JSON.stringify([
        { url: "https://fenced.example/", name: "Fenced", reason: "inside markdown" },
      ])}\n\`\`\``
    ));
    const out = await discoverShopCompetitors(SHOP);
    expect(out).toEqual({ suggested: 1 });
    expect(mocks.insertSuggestion).toHaveBeenCalledWith(SHOP, expect.objectContaining({
      url: "https://fenced.example/",
      name: "Fenced",
    }));
  });
  it("parses JSON after prose with markdown links", async () => {
    const jsonArray = JSON.stringify([
      { url: "https://afterlink.example/", name: "AfterLink", reason: "after prose" },
    ]);
    mocks.messagesCreate.mockResolvedValue(textResponse(
      `Check out [this store](https://example.com) and here are similar ones:\n${jsonArray}`
    ));
    const out = await discoverShopCompetitors(SHOP);
    expect(out).toEqual({ suggested: 1 });
    expect(mocks.insertSuggestion).toHaveBeenCalledWith(SHOP, expect.objectContaining({
      url: "https://afterlink.example/",
      name: "AfterLink",
    }));
  });
});
