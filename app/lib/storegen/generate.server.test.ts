// app/lib/storegen/generate.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StorefrontCatalog, StoreProduct } from "~/lib/storefront/catalog";
import { generateStore } from "./generate.server";

const { createMock, getCatalogMock, saveDraftMock, saveSettingsMock, recGenMock, recPropMock } = vi.hoisted(() => ({
  createMock: vi.fn(), getCatalogMock: vi.fn(), saveDraftMock: vi.fn(),
  saveSettingsMock: vi.fn(), recGenMock: vi.fn(), recPropMock: vi.fn(),
}));
vi.mock("~/lib/assistant/anthropic.server", () => ({ getAnthropic: () => ({ messages: { create: createMock } }), digestModel: () => "claude-haiku-4-5" }));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("~/lib/storebuilder/page-document.server", () => ({ saveDraft: saveDraftMock }));
vi.mock("~/lib/storefront/settings.server", () => ({ saveStoreSettings: saveSettingsMock, DEFAULT_PALETTE: { primary: "#0f766e", background: "#fff", text: "#111" } }));
vi.mock("./audit.server", () => ({ recordGeneration: recGenMock, recordProposal: recPropMock }));

const realShop = "11111111-1111-1111-1111-111111111111";
const product = (id: string): StoreProduct => ({ id, handle: `h-${id}`, title: `P${id}`, description: "", images: [], variants: [{ id: `v-${id}`, sku: null, title: "D", priceCents: 1000, currency: "USD", available: true }], collections: ["summer"] });
const catalog = (): StorefrontCatalog => ({
  listProducts: async () => [product("1")],
  getProduct: async (_s, h) => product(h.replace("h-", "")),
  listCollections: async () => [{ handle: "summer", title: "Summer" }],
});
const reply = (text: string) => ({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 20 } });

beforeEach(() => {
  for (const m of [createMock, getCatalogMock, saveDraftMock, saveSettingsMock, recGenMock, recPropMock]) m.mockReset();
  getCatalogMock.mockReturnValue(catalog());
});

describe("generateStore", () => {
  it("writes a draft for home, collection and pdp and records audit", async () => {
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":"Go"}')) // brand
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"hero","props":{"headline":"Hi"},"layout":{"x":0,"y":0,"w":12,"h":2}}]}')) // home
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"collectionGrid","props":{},"layout":{}}]}')) // collection
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"productGallery","props":{},"layout":{}}]}')); // pdp
    const result = await generateStore({ shopId: realShop, mode: "catalog" });
    expect(saveSettingsMock).toHaveBeenCalled();
    expect(saveDraftMock).toHaveBeenCalledTimes(3);
    const pages = saveDraftMock.mock.calls.map((c) => c[1]).sort();
    expect(pages).toEqual(["collection", "home", "pdp"]);
    expect(result.status).toBe("draft");
    expect(recGenMock).toHaveBeenCalled();
    expect(recPropMock).toHaveBeenCalled();
  });

  it("falls back per-doc when a doc call returns junk (home survives a bad pdp)", async () => {
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}'))
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"hero","props":{"headline":"Hi"},"layout":{}}]}'))
      .mockResolvedValueOnce(reply("garbage not json"))
      .mockResolvedValueOnce(reply("garbage not json"));
    await generateStore({ shopId: realShop, mode: "catalog" });
    const pdpDraft = saveDraftMock.mock.calls.find((c) => c[1] === "pdp")![2];
    expect(pdpDraft.blocks.map((b: { type: string }) => b.type)).toContain("addToCart"); // fallback PDP is buyable
  });

  it("flags no_products on an empty catalog and still writes drafts", async () => {
    getCatalogMock.mockReturnValue({ listProducts: async () => [], getProduct: async () => null, listCollections: async () => [] });
    createMock.mockResolvedValue(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}'));
    const result = await generateStore({ shopId: realShop, mode: "catalog" });
    expect(result.status).toBe("no_products");
    expect(saveDraftMock).toHaveBeenCalled();
  });

  it("skips all paid LLM calls for an empty catalog with no brief (deterministic fallback, zero spend)", async () => {
    getCatalogMock.mockReturnValue({ listProducts: async () => [], getProduct: async () => null, listCollections: async () => [] });
    const result = await generateStore({ shopId: realShop, mode: "catalog" });
    expect(createMock).not.toHaveBeenCalled();
    expect(result.tokenCost).toBe(0);
    expect(result.status).toBe("no_products");
    expect(saveDraftMock).toHaveBeenCalledTimes(3); // fallback docs still drafted
  });

  it("still calls the LLM for an empty catalog when a brief gives it real input", async () => {
    getCatalogMock.mockReturnValue({ listProducts: async () => [], getProduct: async () => null, listCollections: async () => [] });
    createMock.mockResolvedValue(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}'));
    await generateStore({ shopId: realShop, mode: "brief", brief: "warm earthy brand" });
    expect(createMock).toHaveBeenCalled();
  });

  it("falls back to a deterministic brand when the brand call fails, without throwing", async () => {
    createMock.mockRejectedValue(new Error("api down"));
    const result = await generateStore({ shopId: realShop, mode: "catalog" });
    expect(result.status).toBe("draft");
    expect(saveDraftMock).toHaveBeenCalledTimes(3); // all fallback docs
  });

  it("stops calling Claude once the token budget is tripped, still writing all 3 drafts (rule 6)", async () => {
    // The brand call alone exceeds STOREGEN_TOKEN_BUDGET, so no per-doc calls run.
    createMock.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}' }],
      usage: { input_tokens: 99999, output_tokens: 0 },
    });
    await generateStore({ shopId: realShop, mode: "catalog" });
    expect(createMock).toHaveBeenCalledTimes(1); // budget tripped after brand → no doc calls
    expect(saveDraftMock).toHaveBeenCalledTimes(3); // every doc still written via fallback
  });
});
