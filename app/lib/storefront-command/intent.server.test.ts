import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeCompiledTree } from "../storefront-compiler/html";
import type { CompiledElementNode, CompiledNode, StorefrontBundleV1 } from "../storefront-bundle/types";
import { STOREFRONT_RECIPES } from "../storefront-recipes";
import { CUSTOM_BENCH_BUNDLE } from "../storefront-recipes/custom-bench/bundle";
import {
  classifyStoreIntent,
  type ClassifyStoreIntentInput,
  type StoreIntentProvider,
} from "./intent.server";

const { createMessage } = vi.hoisted(() => ({ createMessage: vi.fn() }));

vi.mock("../assistant/anthropic.server", () => ({
  assistantModel: () => "test-model",
  getAnthropic: () => ({ messages: { create: createMessage } }),
}));

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

function mutableInput(): ClassifyStoreIntentInput {
  return structuredClone(input);
}

function firstElement(nodes: readonly CompiledNode[], tag: string): CompiledElementNode {
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    if (node.tag === tag) return node;
    const nested = firstElementOrNull(node.children, tag);
    if (nested) return nested;
  }
  throw new Error(`Missing ${tag}`);
}

function firstElementOrNull(nodes: readonly CompiledNode[], tag: string): CompiledElementNode | null {
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    if (node.tag === tag) return node;
    const nested = firstElementOrNull(node.children, tag);
    if (nested) return nested;
  }
  return null;
}

function ambiguousHeroBundle(): StorefrontBundleV1 {
  const result = structuredClone(CUSTOM_BENCH_BUNDLE);
  const source = firstElement(result.routes.home.tree, "h1");
  source.id = "unbound-title";
  const hero = firstElement(result.routes.home.tree, "section");
  for (const suffix of ["one", "two"]) {
    hero.children.push({
      ...structuredClone(source),
      id: `ambiguous-hero-${suffix}`,
      attributes: {},
    });
  }
  result.routes.home.html = serializeCompiledTree(result.routes.home.tree);
  return result;
}

function crossBlueprintHeroBundle(): StorefrontBundleV1 {
  const result = structuredClone(CUSTOM_BENCH_BUNDLE);
  const homeTitle = firstElement(result.routes.home.tree, "h1");
  homeTitle.attributes = { ...homeTitle.attributes, class: "heroTitle" };
  result.shell.tree.push({
    ...structuredClone(homeTitle),
    id: "shell-hero-title",
  });
  result.routes.home.html = serializeCompiledTree(result.routes.home.tree);
  result.shell.html = serializeCompiledTree(result.shell.tree);
  return result;
}

function deferredProvider(): {
  provider: StoreIntentProvider;
  resolve: (value: string) => void;
} {
  let resolve!: (value: string) => void;
  return {
    provider: () => new Promise<string>((done) => { resolve = done; }),
    resolve: (value) => resolve(value),
  };
}

function classified(intentJson: string, requestedOperations?: string[]): string {
  const intent = JSON.parse(intentJson) as { kind: string };
  return JSON.stringify({
    requestedOperations: requestedOperations ?? (intent.kind === "unsupported" ? [] : [intent.kind]),
    intent,
  });
}

beforeEach(() => {
  createMessage.mockReset();
});

