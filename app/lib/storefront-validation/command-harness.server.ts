import { createHash } from "node:crypto";
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
import type { StoreAttachment, StoreCommand, StoreCommandReceipt } from "../storefront-command/types";
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

function artifactHash(bundle: StorefrontBundleV1): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(bundle)).digest("hex")}`;
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
  let sequence = 0;
  const nextVersionId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  let state: StoreCommandState = { draft: null, publishedVersionId: null };

  if (options.initialBundle) {
    const bundle = structuredClone(options.initialBundle);
    if (bundle.source.kind !== "recipe") throw new Error("command proof requires a recipe bundle");
    const versionId = nextVersionId();
    const version = {
      versionId,
      artifactHash: artifactHash(bundle),
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
  const hashArtifact: StoreCommandDependencies["hashArtifact"] = options.hashArtifact
    ?? (async ({ artifact }) => artifactHash((artifact as { bundle: StorefrontBundleV1 }).bundle));
  const createVersion: StoreCommandDependencies["createVersion"] = async (input) => {
    const bundle = structuredClone((input.artifact as { bundle: StorefrontBundleV1 }).bundle);
    const versionId = nextVersionId();
    const resolution = structuredClone(input.resolution);
    const installable = input.status === "validated"
      && input.sourceKind === "recipe"
      && input.schemaVersion === 1
      && input.runtimeVersion === 1
      && input.validationProfileVersion === 1
      && validateCompiledBundle(bundle).ok
      && (options.isInstallable?.({ bundle, resolution, status: input.status }) ?? true);
    versions.set(versionId, {
      versionId,
      artifactHash: artifactHash(bundle),
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
    }),
    publish: async (input) => {
      if (state.draft?.versionId !== input.expectedDraftVersionId
        || state.publishedVersionId !== input.expectedPublishedVersionId) throw conflict();
      state = { ...state, publishedVersionId: input.expectedDraftVersionId };
      return input.expectedDraftVersionId;
    },
  };

  const run = (command: StoreCommand): Promise<StoreCommandReceipt> =>
    runStoreCommand({ shopId: options.shopId, command }, dependencies);

  const prompt = async (
    value: string,
    attachments?: StoreAttachment[],
  ): Promise<Extract<StoreCommandReceipt, { status: "installed" }>> => {
    const receipt = await run({
      kind: "prompt",
      prompt: value,
      expectedDraftVersionId: state.draft?.versionId ?? null,
      ...(attachments ? { attachments } : {}),
    });
    if (receipt.status !== "installed") throw new Error(`${value} did not install a proof artifact`);
    return receipt;
  };

  return {
    prompt,
    run,
    state: () => structuredClone(state),
    versionCount: () => versions.size,
  };
}
