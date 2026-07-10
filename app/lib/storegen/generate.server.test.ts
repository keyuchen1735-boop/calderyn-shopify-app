// app/lib/storegen/generate.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StorefrontCatalog, StoreProduct } from "~/lib/storefront/catalog";
import { generateStore, extractStoreHtml, parseJudgeVerdict, extractSectionHtml, regenerateHomeSection } from "./generate.server";

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
const reply = (text: string, stopReason?: string) => ({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 20 }, ...(stopReason ? { stop_reason: stopReason } : {}) });

beforeEach(() => {
  for (const m of [createMock, getCatalogMock, saveDraftMock, saveSettingsMock, hasSettingsMock, recGenMock, recPropMock]) m.mockReset();
  getCatalogMock.mockReturnValue(catalog());
  hasSettingsMock.mockResolvedValue(false);
  // Single-candidate mode keeps the queued-reply sequences of the legacy tests deterministic;
  // the multi-candidate judge pipeline has its own describe block below.
  process.env.STOREGEN_HOME_CANDIDATES = "1";
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

  it("reports real build stages in order through onStage", async () => {
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}'))
      .mockResolvedValue(reply("junk"));
    const stages: string[] = [];
    await generateStore({ shopId: realShop, mode: "catalog", onStage: (s) => stages.push(s) });
    expect(stages).toEqual(["brand", "designing", "checking"]);
  });

  it("verification strips runtime-rejected motion specs before drafts are saved and reports it", async () => {
    const badMotion = "{&quot;trigger&quot;:&quot;inview&quot;,&quot;targets&quot;:&quot;.x&quot;,&quot;from&quot;:{&quot;bogus&quot;:1}}";
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}'))
      .mockResolvedValueOnce(reply(`<div class="ai-store"><style>.ai-store .h{color:#fff}</style><section class="h" data-fx-motion="${badMotion}"><h1>A designed page with a good amount of copy for the sparse check</h1></section></div>`))
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"collectionGrid","props":{},"layout":{}}]}'))
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"productGallery","props":{},"layout":{}}]}'));
    const result = await generateStore({ shopId: realShop, mode: "brief", brief: "b" });
    const homeDraft = saveDraftMock.mock.calls.find((c) => c[1] === "home")![2];
    expect(homeDraft.blocks[0].props.html).not.toContain("data-fx-motion");
    expect(result.verification?.strippedMotion).toBe(1);
  });

  it("splices home catalog markers into real productGrid blocks between rawHtml segments", async () => {
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}')) // brand
      .mockResolvedValueOnce(reply('<div class="ai-store"><style>.ai-store .hero{color:#fff}</style><section class="hero"><h1>Yo</h1></section><div data-cd-products="summer" data-cd-heading="Shop summer"></div><section class="closer"><p>end</p></section></div>')) // home
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"collectionGrid","props":{},"layout":{}}]}'))
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"productGallery","props":{},"layout":{}}]}'));
    await generateStore({ shopId: realShop, mode: "brief", brief: "summer things" });
    const homeDraft = saveDraftMock.mock.calls.find((c) => c[1] === "home")![2];
    expect(homeDraft.blocks.map((b: { type: string }) => b.type)).toEqual(["rawHtml", "productGrid", "rawHtml"]);
    expect(homeDraft.blocks[1].props.source).toEqual({ kind: "collection", handle: "summer" });
    expect(homeDraft.blocks[1].props.heading).toBe("Shop summer");
    // segments each remain scoped fragments so the model's CSS survives the split
    expect(homeDraft.blocks[0].props.html).toContain('<div class="ai-store"><style>');
    expect(homeDraft.blocks[2].props.html).toContain("closer");
  });

  it("grounds the home call with real catalog counts", async () => {
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}'))
      .mockResolvedValue(reply("junk"));
    await generateStore({ shopId: realShop, mode: "catalog" });
    const homeCall = createMock.mock.calls[1][0];
    const userText = typeof homeCall.messages[0].content === "string" ? homeCall.messages[0].content : JSON.stringify(homeCall.messages[0].content);
    expect(userText).toContain('"counts"');
    expect(userText).toContain('"summer":1'); // one mock product lives in "summer"
  });

  it("honors the merchant's design-model choice on the home HTML call only", async () => {
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}')) // brand
      .mockResolvedValueOnce(reply("<div><h1>Hi</h1></div>")) // home HTML
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"collectionGrid","props":{},"layout":{}}]}'))
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"productGallery","props":{},"layout":{}}]}'));
    await generateStore({ shopId: realShop, mode: "brief", brief: "a gym brand", designModel: "opus" });
    const models = createMock.mock.calls.map((c) => (c[0] as { model: string }).model);
    expect(models.filter((m) => m === "claude-opus-4-8")).toHaveLength(1); // the design call
    expect(models.filter((m) => m === "claude-sonnet-5")).toHaveLength(3); // brand + block plans on the storegen default
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

  it("attaches reference image blocks to the brand + home calls only (block plans stay text-only)", async () => {
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}')) // brand
      .mockResolvedValueOnce(reply('<div class="ai-store"><h1>Hi</h1></div>')) // home HTML
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"collectionGrid","props":{},"layout":{}}]}')) // collection
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"productGallery","props":{},"layout":{}}]}')); // pdp
    const result = await generateStore({
      shopId: realShop,
      mode: "brief",
      brief: "match this mood",
      referenceImages: [{ mediaType: "image/png", dataBase64: "aGk=" }],
    });
    // Vision calls succeeded, so the best-effort "references never seen" flag stays off.
    expect(result.referencesUnread).toBeUndefined();
    const contents = createMock.mock.calls.map((c) => c[0].messages[0].content);
    // brand + home carry the image block; collection + pdp are plain strings.
    const withImage = contents.filter(
      (content: unknown) =>
        Array.isArray(content) && content.some((b: { type: string }) => b.type === "image"),
    );
    expect(withImage).toHaveLength(2);
    const textOnly = contents.filter((content: unknown) => typeof content === "string");
    expect(textOnly).toHaveLength(2);
    // The attached block carries the merchant's base64 through untouched.
    const anImageBlock = (withImage[0] as Array<{ type: string; source?: { data?: string } }>).find(
      (b) => b.type === "image",
    );
    expect(anImageBlock?.source?.data).toBe("aGk=");
  });

  it("drops a reference image with an unsupported media type (never sent to the API)", async () => {
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}'))
      .mockResolvedValue(reply('{"blocks":[{"type":"hero","props":{"headline":"Hi"},"layout":{}}]}'));
    await generateStore({
      shopId: realShop,
      mode: "brief",
      brief: "match this",
      referenceImages: [{ mediaType: "image/tiff", dataBase64: "nope" }],
    });
    // The only reference image had a bad type → no call carries an image block.
    const anyImage = createMock.mock.calls.some((c) => {
      const content = c[0].messages[0].content;
      return Array.isArray(content) && content.some((b: { type: string }) => b.type === "image");
    });
    expect(anyImage).toBe(false);
  });

  it("sends every call as a plain string when no reference images are attached (unchanged)", async () => {
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}'))
      .mockResolvedValue(reply('{"blocks":[{"type":"hero","props":{"headline":"Hi"},"layout":{}}]}'));
    await generateStore({ shopId: realShop, mode: "brief", brief: "no images here" });
    for (const c of createMock.mock.calls) {
      expect(typeof c[0].messages[0].content).toBe("string");
    }
  });

  it("flags referencesUnread when every vision call errors but a text-only call succeeds", async () => {
    // The two image-carrying calls (brand + home) fail; the text-only block-plan
    // calls succeed → the run stays "draft" but the design never saw the
    // merchant's references — the flag lets the studio say so (best-effort).
    createMock.mockImplementation(async (params: { messages: { content: unknown }[] }) =>
      Array.isArray(params.messages[0].content)
        ? Promise.reject(new Error("vision down"))
        : reply('{"blocks":[{"type":"hero","props":{"headline":"Hi"},"layout":{}}]}'),
    );
    const result = await generateStore({
      shopId: realShop,
      mode: "brief",
      brief: "match this",
      referenceImages: [{ mediaType: "image/png", dataBase64: "aGk=" }],
    });
    expect(result.referencesUnread).toBe(true);
    expect(result.status).toBe("draft"); // partially degraded run still drafts
  });

  it("does not flag referencesUnread when every call fails ('failed' is the stronger signal)", async () => {
    createMock.mockImplementation(() => Promise.reject(new Error("all down")));
    const result = await generateStore({
      shopId: realShop,
      mode: "brief",
      brief: "match this",
      referenceImages: [{ mediaType: "image/png", dataBase64: "aGk=" }],
    });
    expect(result.status).toBe("failed");
    expect(result.referencesUnread).toBeUndefined();
  });

  it("builds the three pages concurrently — home does not block collection/pdp (latency)", async () => {
    // Regression guard for the parallel Stage 2: the three page calls must be in flight together.
    // Each doc call blocks until all three have started; if the generator ever re-serializes them,
    // the first waits forever for the others and this test times out instead of passing.
    let calls = 0;
    let inflight = 0;
    let release!: () => void;
    const allStarted = new Promise<void>((r) => { release = r; });
    createMock.mockImplementation(async (req: unknown) => {
      calls += 1;
      // Call #1 is the Stage 1 brand call — resolve it immediately so Stage 2 can begin.
      if (calls === 1) return reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}');
      inflight += 1;
      if (inflight === 3) release();
      await allStarted; // deadlocks (→ timeout) if the three calls are serialized
      // Answer each page's actual contract (HTML for home, JSON for the plans) so no
      // corrective retry fires — a retry would add a 4th call and skew the inflight count.
      const isHome = String((req as { system?: unknown }).system ?? "").includes("art director");
      return isHome
        ? reply('<div class="ai-store"><style>.ai-store .hero{color:#111}</style><h1>Hi</h1></div>')
        : reply('{"blocks":[{"type":"hero","props":{"headline":"Hi"},"layout":{}}]}');
    });
    await generateStore({ shopId: realShop, mode: "catalog" });
    expect(inflight).toBe(3);
    expect(saveDraftMock).toHaveBeenCalledTimes(3);
  }, 3000);
});