describe("classifyStoreIntent", () => {
  it("tells the provider whether the store is fresh or existing and requires state-safe intent choices", async () => {
    const requests: Parameters<StoreIntentProvider>[0][] = [];
    const provider: StoreIntentProvider = async (request) => {
      requests.push(request);
      const providerInput = JSON.parse(request.prompt) as { storeState?: string };
      return providerInput.storeState === "fresh"
        ? classified('{"kind":"select_design","prompt":"Build my store","excludedTemplateIds":[]}')
        : classified('{"kind":"update_text","slot":"heroTitle","value":"Existing store title"}');
    };

    await expect(classifyStoreIntent({
      prompt: "Build my store",
      productCandidates: input.productCandidates,
    }, { provider })).resolves.toMatchObject({ kind: "select_design" });
    await expect(classifyStoreIntent(input, { provider })).resolves.toMatchObject({ kind: "update_text" });

    expect(requests.map(({ prompt }) => JSON.parse(prompt).storeState)).toEqual(["fresh", "existing"]);
    expect(requests[0]?.system).toContain("Fresh store: for one design request return select_design");
    expect(requests[0]?.system).toContain("Existing store: return select_design");
    expect(requests[0]?.system).toContain("use update_text");
    expect(requests[0]?.system).toContain("requestedOperations");
  });

  it.each([
    ["different kinds", ["update_text", "update_merchandising"]],
    ["the same kind twice", ["update_text", "update_text"]],
  ])("forces a request with %s to unsupported even when the provider proposes one edit", async (_label, requestedOperations) => {
    const provider = vi.fn(async () => classified(
      '{"kind":"update_text","slot":"heroTitle","value":"Only the first edit"}',
      requestedOperations,
    ));

    await expect(classifyStoreIntent({
      ...input,
      prompt: "Change the title and the CTA",
    }, { provider })).resolves.toEqual({
      kind: "unsupported",
      message: "Please make one storefront change at a time.",
    });
  });

  it("accepts coordinated wording with a conjunction when it is one declared operation", async () => {
    const provider = vi.fn(async () => classified(
      '{"kind":"update_text","slot":"heroTitle","value":"Black and white"}',
    ));

    await expect(classifyStoreIntent({
      ...input,
      prompt: "Make the headline black and white",
    }, { provider })).resolves.toEqual({
      kind: "update_text",
      slot: "heroTitle",
      value: "Black and white",
    });
  });

  it("returns unsupported for a compound fresh-store request before enforcing design-only output", async () => {
    const provider = vi.fn(async () => classified(
      '{"kind":"select_design","prompt":"Build my store","excludedTemplateIds":[]}',
      ["select_design", "update_text"],
    ));

    await expect(classifyStoreIntent({
      prompt: "Build my store and set the headline to Summer",
      productCandidates: [],
    }, { provider })).resolves.toEqual({
      kind: "unsupported",
      message: "Please make one storefront change at a time.",
    });
  });

  it("sends each design's applicable text slots to the classifier", async () => {
    const expected = {
      "custom-bench": ["heroEyebrow", "heroTitle", "heroBody", "ctaLabel"],
      "commons-index": ["heroEyebrow", "heroTitle", "heroBody", "ctaLabel"],
      "soft-chemistry": ["heroEyebrow", "heroTitle", "heroBody", "ctaLabel"],
      "companion-field-guide": ["heroEyebrow", "heroTitle", "heroBody", "sectionHeading"],
      "daily-protocol": ["heroEyebrow", "heroTitle"],
      "room-modes": ["heroEyebrow", "heroTitle", "heroBody", "ctaLabel"],
      "rep-rest": ["heroTitle", "ctaLabel"],
      "diagnostic-deck": ["heroEyebrow", "heroTitle", "heroBody", "ctaLabel"],
      "ritual-almanac": ["heroEyebrow", "heroTitle", "heroBody", "sectionHeading", "ctaLabel"],
      "broadcast-patch-bay": ["heroEyebrow", "heroTitle", "heroBody", "sectionHeading", "ctaLabel"],
      "atelier-nine": ["announcement", "heroTitle", "heroBody", "ctaLabel"],
      larder: ["heroEyebrow", "heroTitle", "heroBody", "ctaLabel"],
    } as const;

    for (const recipe of STOREFRONT_RECIPES) {
      const provider: StoreIntentProvider = async (request) => {
        expect(JSON.parse(request.prompt).allowedTextSlots).toEqual(expected[recipe.config.templateId]);
        return classified('{"kind":"unsupported","message":"No text change requested."}');
      };
      await classifyStoreIntent({
        prompt: "Keep the copy",
        currentTemplateId: recipe.config.templateId,
        bundle: recipe.bundle,
      }, { provider });
    }
  });

  it("sends verified reference URLs as image blocks before the bounded JSON request", async () => {
    const controller = new AbortController();
    createMessage.mockResolvedValue({
      id: "message-1",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{
        type: "text",
        text: classified('{"kind":"select_design","prompt":"soft editorial skincare","excludedTemplateIds":[]}'),
      }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const url = "https://assets.example/reference.webp";
    const referencedInput = {
      prompt: "Use this reference",
      productCandidates: input.productCandidates,
      attachments: [{ kind: "design_reference" as const, assetRef: "owned/reference.webp" }],
      referenceImages: [{ url, mediaType: "image/webp" as const }],
    } as ClassifyStoreIntentInput & {
      referenceImages: Array<{ url: string; mediaType: "image/webp" }>;
    };

    await expect(classifyStoreIntent(referencedInput, {}, { signal: controller.signal })).resolves.toEqual({
      kind: "select_design",
      prompt: "Use this reference\nVisual reference cues: soft editorial skincare",
      excludedTemplateIds: [],
    });

    const request = createMessage.mock.calls[0]?.[0] as {
      system: string;
      messages: Array<{ content: unknown }>;
      output_config?: unknown;
    };
    expect(request.output_config).toMatchObject({
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          required: ["requestedOperations", "intent"],
        },
      },
    });
    const content = request.messages[0]?.content as Array<{
      type: string;
      source?: { type: string; url: string };
      text?: string;
    }>;
    expect(content[0]).toEqual({ type: "image", source: { type: "url", url } });
    expect(content.at(-1)?.type).toBe("text");
    expect(JSON.parse(content.at(-1)?.text ?? "{}")).toMatchObject({
      attachments: [{ kind: "design_reference", referenceImageIndex: 0 }],
    });
    expect(request.system).toContain("reference visuals only to describe visual cues");
    expect(request.system).toContain("Never generate storefront structure from a reference visual");
    expect(createMessage.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it("passes the command signal to a custom intent provider without cloning it", async () => {
    const controller = new AbortController();
    const provider = vi.fn(async (request: Parameters<StoreIntentProvider>[0]) => {
      expect(request.signal).toBe(controller.signal);
      return classified('{"kind":"select_design","prompt":"Build my store","excludedTemplateIds":[]}');
    });

    await expect(classifyStoreIntent({
      prompt: "Build my store",
      productCandidates: input.productCandidates,
    }, { provider }, { signal: controller.signal })).resolves.toMatchObject({ kind: "select_design" });
    expect(provider).toHaveBeenCalledOnce();
  });

  it("accepts the assembled product-title boundary and rejects titles beyond it", async () => {
    const provider = vi.fn(async () => classified(
      '{"kind":"update_merchandising","productIds":["product-long"]}'));

    await expect(classifyStoreIntent({
      ...input,
      productCandidates: [{ id: "product-long", title: "T".repeat(240) }],
    }, { provider })).resolves.toEqual({
      kind: "update_merchandising",
      productIds: ["product-long"],
    });
    await expect(classifyStoreIntent({
      ...input,
      productCandidates: [{ id: "product-long", title: "T".repeat(241) }],
    }, { provider })).rejects.toMatchObject({ code: "invalid_store_intent" });
    expect(provider).toHaveBeenCalledOnce();
  });

  it.each(["Start over", "Try another"])("keeps the fresh-store %s control non-writing", async (prompt) => {
    const provider = vi.fn(async () => '{"kind":"select_design","prompt":"Make it calm","excludedTemplateIds":[]}');

    await expect(classifyStoreIntent({ prompt, productCandidates: [] }, { provider })).resolves.toMatchObject({
      kind: "unsupported",
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    '{"kind":"update_text","slot":"heroTitle","value":"Summer starts here"}',
    '{"kind":"update_merchandising","productIds":["product-a"]}',
    '{"kind":"update_visual_layer","visualLayer":{"kind":"none"}}',
    '{"kind":"start_over","prompt":"Start over"}',
  ])("rejects non-design provider output for a fresh store: %s", async (output) => {
    const provider = vi.fn(async () => classified(output));

    await expect(classifyStoreIntent({
      prompt: "Build my store",
      productCandidates: input.productCandidates,
    }, { provider })).rejects.toMatchObject({ code: "invalid_store_intent" });
  });

  it("leaves a fresh store unchanged when no supported operation is requested", async () => {
    const provider = vi.fn(async () => classified('{"kind":"unsupported","message":"Not sure"}'));

    await expect(classifyStoreIntent({
      prompt: "Do something impossible",
      productCandidates: input.productCandidates,
    }, { provider })).resolves.toEqual({ kind: "unsupported", message: "Not sure" });
  });

  it("rejects markup returned as slot copy", async () => {
    const provider = vi.fn(async () => classified(
      '{"kind":"update_text","slot":"heroTitle","value":"<style>bad</style>"}'));

    await expect(classifyStoreIntent(input, { provider })).rejects.toMatchObject({
      code: "invalid_store_intent",
    });
  });

  it("accepts only exact closed intent JSON and declared text slots", async () => {
    const provider = vi.fn()
      .mockResolvedValueOnce(classified('{"kind":"update_text","slot":"heroTitle","value":"Summer starts here"}'))
      .mockResolvedValueOnce(classified('{"kind":"update_text","slot":"heroTitle","value":"Summer","html":"<main>"}'))
      .mockResolvedValueOnce(classified('{"kind":"update_text","slot":"notDeclared","value":"Summer"}'));

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
      .mockResolvedValueOnce(classified('{"kind":"update_text","slot":"announcement","value":"Free shipping"}'))
      .mockResolvedValueOnce(classified('{"kind":"update_text","slot":"heroTitle","value":"Wrong route"}'));

    await expect(classifyStoreIntent(input, { provider })).rejects.toMatchObject({ code: "invalid_store_intent" });
    await expect(classifyStoreIntent({
      ...input,
      context: { routeId: "product", slot: "heroTitle" },
    }, { provider })).rejects.toMatchObject({ code: "invalid_store_intent" });
  });

  it("rejects ambiguous concrete text targets with or without home context", async () => {
    const provider = vi.fn(async () => classified(
      '{"kind":"update_text","slot":"heroTitle","value":"One target only"}'));
    const ambiguousInput = { ...input, bundle: ambiguousHeroBundle() };

    await expect(classifyStoreIntent(ambiguousInput, { provider }))
      .rejects.toMatchObject({ code: "invalid_store_intent" });
    await expect(classifyStoreIntent({
      ...ambiguousInput,
      context: { routeId: "home", slot: "heroTitle" },
    }, { provider })).rejects.toMatchObject({ code: "invalid_store_intent" });
    await expect(classifyStoreIntent({
      ...input,
      bundle: crossBlueprintHeroBundle(),
      context: { routeId: "home", slot: "heroTitle" },
    }, { provider })).rejects.toMatchObject({ code: "invalid_store_intent" });
  });

  it("keeps design exclusions deterministic", async () => {
    const provider = vi.fn(async () => classified(
      '{"kind":"select_design","prompt":"More editorial","excludedTemplateIds":["atelier-nine"]}'));

    await expect(classifyStoreIntent({ ...input, prompt: "Make it more editorial" }, { provider })).resolves.toEqual({
      kind: "select_design",
      prompt: "Make it more editorial",
      excludedTemplateIds: ["soft-chemistry", "custom-bench"],
    });
  });

  it("clears a stale exclusion when the merchant explicitly names that design", async () => {
    const provider = vi.fn(async () => classified(
      '{"kind":"select_design","prompt":"Use Soft Chemistry","excludedTemplateIds":[]}'));

    await expect(classifyStoreIntent({ ...input, prompt: "Use Soft Chemistry" }, { provider })).resolves.toEqual({
      kind: "select_design",
      prompt: "Use Soft Chemistry",
      excludedTemplateIds: ["custom-bench"],
    });
  });

  it("routes the original design prompt and its explicit exclusions, not a model rewrite", async () => {
    const provider = vi.fn(async () => classified(
      '{"kind":"select_design","prompt":"clean skincare","excludedTemplateIds":[]}'));

    await expect(classifyStoreIntent({
      prompt: "Anything except Soft Chemistry",
      productCandidates: [],
    }, { provider })).resolves.toEqual({
      kind: "select_design",
      prompt: "Anything except Soft Chemistry",
      excludedTemplateIds: ["soft-chemistry"],
    });
  });

  it("routes a non-exact restart with the original prompt and exclusions, not a model rewrite", async () => {
    const provider = vi.fn(async () => classified(
      '{"kind":"start_over","prompt":"Start over"}'));

    await expect(classifyStoreIntent({
      ...input,
      prompt: "Start over, but not Soft Chemistry",
    }, { provider })).resolves.toEqual({
      kind: "start_over",
      prompt: "Start over, but not Soft Chemistry",
    });
  });

  it("intercepts exact commands without provider routing", async () => {
    const provider = vi.fn(async () => classified('{"kind":"unsupported","message":"model"}'));

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

  it.each(["make store", "build store", "build my store"])(
    "routes %s through the approved design library even when a draft exists",
    async (prompt) => {
      const provider = vi.fn(async () => classified('{"kind":"unsupported","message":"model"}'));

      await expect(classifyStoreIntent({ ...input, prompt }, { provider })).resolves.toEqual({
        kind: "select_design",
        prompt,
        excludedTemplateIds: ["soft-chemistry", "custom-bench"],
      });
      expect(provider).not.toHaveBeenCalled();
    },
  );

  it("sends every near-match command to the provider", async () => {
    const provider = vi.fn(async () => classified('{"kind":"unsupported","message":"Handled by the model."}'));

    for (const prompt of ["undo", " Undo", "Publish ", "START   OVER", "try another"]) {
      await expect(classifyStoreIntent({ ...input, prompt }, { provider })).resolves.toEqual({
        kind: "unsupported",
        message: "Handled by the model.",
      });
    }
    expect(provider).toHaveBeenCalledTimes(5);
  });

  it("caps provider input and output", async () => {
    const provider = vi.fn(async () => "x".repeat(8_001));

    await expect(classifyStoreIntent({ ...input, prompt: "x".repeat(4_001) }, { provider }))
      .rejects.toMatchObject({ code: "invalid_store_intent" });
    expect(provider).not.toHaveBeenCalled();

    await expect(classifyStoreIntent(input, { provider })).rejects.toMatchObject({ code: "invalid_store_intent" });
  });

  it("sends the full parser-valid Unicode prompt boundary to the provider", async () => {
    const provider = vi.fn(async () => classified('{"kind":"unsupported","message":"Prompt accepted."}'));

    await expect(classifyStoreIntent({ ...input, prompt: "🧶".repeat(4_000) }, { provider })).resolves.toEqual({
      kind: "unsupported",
      message: "Prompt accepted.",
    });
    await expect(classifyStoreIntent({ ...input, prompt: "🧶".repeat(4_001) }, { provider }))
      .rejects.toMatchObject({ code: "invalid_store_intent" });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("validates parser-valid Unicode at the provider output boundary without routing a rewrite", async () => {
    const prompt = "🧶".repeat(4_000);
    const provider = vi.fn(async () => classified(JSON.stringify({ kind: "start_over", prompt })));

    await expect(classifyStoreIntent(input, { provider })).resolves.toEqual({
      kind: "start_over",
      prompt: input.prompt,
    });
  });

  it("validates bounded merchandising and visual-layer results", async () => {
    const provider = vi.fn()
      .mockResolvedValueOnce(classified('{"kind":"update_merchandising","productIds":["product-a","product-b"]}'))
      .mockResolvedValueOnce(classified('{"kind":"update_visual_layer","visualLayer":{"kind":"fragment_shader","source":"void main(){}","colors":["#000000","#111111","#222222"]}}'))
      .mockResolvedValueOnce(classified(`{"kind":"update_visual_layer","visualLayer":{"kind":"fragment_shader","source":"${"x".repeat(4_001)}","colors":["#000000","#111111","#222222"]}}`))
      .mockResolvedValueOnce(classified('{"kind":"update_merchandising","productIds":["product-a"," product-a"]}'))
      .mockResolvedValueOnce(classified('{"kind":"update_merchandising","productIds":["invented-product"]}'))
      .mockResolvedValueOnce(classified('{"kind":"update_visual_layer","visualLayer":{"kind":"fragment_shader","source":"void main(){}","colors":[" #000000","#111111","#222222"]}}'));

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
    await expect(classifyStoreIntent(input, { provider })).rejects.toMatchObject({ code: "invalid_store_intent" });
  });

  it("preserves an attached merchant shader outside the model", async () => {
    const providerPrompts: string[] = [];
    const provider = vi.fn(async (request: { prompt: string }) => {
      providerPrompts.push(request.prompt);
      return classified('{"kind":"update_visual_layer","visualLayer":{"kind":"fragment_shader","source":"model rewrite","colors":["#000000","#111111","#222222"]}}');
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

  it("uses the validated bundle and context snapshot after the provider yields", async () => {
    const deferred = deferredProvider();
    const mutable = mutableInput();
    mutable.context = { routeId: "home", slot: "heroTitle" };
    const pending = classifyStoreIntent(mutable, { provider: deferred.provider });

    mutable.context.slot = "heroBody";
    mutable.bundle!.routes.home.tree = [];
    deferred.resolve(classified('{"kind":"update_text","slot":"heroTitle","value":"Snapshot copy"}'));

    await expect(pending).resolves.toEqual({
      kind: "update_text",
      slot: "heroTitle",
      value: "Snapshot copy",
    });
  });

  it("uses validated candidate and exclusion snapshots after the provider yields", async () => {
    const merchandising = deferredProvider();
    const merchandisingInput = mutableInput();
    const merchandisingPending = classifyStoreIntent(merchandisingInput, { provider: merchandising.provider });
    merchandisingInput.productCandidates![0]!.id = "mutated-product";
    merchandising.resolve(classified('{"kind":"update_merchandising","productIds":["product-a"]}'));
    await expect(merchandisingPending).resolves.toEqual({
      kind: "update_merchandising",
      productIds: ["product-a"],
    });

    const design = deferredProvider();
    const designInput = mutableInput();
    const designPending = classifyStoreIntent(designInput, { provider: design.provider });
    designInput.excludedTemplateIds![0] = "atelier-nine";
    design.resolve(classified('{"kind":"select_design","prompt":"More editorial","excludedTemplateIds":[]}'));
    await expect(designPending).resolves.toEqual({
      kind: "select_design",
      prompt: "Change the headline",
      excludedTemplateIds: ["soft-chemistry", "custom-bench"],
    });
  });

  it("restores the validated shader snapshot after the provider yields", async () => {
    const deferred = deferredProvider();
    const mutable = mutableInput();
    const source = "void main(){ gl_FragColor = vec4(1.0); }";
    mutable.attachments = [{ kind: "fragment_shader", source }];
    const pending = classifyStoreIntent(mutable, { provider: deferred.provider });
    const attachment = mutable.attachments[0];
    if (attachment?.kind !== "fragment_shader") throw new Error("Missing shader attachment");
    attachment.source = "mutated source";
    deferred.resolve(classified('{"kind":"update_visual_layer","visualLayer":{"kind":"fragment_shader","source":"model rewrite","colors":["#000000","#111111","#222222"]}}'));

    await expect(pending).resolves.toEqual({
      kind: "update_visual_layer",
      visualLayer: { kind: "fragment_shader", source, colors: ["#000000", "#111111", "#222222"] },
    });
  });

  it.each([
    "not json",
    "[]",
    '{"kind":"unknown"}',
    '{"kind":"unsupported","message":"Okay"} trailing prose',
  ])("rejects malformed provider output: %s", async (raw) => {
    await expect(classifyStoreIntent(input, { provider: async () => raw }))
      .rejects.toMatchObject({ code: "invalid_store_intent" });
  });

  it("propagates provider failures without creating an intent", async () => {
    const failure = new Error("provider unavailable");
    await expect(classifyStoreIntent(input, {
      provider: async () => { throw failure; },
    })).rejects.toBe(failure);
  });
});
