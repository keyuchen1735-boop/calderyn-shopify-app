import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseStorefrontVersionArtifact } from "../storefront-ai/authoring.server";
import type { MerchantStorefrontContext } from "../storefront-ai/contracts";
import { STORE_TEMPLATE_REGISTRY } from "../storefront-bundle/registry";
import { resolveStoreDesign } from "../storefront-bundle/routing";
import type { StorefrontBundleV1 } from "../storefront-bundle/types";
import { validateCompiledBundle } from "../storefront-compiler/validate";
import { applyStoreIntent } from "../storefront-command/apply";
import {
  runStoreCommand,
  type LoadedStoreCommandVersion,
  type StoreCommandDependencies,
  type StoreCommandState,
} from "../storefront-command/command.server";
import type { PreviewContext, StoreAttachment, StoreCommand, StoreCommandReceipt } from "../storefront-command/types";
import { undoStorefrontEdit } from "../storefront-edit/undo.server";
import { STOREFRONT_RECIPES } from "../storefront-recipes";

interface StoreCommandHarnessOptions {
  shopId: string;
  context: MerchantStorefrontContext;
  classify: StoreCommandDependencies["classify"];
  initialBundle?: StorefrontBundleV1;
  resolveDesign?: StoreCommandDependencies["resolveDesign"];
  prove?: StoreCommandDependencies["prove"];
  hashArtifact?: StoreCommandDependencies["hashArtifact"];
  redesign?: StoreCommandDependencies["redesign"];
  customRedesignEnabled?: boolean;
  editConflict?: () => boolean;
  isInstallable?: (input: {
    bundle: StorefrontBundleV1;
    resolution: Record<string, unknown>;
    status: string;
  }) => boolean;
}

interface HarnessVersion extends LoadedStoreCommandVersion {
  installable: boolean;
}

function artifactHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function hashKey(input: Parameters<StoreCommandDependencies["hashArtifact"]>[0]): string {
  return JSON.stringify({
    schemaVersion: input.schemaVersion,
    runtimeVersion: input.runtimeVersion,
    validationProfileVersion: input.validationProfileVersion,
    artifact: input.artifact,
    assetManifest: input.assetManifest,
  });
}

function conflict(): Error & { code: string; status: number } {
  return Object.assign(new Error("stale pointer"), {
    code: "storefront_draft_conflict",
    status: 409,
  });
}