describe("extractStoreHtml", () => {
  const PAGE = '<div class="ai-store"><style>.ai-store{}</style><h1>Hi</h1></div>';

  it("passes clean raw HTML through", () => {
    expect(extractStoreHtml(PAGE)).toBe(PAGE);
  });

  it("strips a prose preamble and an embedded code fence", () => {
    const fenced = ["Here is your page:", "```html", PAGE, "```"].join("\n");
    expect(extractStoreHtml(fenced)).toBe(PAGE);
  });

  it("rejects a refusal that merely mentions a tag", () => {
    expect(extractStoreHtml("I can't render <script> content for this request.")).toBe("");
  });

  it("rejects prose and JSON with no container", () => {
    expect(extractStoreHtml("I cannot help with that.")).toBe("");
    expect(extractStoreHtml('{"blocks":[]}')).toBe("");
  });
});

describe("generateStore — premium-output hardening", () => {
  it("never writes logoUrl — a regenerate must not wipe the merchant's uploaded logo", async () => {
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":"Go"}'))
      .mockResolvedValue(reply('{"blocks":[{"type":"hero","props":{"headline":"Hi"},"layout":{}}]}'));
    await generateStore({ shopId: realShop, mode: "catalog" });
    expect(saveSettingsMock.mock.calls[0][1]).not.toHaveProperty("logoUrl");
  });

  it("treats a max_tokens-truncated home reply as a miss: one retry, then the designed fallback — never half a page", async () => {
    const half = '<div class="ai-store"><style>.ai-store{}</style><section>cut off';
    createMock.mockImplementation(async (req: unknown) => {
      const isHome = String((req as { system?: unknown }).system ?? "").includes("art director");
      if (isHome) return reply(half, "max_tokens");
      if (createMock.mock.calls.length === 1) return reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}');
      return reply('{"blocks":[{"type":"hero","props":{"headline":"Hi"},"layout":{}}]}');
    });
    await generateStore({ shopId: realShop, mode: "brief", brief: "a gym brand" });
    const homeDraft = saveDraftMock.mock.calls.find((c) => c[1] === "home")![2];
    expect(homeDraft.blocks.map((b: { type: string }) => b.type)).not.toContain("rawHtml");
    // Exactly one corrective retry for the home call: brand + home + retry + 2 block plans.
    const homeCalls = createMock.mock.calls.filter((c) => String((c[0] as { system?: unknown }).system ?? "").includes("art director"));
    expect(homeCalls).toHaveLength(2);
  });

  it("retries a junk block-plan reply once and uses the corrected plan instead of the canned fallback", async () => {
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}')) // brand
      .mockResolvedValueOnce(reply('<div class="ai-store"><style>.ai-store{}</style><h1>Hi</h1></div>')) // home
      .mockResolvedValueOnce(reply("garbage not json")) // collection (junk -> retry)
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"productGallery","props":{},"layout":{}}]}')) // pdp
      .mockResolvedValueOnce(reply('{"blocks":[{"type":"hero","props":{"headline":"Retried heading"},"layout":{}},{"type":"collectionGrid","props":{},"layout":{}}]}')); // collection retry
    await generateStore({ shopId: realShop, mode: "catalog" });
    const collectionDraft = saveDraftMock.mock.calls.find((c) => c[1] === "collection")![2];
    const hero = collectionDraft.blocks.find((b: { type: string }) => b.type === "hero");
    expect(hero?.props.headline).toBe("Retried heading");
  });

  it("reports failed when the model answered but every page still fell back (junk all the way down)", async () => {
    createMock
      .mockResolvedValueOnce(reply('{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}')) // brand ok
      .mockResolvedValue(reply("garbage not json")); // every page + retry -> fallback
    const result = await generateStore({ shopId: realShop, mode: "brief", brief: "anything" });
    expect(result.status).toBe("failed");
  });
});

