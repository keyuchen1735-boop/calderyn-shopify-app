// app/lib/storegen/generate.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StorefrontCatalog, StoreProduct } from "~/lib/storefront/catalog";
import { generateStore } from "./generate.server";

const { createMock, getCatalogMock, saveDraftMock, saveSettingsMock, hasSettingsMock, recGenMock, recPropMock } = vi.hoisted(() => ({
  createMock: vi.fn(), getCatalogMock: vi.fn(), saveDraftMock: vi.fn(),
  saveSettingsMock: vi.fn(), hasSettingsMock: vi.fn(), recGenMock: vi.fn(), recPropMock: vi.fn(),
}));
vi.mock("~/lib/assistant/anthropic.server", () => ({ getAnthropic: () => ({ messages: { create: createMock } }), digestModel: () => "claude-haiku-4-5" }));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("~/lib/storebuilder/page-document.server", () => ({ saveDraft: saveDraftMock }));
vi.mock("~/lib/storefront/settings.server", () => ({ getStoreSettings: async (shopId: string) => ({ shopId, storeName: "", logoUrl: null, palette: { primary: "#0f766e", background: "#ffffff", text: "#111827" }, voiceTagline: null, vibe: "minimal" }), saveStoreSettings: saveSettingsMock, hasStoreSettings: hasSettingsMock, DEFAULT_PALETTE: { primary: "#0f766e", background: "#fff", text: "#111" } }));
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
  for (const m of [createMock, getCatalogMock, saveDraftMock, saveSettingsMock, hasSettingsMock, recGenMock, recPropMock]) m.mockReset();
  getCatalogMock.mockReturnValue(catalog());
  hasSettingsMock.mockResolvedValue(false);
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

  it("does not clobber an existing merchant vibe on a re-generation", async () => {
    hasSettingsMock.mockResolvedValue(true);
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":"Go","vibe":"bold"}'))
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"hero","props":{"headline":"Hi"},"layout":{}}]}'))
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"collectionGrid","props":{},"layout":{}}]}'))
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"productGallery","props":{},"layout":{}}]}'));
    await generateStore({ shopId: realShop, mode: "catalog" });
    expect(saveSettingsMock.mock.calls[0][1]).not.toHaveProperty("vibe");
  });

  it("passes the brand vibe through on the first-ever branding", async () => {
    hasSettingsMock.mockResolvedValue(false);
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":"Go","vibe":"bold"}'))
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"hero","props":{"headline":"Hi"},"layout":{}}]}'))
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"collectionGrid","props":{},"layout":{}}]}'))
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"productGallery","props":{},"layout":{}}]}'));
    await generateStore({ shopId: realShop, mode: "catalog" });
    expect(saveSettingsMock.mock.calls[0][1]).toMatchObject({ vibe: "bold" });
  });

  it("passes the brand typeStyle/density through on the first-ever branding", async () => {
    hasSettingsMock.mockResolvedValue(false);
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":"Go","vibe":"bold","typeStyle":"editorial","density":"roomy"}'))
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"hero","props":{"headline":"Hi"},"layout":{}}]}'))
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"collectionGrid","props":{},"layout":{}}]}'))
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"productGallery","props":{},"layout":{}}]}'));
    await generateStore({ shopId: realShop, mode: "catalog" });
    expect(saveSettingsMock.mock.calls[0][1]).toEqual(expect.objectContaining({ typeStyle: "editorial", density: "roomy" }));
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

  it("uses the top catalog product's image as the hero backdrop in the fallback home doc", async () => {
    // Catalog product carries an image; the home doc falls back (junk LLM reply) → the deterministic
    // hero must still pick up that image so the no-credits store looks designed, not plain.
    getCatalogMock.mockReturnValue({
      listProducts: async () => [{ ...product("1"), images: [{ url: "/i/hero.jpg", alt: null }] }],
      getProduct: async (_s: string, h: string) => product(h.replace("h-", "")),
      listCollections: async () => [{ handle: "summer", title: "Summer" }],
    });
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}')) // brand ok
      .mockResolvedValue(reply("garbage not json")); // every doc call → deterministic fallback
    await generateStore({ shopId: realShop, mode: "catalog" });
    const homeDraft = saveDraftMock.mock.calls.find((c) => c[1] === "home")![2];
    const hero = homeDraft.blocks.find((b: { type: string }) => b.type === "hero")!;
    expect(hero.props.imageUrl).toBe("/i/hero.jpg");
  });

  it("generates the home as a single sanitized rawHtml block (flashy HTML, not a text stack)", async () => {
    // The home page is an AI-authored full HTML page so it reads as a real designed storefront with
    // zero product imagery. The generator sanitizes it (script/handlers stripped) before it is stored.
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#7c3aed","background":"#0b0b0f","text":"#fff"},"voiceTagline":"","vibe":"bold"}')) // brand
      .mockResolvedValueOnce(reply('<div class="ai-store"><style>.ai-store .hero{background:linear-gradient(135deg,#7c3aed,#000)}</style><section class="hero"><h1>Built different</h1></section></div><script>steal()</script>')) // home HTML (+ injected script)
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"collectionGrid","props":{},"layout":{}}]}'))
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"productGallery","props":{},"layout":{}}]}'));
    await generateStore({ shopId: realShop, mode: "brief", brief: "a bold gym brand" });
    const homeDraft = saveDraftMock.mock.calls.find((c) => c[1] === "home")![2];
    expect(homeDraft.blocks).toHaveLength(1);
    expect(homeDraft.blocks[0].type).toBe("rawHtml");
    const html = homeDraft.blocks[0].props.html as string;
    expect(html).toContain("Built different");
    expect(html).toContain("linear-gradient"); // design preserved
    expect(html).not.toMatch(/<script/i); // sanitized at the generator boundary
  });

  it("falls back to the designed hollow store when the home HTML call returns no markup (junk/refusal)", async () => {
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}')) // brand ok
      .mockResolvedValue(reply("I cannot help with that.")); // home HTML has no tags → miss → fallback
    await generateStore({ shopId: realShop, mode: "brief", brief: "anything" });
    const homeDraft = saveDraftMock.mock.calls.find((c) => c[1] === "home")![2];
    const types = homeDraft.blocks.map((b: { type: string }) => b.type);
    expect(types).not.toContain("rawHtml"); // fell back
    expect(types).toContain("hero"); // designed hollow/fallback store, never blank
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

  it("feeds an explicit brief into the brand stage (brief steers name/palette/vibe, not just page copy)", async () => {
    // The bug: the brand call only ever saw the catalog, so "make it colorful"
    // could never change the store's look — only the per-page copy stage got the brief.
    createMock.mockResolvedValue(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":"","vibe":"warm"}'));
    await generateStore({ shopId: realShop, mode: "brief", brief: "make it warm and colorful" });
    const brandUserMsg = createMock.mock.calls[0][0].messages[0].content as string;
    expect(brandUserMsg).toContain("make it warm and colorful");
  });

  it("lets an explicit brief re-set vibe on a rebuild (full restyle), unlike an auto catalog rebuild", async () => {
    hasSettingsMock.mockResolvedValue(true); // already branded once
    createMock.mockResolvedValue(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":"","vibe":"bold"}'));
    await generateStore({ shopId: realShop, mode: "brief", brief: "make it bold and dramatic" });
    expect(saveSettingsMock.mock.calls[0][1]).toMatchObject({ vibe: "bold" });
  });

  it("reports 'failed' when every LLM call errors (out of credits / API down), still writing fallback docs", async () => {
    // Every call rejects → all docs are deterministic fallbacks that ignore the
    // brief. The run still produces a publishable store, but its status must be
    // "failed" so the studio tells the merchant the AI was unavailable (rule 12)
    // rather than presenting the generic layout as their design.
    createMock.mockRejectedValue(new Error("api down"));
    const result = await generateStore({ shopId: realShop, mode: "catalog" });
    expect(result.status).toBe("failed");
    expect(saveDraftMock).toHaveBeenCalledTimes(3); // all fallback docs — store never blanks
    expect(recGenMock).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("stays 'draft' when the AI is partially degraded (brand ok, one doc call throws)", async () => {
    // A single transient doc-call error must NOT flip a mostly-good generation to
    // "failed" — at least one call succeeded, so the brief did reach the model.
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}')) // brand ok
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"hero","props":{"headline":"Hi"},"layout":{}}]}')) // home ok
      .mockRejectedValueOnce(new Error("blip")) // collection throws
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"productGallery","props":{},"layout":{}}]}')); // pdp ok
    const result = await generateStore({ shopId: realShop, mode: "catalog" });
    expect(result.status).toBe("draft");
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

  it("builds the three pages concurrently — home does not block collection/pdp (latency)", async () => {
    // Regression guard for the parallel Stage 2: the three page calls must be in flight together.
    // Each doc call blocks until all three have started; if the generator ever re-serializes them,
    // the first waits forever for the others and this test times out instead of passing.
    let calls = 0;
    let inflight = 0;
    let release!: () => void;
    const allStarted = new Promise<void>((r) => { release = r; });
    createMock.mockImplementation(async () => {
      calls += 1;
      // Call #1 is the Stage 1 brand call — resolve it immediately so Stage 2 can begin.
      if (calls === 1) return reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}');
      inflight += 1;
      if (inflight === 3) release();
      await allStarted; // deadlocks (→ timeout) if the three calls are serialized
      return reply('{"blocks":[{"type":"hero","props":{"headline":"Hi"},"layout":{}}]}');
    });
    await generateStore({ shopId: realShop, mode: "catalog" });
    expect(inflight).toBe(3);
    expect(saveDraftMock).toHaveBeenCalledTimes(3);
  }, 3000);
});
