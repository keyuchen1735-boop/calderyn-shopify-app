import { describe, expect, it, vi } from "vitest";
import { CUSTOM_BENCH_BUNDLE } from "../storefront-recipes/custom-bench/bundle";
import { classifyStoreIntent } from "./intent.server";

const input = {
  prompt: "Change the headline",
  currentTemplateId: "custom-bench" as const,
  excludedTemplateIds: ["soft-chemistry" as const],
  bundle: CUSTOM_BENCH_BUNDLE,
  productCandidates: [
    { id: "product-a", title: "Jacket" },
    { id: "product-b", title: "Overshirt" },
  ],
};

describe("classifyStoreIntent", () => {
  it("rejects markup returned as slot copy", async () => {
    const provider = vi.fn(async () =>
      '{"kind":"update_text","slot":"heroTitle","value":"<style>bad</style>"}');

    await expect(classifyStoreIntent(input, { provider })).rejects.toMatchObject({
      code: "invalid_store_intent",
    });
  });

  it("accepts only exact closed intent JSON and declared text slots", async () => {
    const provider = vi.fn()
      .mockResolvedValueOnce('{"kind":"update_text","slot":"heroTitle","value":"Summer starts here"}')
      .mockResolvedValueOnce('{"kind":"update_text","slot":"heroTitle","value":"Summer","html":"<main>"}')
      .mockResolvedValueOnce('{"kind":"update_text","slot":"notDeclared","value":"Summer"}');

    await expect(classifyStoreIntent(input, { provider })).resolves.toEqual({
      kind: "update_text",
      slot: "heroTitle",
      value: "Summer starts here",
    });
    await expect(classifyStoreIntent(input, { provider })).rejects.toMatchObject({ code: "invalid_store_intent" });
    await expect(classifyStoreIntent(input, { provider })).rejects.toMatchObject({ code: "invalid_store_intent" });
  });

  it("rejects text slots absent from the current bundle and non-home route contexts", async () => {
    const provider = vi.fn()
      .mockResolvedValueOnce('{"kind":"update_text","slot":"announcement","value":"Free shipping"}')
      .mockResolvedValueOnce('{"kind":"update_text","slot":"heroTitle","value":"Wrong route"}');

    await expect(classifyStoreIntent(input, { provider })).rejects.toMatchObject({ code: "invalid_store_intent" });
    await expect(classifyStoreIntent({
      ...input,
      context: { routeId: "product", slot: "heroTitle" },
    }, { provider })).rejects.toMatchObject({ code: "invalid_store_intent" });
  });

  it("keeps design exclusions deterministic", async () => {
    const provider = vi.fn(async () =>
      '{"kind":"select_design","prompt":"More editorial","excludedTemplateIds":["atelier-nine"]}');

    await expect(classifyStoreIntent({ ...input, prompt: "Make it more editorial" }, { provider })).resolves.toEqual({
      kind: "select_design",
      prompt: "More editorial",
      excludedTemplateIds: ["soft-chemistry", "custom-bench"],
    });
  });

  it("intercepts exact commands without provider routing", async () => {
    const provider = vi.fn(async () => '{"kind":"unsupported","message":"model"}');

    await expect(classifyStoreIntent({ ...input, prompt: "Undo" }, { provider })).resolves.toEqual({
      kind: "unsupported",
      message: "Use Undo to restore the previous version.",
    });
    await expect(classifyStoreIntent({ ...input, prompt: "Publish" }, { provider })).resolves.toEqual({
      kind: "unsupported",
      message: "Use Publish to publish the current version.",
    });
    await expect(classifyStoreIntent({ ...input, prompt: "Start over" }, { provider })).resolves.toEqual({
      kind: "start_over",
      prompt: "Start over",
    });
    await expect(classifyStoreIntent({ ...input, prompt: "Try another" }, { provider })).resolves.toEqual({
      kind: "select_design",
      prompt: "Try another",
      excludedTemplateIds: ["soft-chemistry", "custom-bench"],
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it("caps provider input and output", async () => {
    const provider = vi.fn(async () => "x".repeat(8_001));

    await expect(classifyStoreIntent({ ...input, prompt: "x".repeat(4_001) }, { provider }))
      .rejects.toMatchObject({ code: "invalid_store_intent" });
    expect(provider).not.toHaveBeenCalled();

    await expect(classifyStoreIntent(input, { provider })).rejects.toMatchObject({ code: "invalid_store_intent" });
  });

  it("validates bounded merchandising and visual-layer results", async () => {
    const provider = vi.fn()
      .mockResolvedValueOnce('{"kind":"update_merchandising","productIds":["product-a","product-b"]}')
      .mockResolvedValueOnce('{"kind":"update_visual_layer","visualLayer":{"kind":"fragment_shader","source":"void main(){}","colors":["#000000","#111111","#222222"]}}')
      .mockResolvedValueOnce(`{"kind":"update_visual_layer","visualLayer":{"kind":"fragment_shader","source":"${"x".repeat(4_001)}","colors":["#000000","#111111","#222222"]}}`)
      .mockResolvedValueOnce('{"kind":"update_merchandising","productIds":["product-a"," product-a"]}')
      .mockResolvedValueOnce('{"kind":"update_merchandising","productIds":["invented-product"]}');

    await expect(classifyStoreIntent(input, { provider })).resolves.toEqual({
      kind: "update_merchandising",
      productIds: ["product-a", "product-b"],
    });
    await expect(classifyStoreIntent(input, { provider })).resolves.toEqual({
      kind: "update_visual_layer",
      visualLayer: { kind: "fragment_shader", source: "void main(){}", colors: ["#000000", "#111111", "#222222"] },
    });
    await expect(classifyStoreIntent(input, { provider })).rejects.toMatchObject({ code: "invalid_store_intent" });
    await expect(classifyStoreIntent(input, { provider })).rejects.toMatchObject({ code: "invalid_store_intent" });
    await expect(classifyStoreIntent(input, { provider })).rejects.toMatchObject({ code: "invalid_store_intent" });
  });

  it("preserves an attached merchant shader outside the model", async () => {
    const providerPrompts: string[] = [];
    const provider = vi.fn(async (request: { prompt: string }) => {
      providerPrompts.push(request.prompt);
      return '{"kind":"update_visual_layer","visualLayer":{"kind":"fragment_shader","source":"model rewrite","colors":["#000000","#111111","#222222"]}}';
    });
    const source = "void main(){ gl_FragColor = vec4(1.0); }";

    await expect(classifyStoreIntent({
      ...input,
      attachments: [{ kind: "fragment_shader", source }],
    }, { provider })).resolves.toEqual({
      kind: "update_visual_layer",
      visualLayer: { kind: "fragment_shader", source, colors: ["#000000", "#111111", "#222222"] },
    });
    expect(providerPrompts[0]).not.toContain(source);
  });
});