export function createStoreCommandHarness(options: StoreCommandHarnessOptions) {
  const context = structuredClone(options.context);
  const references = {
    products: Object.fromEntries(context.products.map(({ id, handle }) => [id, { id, handle }])),
    collections: Object.fromEntries(context.collections.map(({ id, handle }) => [id, { id, handle }])),
    assets: Object.fromEntries(context.reusableAssets.map(({ assetKey }) => [assetKey, assetKey])),
  };
  const versions = new Map<string, HarnessVersion>();
  const edits = new Map<string, { baseVersionId: string; resultVersionId: string }>();
  const hashResults = new Map<string, string>();
  const delegateHash = options.hashArtifact ?? (async (input) => artifactHash(JSON.parse(hashKey(input))));
  const hashArtifact: StoreCommandDependencies["hashArtifact"] = async (input) => {
    const result = await delegateHash(input);
    hashResults.set(hashKey(input), result);
    return result;
  };
  let sequence = 0;
  let redesignCallCount = 0;
  const nextVersionId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  let state: StoreCommandState = { draft: null, publishedVersionId: null };

  if (options.initialBundle) {
    const bundle = structuredClone(options.initialBundle);
    if (bundle.source.kind !== "recipe") throw new Error("command proof requires a recipe bundle");
    const artifact = { sourceKind: "recipe" as const, bundle };
    const versionId = nextVersionId();
    const version = {
      versionId,
      artifactHash: artifactHash({
        schemaVersion: bundle.schemaVersion,
        runtimeVersion: bundle.runtimeVersion,
        validationProfileVersion: bundle.validationProfileVersion,
        artifact,
        assetManifest: bundle.assets,
      }),
      artifact,
      bundle,
      resolution: {
        kind: "recipe",
        templateId: bundle.source.templateId,
        templateVersion: bundle.source.templateVersion,
        excludedTemplateIds: [],
      },
      installable: true,
    } satisfies HarnessVersion;
    versions.set(versionId, version);
    const { installable: _installable, ...draft } = version;
    state = { ...state, draft: structuredClone(draft) };
  }

  const prove: StoreCommandDependencies["prove"] = options.prove
    ?? (async () => ({ ok: true, diagnostics: [], screenshots: [], browserMs: 0 }));
  const createVersion: StoreCommandDependencies["createVersion"] = async (input) => {
    const bundle = structuredClone((input.artifact as { bundle: StorefrontBundleV1 }).bundle);
    const versionId = nextVersionId();
    const resolution = structuredClone(input.resolution);
    let parsedArtifact: ReturnType<typeof parseStorefrontVersionArtifact> | null = null;
    try { parsedArtifact = parseStorefrontVersionArtifact(input.artifact); } catch { /* invalid remains non-installable */ }
    const installable = input.status === "validated"
      && parsedArtifact !== null
      && input.sourceKind === bundle.source.kind
      && (input.sourceKind !== "custom" || Boolean(parsedArtifact.authoring))
      && input.schemaVersion === 1
      && input.runtimeVersion === 1
      && input.validationProfileVersion === 1
      && validateCompiledBundle(bundle).ok
      && (options.isInstallable?.({ bundle, resolution, status: input.status }) ?? true);
    const inputHash = hashResults.get(hashKey(input));
    versions.set(versionId, {
      versionId,
      artifactHash: inputHash ?? "unhashed",
      artifact: structuredClone(input.artifact) as unknown as LoadedStoreCommandVersion["artifact"],
      bundle,
      resolution,
      installable,
    });
    return versionId;
  };
  const edit: StoreCommandDependencies["edit"] = async (input) => {
    if (state.draft?.versionId !== input.expectedDraftVersionId) throw conflict();
    const base = versions.get(input.baseVersionId);
    const result = versions.get(input.resultVersionId);
    if (!base
      || !result
      || !result.installable
      || input.baseVersionId !== input.expectedDraftVersionId
      || base.artifactHash !== input.baseArtifactHash
      || result.artifactHash !== input.resultArtifactHash) throw conflict();
    if (options.editConflict?.()) throw conflict();
    edits.set(input.resultVersionId, {
      baseVersionId: input.baseVersionId,
      resultVersionId: input.resultVersionId,
    });
    const { installable: _installable, ...draft } = result;
    state = { ...state, draft: structuredClone(draft) };
    return input.resultVersionId;
  };

  const dependencies: StoreCommandDependencies = {
    loadState: async () => structuredClone(state),
    assertWriteAllowed: async () => undefined,
    assertPublishable: async () => undefined,
    readEnabled: () => true,
    recipeBuildEnabled: () => true,
    publishEnabled: () => true,
    customRedesignEnabled: () => options.customRedesignEnabled ?? Boolean(options.redesign),
    buildEvidence: async () => ({
      productTitles: context.products.map(({ title }) => title),
      productTypes: context.products.flatMap(({ productType }) => productType ? [productType] : []),
      productTags: context.products.flatMap(({ tags }) => tags),
      optionNames: context.products.flatMap(({ optionNames }) => optionNames),
      collectionTitles: context.collections.map(({ title }) => title),
      fingerprint: context.fingerprint,
    }),
    loadReferenceImages: async () => [],
    loadContext: async ({ prompt }) => ({
      context: { ...structuredClone(context), prompt },
      references: structuredClone(references),
    }),
    prepareProductMedia: async () => 0,
    classify: options.classify,
    resolveDesign: options.resolveDesign
      ?? ((request, evidence) => resolveStoreDesign(request, evidence, STORE_TEMPLATE_REGISTRY)),
    loadRecipe: async (templateId, templateVersion) => {
      const recipe = STOREFRONT_RECIPES.find(
        ({ config }) => config.templateId === templateId && config.templateVersion === templateVersion,
      );
      if (!recipe) throw new Error("command proof recipe missing");
      return structuredClone(recipe);
    },
    applyIntent: applyStoreIntent,
    validate: validateCompiledBundle,
    prove,
    redesign: async (input) => {
      redesignCallCount += 1;
      if (!options.redesign) throw new Error("command proof redesign missing");
      return options.redesign(input);
    },
    installRedesign: async (input) => {
      if (input.signal?.aborted
        || state.draft?.versionId !== input.expectedDraftVersionId
        || input.baseVersionId !== input.expectedDraftVersionId
        || state.draft.artifactHash !== input.baseArtifactHash) throw conflict();
      let artifact;
      try {
        artifact = parseStorefrontVersionArtifact(input.artifact);
      } catch {
        throw conflict();
      }
      const bundle = structuredClone(artifact.bundle);
      const staticValidation = input.validationReport.static as { ok?: unknown } | undefined;
      const browserProof = input.validationReport.browserProof as { ok?: unknown } | undefined;
      if (artifact.sourceKind !== "custom" || !artifact.authoring
        || input.schemaVersion !== bundle.schemaVersion
        || input.runtimeVersion !== bundle.runtimeVersion
        || input.validationProfileVersion !== bundle.validationProfileVersion
        || !isDeepStrictEqual(input.assetManifest, bundle.assets)
        || input.validationReport.valid !== true
        || staticValidation?.ok !== true
        || browserProof?.ok !== true
        || !validateCompiledBundle(bundle).ok
        || !input.prompt.trim()
        || input.scope === null || typeof input.scope !== "object"
        || input.patch === null || typeof input.patch !== "object"
        || input.provider === null || typeof input.provider !== "object"
        || input.validation === null || typeof input.validation !== "object") throw conflict();
      const canonicalHash = hashResults.get(hashKey({
        schemaVersion: input.schemaVersion,
        runtimeVersion: input.runtimeVersion,
        validationProfileVersion: input.validationProfileVersion,
        artifact: input.artifact as unknown as Record<string, unknown>,
        assetManifest: input.assetManifest,
      }));
      if (canonicalHash !== input.resultArtifactHash
        || state.draft?.versionId !== input.expectedDraftVersionId
        || !(options.isInstallable?.({ bundle, resolution: input.resolution, status: "validated" }) ?? true)
        || options.editConflict?.()) throw conflict();
      const versionId = nextVersionId();
      const version = {
        versionId,
        artifactHash: input.resultArtifactHash,
        artifact: structuredClone(input.artifact),
        bundle,
        resolution: structuredClone(input.resolution),
        installable: true,
      } satisfies HarnessVersion;
      versions.set(versionId, version);
      edits.set(versionId, { baseVersionId: input.baseVersionId, resultVersionId: versionId });
      const { installable: _installable, ...draft } = version;
      state = { ...state, draft: structuredClone(draft) };
      return versionId;
    },
    hashArtifact,
    createVersion,
    install: async (input) => {
      if ((state.draft?.versionId ?? null) !== input.expectedDraftVersionId) throw conflict();
      const result = versions.get(input.versionId);
      if (!result?.installable) throw conflict();
      const { installable: _installable, ...draft } = result;
      state = { ...state, draft: structuredClone(draft) };
      return input.versionId;
    },
    edit,
    undo: (input) => undoStorefrontEdit(input, {
      loadDraft: async () => state.draft ? structuredClone(state.draft) : null,
      loadVersion: async (_shopId, versionId) => {
        const version = versions.get(versionId);
        return version ? structuredClone(version) : null;
      },
      loadEditAudit: async ({ resultVersionId }) => structuredClone(edits.get(resultVersionId) ?? null),
      validate: validateCompiledBundle,
      loadProofContext: async ({ prompt }) => ({
        context: { ...structuredClone(context), prompt },
        references: structuredClone(references),
      }),
      prove,
      hashArtifact,
      createVersion,
      editDraft: edit,
      restoreCustomVersion: async (input) => {
        const base = state.draft;
        const target = versions.get(input.targetVersionId);
        if (input.signal?.aborted
          || !base
          || base.versionId !== input.expectedDraftVersionId
          || base.versionId !== input.baseVersionId
          || base.artifactHash !== input.baseArtifactHash
          || !target
          || target.artifactHash !== input.targetArtifactHash
          || target.bundle.source.kind !== "custom"
          || options.editConflict?.()
          || !(options.isInstallable?.({ bundle: target.bundle, resolution: input.resolution, status: "validated" }) ?? true)) {
          throw conflict();
        }
        const versionId = nextVersionId();
        const version = {
          ...structuredClone(target),
          versionId,
          resolution: structuredClone(input.resolution),
          installable: true,
        } satisfies HarnessVersion;
        versions.set(versionId, version);
        edits.set(versionId, { baseVersionId: base.versionId, resultVersionId: versionId });
        const { installable: _installable, ...draft } = version;
        state = { ...state, draft };
        return versionId;
      },
    }),
    publish: async (input) => {
      if (state.draft?.versionId !== input.expectedDraftVersionId
        || state.publishedVersionId !== input.expectedPublishedVersionId) throw conflict();
      state = { ...state, publishedVersionId: input.expectedDraftVersionId };
      return input.expectedDraftVersionId;
    },
  };

  const run = (command: StoreCommand, signal?: AbortSignal): Promise<StoreCommandReceipt> =>
    runStoreCommand({ shopId: options.shopId, command, ...(signal ? { signal } : {}) }, dependencies);

  const prompt = async (
    value: string,
    attachments?: StoreAttachment[],
    context?: PreviewContext,
  ) => {
    const receipt = await run({
      kind: "prompt",
      prompt: value,
      expectedDraftVersionId: state.draft?.versionId ?? null,
      ...(attachments ? { attachments } : {}),
      ...(context ? { context } : {}),
    });
    if (receipt.status !== "installed") throw new Error(`${value} did not install a proof artifact`);
    const draft = state.draft;
    if (!draft) throw new Error(`${value} installed without a draft`);
    return {
      ...receipt,
      bundle: structuredClone(draft.bundle),
      ...(draft.artifact?.authoring ? { authoring: structuredClone(draft.artifact.authoring) } : {}),
    };
  };

  const undo = async () => {
    const draft = state.draft;
    const audit = draft ? edits.get(draft.versionId) : undefined;
    if (!draft || !audit) throw new Error("command proof has no undo target");
    return run({ kind: "undo", targetVersionId: audit.baseVersionId, expectedDraftVersionId: draft.versionId });
  };

  const publish = async () => {
    if (!state.draft) throw new Error("command proof has no draft to publish");
    return run({ kind: "publish", expectedDraftVersionId: state.draft.versionId });
  };

  return {
    prompt,
    undo,
    publish,
    run,
    state: () => structuredClone(state),
    versionCount: () => versions.size,
    editCount: () => edits.size,
    redesignCalls: () => redesignCallCount,
    currentVersionId: () => state.draft?.versionId ?? null,
    publishedVersionId: () => state.publishedVersionId,
  };
}