describe("generateStore - multi-candidate judge pipeline", () => {
  const BRAND = '{"storeName":"Acme","palette":{"primary":"#000","background":"#fff","text":"#111"},"voiceTagline":""}';
  const PAGE_A = '<div class="ai-store"><style>.ai-store{}</style><h1>ANGLE-A</h1></div>';
  const PAGE_B = '<div class="ai-store"><style>.ai-store{}</style><h1>ANGLE-B</h1></div>';
  const PAGE_R = '<div class="ai-store"><style>.ai-store{}</style><h1>REVISED</h1></div>';
  const PLAN = '{"blocks":[{"type":"hero","props":{"headline":"Hi"},"layout":{}}]}';

  function routeMock(opts: { judge: string; revision?: string }) {
    createMock.mockImplementation(async (req: unknown) => {
      const system = String((req as { system?: unknown }).system ?? "");
      const user = JSON.stringify((req as { messages?: unknown }).messages ?? "");
      if (system.includes("design director")) return reply(opts.judge);
      if (system.includes("art director")) {
        if (user.includes("CURRENT PAGE")) return reply(opts.revision ?? PAGE_R);
        return reply(user.includes("RESTRAINED") || user.includes("different compositional angle") ? PAGE_B : PAGE_A);
      }
      if (system.includes("name and brand")) return reply(BRAND);
      return reply(PLAN);
    });
  }

  beforeEach(() => {
    process.env.STOREGEN_HOME_CANDIDATES = "2";
  });

  it("generates two candidates, ships the judge's winner, and skips revision on a strong score", async () => {
    routeMock({ judge: '{"winner":2,"score":9,"critique":""}' });
    await generateStore({ shopId: realShop, mode: "brief", brief: "a gym brand" });
    const homeDraft = saveDraftMock.mock.calls.find((c) => c[1] === "home")![2];
    const htmlBlock = homeDraft.blocks.find((b: { type: string }) => b.type === "rawHtml");
    expect(htmlBlock.props.html).toContain("ANGLE-B");
    expect(htmlBlock.props.html).not.toContain("REVISED");
    const proposal = recPropMock.mock.calls[0][2] as Record<string, { judge?: { winner: number } }>;
    expect(proposal.home.judge).toMatchObject({ winner: 2, score: 9 });
  });

  it("revises a weak winner once with the judge's critique", async () => {
    routeMock({ judge: '{"winner":1,"score":5,"critique":"Hero copy reads generic; sections repeat the same shape."}' });
    await generateStore({ shopId: realShop, mode: "brief", brief: "a gym brand" });
    const homeDraft = saveDraftMock.mock.calls.find((c) => c[1] === "home")![2];
    const htmlBlock = homeDraft.blocks.find((b: { type: string }) => b.type === "rawHtml");
    expect(htmlBlock.props.html).toContain("REVISED");
    const proposal = recPropMock.mock.calls[0][2] as Record<string, { revised?: boolean }>;
    expect(proposal.home.revised).toBe(true);
  });

  it("keeps the winner when the revision comes back unusable", async () => {
    routeMock({ judge: '{"winner":1,"score":4,"critique":"Weak hierarchy."}', revision: "I cannot revise that." });
    await generateStore({ shopId: realShop, mode: "brief", brief: "a gym brand" });
    const homeDraft = saveDraftMock.mock.calls.find((c) => c[1] === "home")![2];
    const htmlBlock = homeDraft.blocks.find((b: { type: string }) => b.type === "rawHtml");
    expect(htmlBlock.props.html).toContain("ANGLE-A");
  });

  it("falls back to the first valid candidate when the judge returns junk", async () => {
    routeMock({ judge: "not json at all" });
    await generateStore({ shopId: realShop, mode: "brief", brief: "a gym brand" });
    const homeDraft = saveDraftMock.mock.calls.find((c) => c[1] === "home")![2];
    const htmlBlock = homeDraft.blocks.find((b: { type: string }) => b.type === "rawHtml");
    expect(htmlBlock.props.html).toContain("ANGLE-A");
  });
});

describe("parseJudgeVerdict", () => {
  it("parses a clean verdict and clamps the score", () => {
    expect(parseJudgeVerdict('{"winner":2,"score":14,"critique":"x"}')).toEqual({ winner: 2, score: 10, critique: "x" });
  });
  it("tolerates a fenced verdict", () => {
    const NL = String.fromCharCode(10);
    const fenced = ["```json", '{"winner":1,"score":7,"critique":""}', "```"].join(NL);
    expect(parseJudgeVerdict(fenced)).toEqual({ winner: 1, score: 7, critique: "" });
  });
  it("rejects junk, bad winners and missing scores", () => {
    expect(parseJudgeVerdict("prose")).toBeNull();
    expect(parseJudgeVerdict('{"winner":3,"score":5}')).toBeNull();
    expect(parseJudgeVerdict('{"winner":1}')).toBeNull();
  });
});

describe("extractSectionHtml", () => {
  it("takes the balanced section and trims prose around it", () => {
    const out = extractSectionHtml('Here you go: <section class="hero"><h1>Hi</h1></section> Anything else?');
    expect(out).toBe('<section class="hero"><h1>Hi</h1></section>');
  });
  it("keeps nested sections inside the balanced extent", () => {
    const html = '<section id="a">x<section id="b">y</section>z</section>';
    expect(extractSectionHtml(html)).toBe(html);
  });
  it("rejects replies with no section or an unterminated section", () => {
    expect(extractSectionHtml("I cannot do that.")).toBe("");
    expect(extractSectionHtml('<section class="hero">cut off')).toBe("");
  });
});

describe("regenerateHomeSection", () => {
  it("returns the sanitized replacement section", async () => {
    createMock.mockResolvedValue(reply('<section class="hero"><h1>New hero</h1></section>'));
    const out = await regenerateHomeSection(realShop, '<section class="hero"><h1>Old</h1></section>', "make it punchier");
    expect(out).toContain("New hero");
    expect(out).toMatch(/^<section/);
  });
  it("returns null on junk output and on API failure — never a silent no-op", async () => {
    createMock.mockResolvedValue(reply("Sorry, no."));
    expect(await regenerateHomeSection(realShop, "<section>Old</section>")).toBeNull();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createMock.mockRejectedValue(new Error("down"));
    expect(await regenerateHomeSection(realShop, "<section>Old</section>")).toBeNull();
    spy.mockRestore();
  });
});
