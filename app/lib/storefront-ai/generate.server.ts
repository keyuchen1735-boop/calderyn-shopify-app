import { createHash, randomUUID } from "node:crypto";
import { persistExternalImage } from "~/lib/assets/persist.server";
import { getSupabase } from "~/lib/supabase.server";
import { assertCanGenerate } from "~/lib/storegen/guard.server";
import { getImageProvider } from "~/lib/storegen/imagery/provider.server";
import { attachVerifiedStorefrontAsset, persistStorefrontAssetBytes } from "../storefront-bundle/assets.server";
import {
  createStorefrontBundleVersion,
  hashStorefrontArtifact,
  installStorefrontDraft,
  validateStorefrontBundleVersion,
} from "../storefront-bundle/release.server";
import { compileBundle } from "../storefront-compiler/compile";
import { materializeOwnedAssets } from "./assets.server";
import { compileConceptCandidate, exploreConcepts, renderConceptWithMerchantData } from "./concepts.server";
import { assembleStorefrontContext } from "./context.server";
import type {
  GenerateDependencies,
  GenerateOriginalStorefrontInput,
  GenerateOriginalStorefrontResult,
  GenerationAudit,
  GenerationBudget,
  GenerationCheckpoint,
  GenerationUsage,
  InstallValidatedBundleInput,
  MaterializedAssetResult,
  ModelUsage,
  StorefrontAiProvider,
} from "./contracts";
import { expandWinningConcept, expandedBundleSource } from "./expand.server";
import { rankConcepts } from "./judge.server";
import { createAnthropicStructuredProvider } from "./provider.server";
import { proveAndRepairBundle, repairRouteWithProvider } from "./proof.server";
import { STOREFRONT_AI_PROMPT_VERSION } from "./prompts";

const DEFAULT_BUDGET: GenerationBudget = {
  maxCandidates: 3,
  maxModelTokens: 180_000,
  maxImages: 6,
  maxBrowserMs: 180_000,
  maxRepairs: 8,
  maxWallMs: 10 * 60_000,
};

export class GenerationBudgetError extends Error {
  constructor(public readonly dimension: keyof GenerationBudget) {
    super(`Generation budget exceeded: ${dimension}`);
    this.name = "GenerationBudgetError";
  }
}

class BudgetMeter {
  readonly limits: GenerationBudget;
  readonly usage: GenerationUsage;

  constructor(
    overrides: GenerateOriginalStorefrontInput["budget"],
    private readonly startedAt: number,
    private readonly now: () => number,
    private readonly signal?: AbortSignal,
  ) {
    this.limits = { ...DEFAULT_BUDGET, ...overrides };
    this.usage = { candidates: 0, modelTokens: 0, images: 0, browserMs: 0, repairs: 0, wallMs: 0 };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isFinite(value) || value < 0) throw new GenerationBudgetError(key as keyof GenerationBudget);
    }
  }

  check(): void {
    if (this.signal?.aborted) {
      if (this.signal.reason instanceof Error) throw this.signal.reason;
      throw new DOMException("Generation cancelled", "AbortError");
    }
    this.usage.wallMs = Math.max(0, this.now() - this.startedAt);
    if (this.usage.wallMs > this.limits.maxWallMs) throw new GenerationBudgetError("maxWallMs");
  }

  candidates(count: number): void {
    this.usage.candidates += count;
    if (this.usage.candidates > this.limits.maxCandidates) throw new GenerationBudgetError("maxCandidates");
    this.check();
  }

  model(usage: ModelUsage): void {
    this.usage.modelTokens += usage.inputTokens + usage.outputTokens;
    if (this.usage.modelTokens > this.limits.maxModelTokens) throw new GenerationBudgetError("maxModelTokens");
    this.check();
  }

  image(): void {
    this.usage.images += 1;
    if (this.usage.images > this.limits.maxImages) throw new GenerationBudgetError("maxImages");
    this.check();
  }

  browser(milliseconds: number): void {
    this.usage.browserMs += Math.max(0, milliseconds);
    if (this.usage.browserMs > this.limits.maxBrowserMs) throw new GenerationBudgetError("maxBrowserMs");
    this.check();
  }

  repair(count = 1): void {
    this.usage.repairs += count;
    if (this.usage.repairs > this.limits.maxRepairs) throw new GenerationBudgetError("maxRepairs");
    this.check();
  }

  snapshot(): GenerationUsage {
    this.check();
    return { ...this.usage };
  }
}

type BrowserProofAdapter = GenerateDependencies["browserProof"];
let browserProofAdapter: BrowserProofAdapter | null = null;

/** Task 12 registers the Chromium proof implementation here. The custom build
 * path fails closed until a real browser gate is installed. */
export function registerStorefrontAiBrowserProof(adapter: BrowserProofAdapter): () => void {
  browserProofAdapter = adapter;
  return () => {
    if (browserProofAdapter === adapter) browserProofAdapter = null;
  };
}

async function defaultProduceAsset(input: Parameters<GenerateDependencies["produceAsset"]>[0]) {
  const imageProvider = getImageProvider();
  const generated = await imageProvider.generateListingImage({
    productTitle: input.context.store.name,
    productDescription: `${input.request.purpose}. ${input.context.prompt}`.slice(0, 2_000),
    sourceImageUrl: null,
    mode: "lifestyle_scene",
  });
  const captured = await persistExternalImage(input.shopId, generated.url, "storefront-editorial", "generated");
  if (!captured.persisted) return null;
  const downloaded = await getSupabase().storage.from("shop-assets").download(captured.storageKey);
  if (downloaded.error || !downloaded.data) return null;
  return {
    bytes: new Uint8Array(await downloaded.data.arrayBuffer()),
    provenance: `${imageProvider.name}:generated:${captured.assetId}`,
  };
}

async function defaultInstallValidatedBundle(input: InstallValidatedBundleInput): Promise<{
  versionId: string;
  installedDraftVersionId: string;
  artifactHash: string;
}> {
  const artifact = { sourceKind: "custom", bundle: input.bundle } as unknown as Record<string, unknown>;
  const assetManifest = input.bundle.assets as unknown as Record<string, unknown>;
  const databaseArtifactHash = await hashStorefrontArtifact({
    schemaVersion: input.bundle.schemaVersion,
    runtimeVersion: input.bundle.runtimeVersion,
    validationProfileVersion: input.bundle.validationProfileVersion,
    artifact,
    assetManifest,
  });
  input.audit.finalArtifactHash = databaseArtifactHash;
  const versionId = await createStorefrontBundleVersion({
    shopId: input.shopId,
    sourceKind: "custom",
    status: "candidate",
    schemaVersion: input.bundle.schemaVersion,
    runtimeVersion: input.bundle.runtimeVersion,
    validationProfileVersion: input.bundle.validationProfileVersion,
    artifact,
    assetManifest,
    validationReport: null,
    generationPrompt: input.prompt,
    resolution: { kind: "custom_compiler", audit: input.audit },
  });
  for (const asset of input.persistedAssets) {
    await attachVerifiedStorefrontAsset({
      shopId: input.shopId,
      bundleId: versionId,
      logicalKey: asset.logicalKey,
      assetKey: asset.assetKey,
    });
  }
  await validateStorefrontBundleVersion({
    shopId: input.shopId,
    versionId,
    artifactHash: databaseArtifactHash,
    validationReport: { ...input.validationReport, compilerArtifactHash: input.artifactHash },
  });
  const installedDraftVersionId = await installStorefrontDraft({
    shopId: input.shopId,
    versionId,
    expectedDraftVersionId: input.expectedDraftVersionId,
    actorId: input.actorId,
  });
  return { versionId, installedDraftVersionId, artifactHash: databaseArtifactHash };
}

export function createDefaultGenerateDependencies(): GenerateDependencies {
  let resolvedProvider: StorefrontAiProvider | null = null;
  const provider: StorefrontAiProvider = {
    complete: (request) => (resolvedProvider ??= createAnthropicStructuredProvider()).complete(request),
  };
  return {
    enabled: () => process.env.STOREFRONT_CUSTOM_BUILD === "1",
    preflight: ({ shopId, prompt, trusted }) => assertCanGenerate(shopId, prompt, { trusted }),
    assembleContext: (input) => assembleStorefrontContext(input),
    provider,
    compileConcept: compileConceptCandidate,
    renderConcept: renderConceptWithMerchantData,
    produceAsset: defaultProduceAsset,
    persistAsset: ({ shopId, bytes }) => persistStorefrontAssetBytes({ shopId, bytes }),
    compileBundle,
    browserProof: async (input) => {
      if (!browserProofAdapter) throw new Error("Storefront custom build browser proof is unavailable");
      return browserProofAdapter(input);
    },
    repairRoute: (input) => repairRouteWithProvider(input),
    installValidatedBundle: defaultInstallValidatedBundle,
    checkpoint: async () => undefined,
    now: () => Date.now(),
    randomId: () => randomUUID(),
  };
}

function mergeAssetRequests(...sets: Array<readonly { key: string; purpose: string; required: boolean; aspectRatio?: number }[]>): Array<{ key: string; purpose: string; required: boolean; aspectRatio?: number }> {
  const merged = new Map<string, { key: string; purpose: string; required: boolean; aspectRatio?: number }>();
  for (const request of sets.flat()) {
    const existing = merged.get(request.key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(request)) throw new Error(`Conflicting asset request ${request.key}`);
    merged.set(request.key, request);
  }
  return [...merged.values()];
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError");
}

export async function generateOriginalStorefront(
  input: GenerateOriginalStorefrontInput,
  dependencies?: GenerateDependencies,
): Promise<GenerateOriginalStorefrontResult> {
  const deps = dependencies ?? createDefaultGenerateDependencies();
  if (!deps.enabled()) return { status: "disabled", code: "storefront_custom_build_disabled" };

  const generationId = deps.randomId();
  const startedAt = deps.now();
  const pipelineController = new AbortController();
  const meter = new BudgetMeter(input.budget, startedAt, deps.now, pipelineController.signal);
  const forwardAbort = () => pipelineController.abort(input.signal?.reason ?? new DOMException("Generation cancelled", "AbortError"));
  if (input.signal?.aborted) forwardAbort();
  else input.signal?.addEventListener("abort", forwardAbort, { once: true });
  const wallTimer = setTimeout(() => {
    pipelineController.abort(new GenerationBudgetError("maxWallMs"));
  }, meter.limits.maxWallMs);
  const pipelineSignal = pipelineController.signal;
  const providerCalls: GenerationAudit["providerCalls"] = [];
  const rejectedCandidates: GenerationAudit["rejectedCandidates"] = [];
  const candidateScores: GenerationAudit["candidateScores"] = [];
  const meteredProvider: StorefrontAiProvider = {
    async complete(request) {
      meter.check();
      const response = await deps.provider.complete(request);
      meter.model(response.usage);
      providerCalls.push({ operation: request.operation, provider: response.provider, model: response.model, usage: response.usage });
      return response;
    },
  };
  let contextFingerprint = "";
  let contextSnapshot: GenerationAudit["contextSnapshot"] | undefined;
  let promptHash = `sha256:${createHash("sha256").update(input.prompt.trim()).digest("hex")}`;

  const checkpoint = async (stage: GenerationCheckpoint["stage"], detail?: Record<string, unknown>) => {
    await deps.checkpoint({ generationId, stage, at: deps.now(), usage: meter.snapshot(), detail });
  };

  const partialAudit = (message?: string): Partial<GenerationAudit> => ({
    contractVersion: 1,
    promptContractVersion: STOREFRONT_AI_PROMPT_VERSION,
    generationId,
    shopId: input.shopId,
    rawPrompt: input.prompt,
    promptHash,
    contextFingerprint,
    ...(contextSnapshot ? { contextSnapshot } : {}),
    routingResolution: input.routingResolution ?? null,
    providerCalls,
    candidateCount: meter.usage.candidates,
    rejectedCandidates: message ? [...rejectedCandidates, { candidateId: "pipeline", reason: message }] : rejectedCandidates,
    candidateScores,
    repairCount: meter.usage.repairs,
    assetCount: meter.usage.images,
    usage: { ...meter.usage },
  });

  try {
    await deps.preflight({ shopId: input.shopId, prompt: input.prompt, trusted: input.trusted });
    meter.check();
    const context = await deps.assembleContext({ shopId: input.shopId, prompt: input.prompt, referenceImages: input.referenceImages });
    contextSnapshot = context;
    contextFingerprint = context.fingerprint;
    promptHash = context.promptHash;
    await checkpoint("context", { fingerprint: context.fingerprint });

    meter.candidates(3);
    const explored = await exploreConcepts({
      context,
      provider: meteredProvider,
      compileConcept: deps.compileConcept,
      signal: pipelineSignal,
    });
    meter.repair(explored.repairs);
    rejectedCandidates.push(...explored.rejected.map((item) => ({ candidateId: item.candidateId, reason: item.reason })));
    await checkpoint("concepts", { valid: explored.candidates.length, rejected: explored.rejected.length });
    if (!explored.candidates.length) throw new Error("All concept candidates failed schema or compiler validation");

    const ranked = await rankConcepts({
      candidates: explored.candidates,
      context,
      provider: meteredProvider,
      render: deps.renderConcept,
      signal: pipelineSignal,
    });
    for (const judgment of ranked.accepted) candidateScores.push({
      candidateId: judgment.candidate.candidate.candidateId,
      overall: judgment.overall,
      noveltyScore: judgment.noveltyScore,
      scores: judgment.scores,
    });
    for (const rejection of ranked.rejected) {
      rejectedCandidates.push({ candidateId: rejection.candidate.candidate.candidateId, reason: rejection.reason });
      if (rejection.judgment) candidateScores.push({
        candidateId: rejection.candidate.candidate.candidateId,
        overall: rejection.judgment.overall,
        noveltyScore: rejection.judgment.noveltyScore,
        scores: rejection.judgment.scores,
      });
    }
    await checkpoint("judging", { accepted: ranked.accepted.length });
    if (!ranked.accepted.length) throw new Error("All concepts failed novelty or visual quality gates");

    for (const judgment of ranked.accepted) {
      const winner = judgment.candidate;
      try {
        const expansion = await expandWinningConcept({ winner, context, provider: meteredProvider, signal: pipelineSignal });
        await checkpoint("expanding", { candidateId: winner.candidate.candidateId });
        const requests = mergeAssetRequests(winner.candidate.assetRequests, expansion.assetRequests ?? []);
        const assets: MaterializedAssetResult = await materializeOwnedAssets({
          shopId: input.shopId,
          requests,
          signal: pipelineSignal,
          produce: (request) => deps.produceAsset({ shopId: input.shopId, request, context, signal: pipelineSignal }),
          persist: deps.persistAsset,
          onImage: () => meter.image(),
        });
        await checkpoint("assets", { candidateId: winner.candidate.candidateId, assets: assets.persisted.length });
        const source = expandedBundleSource({ generationId, promptHash, winner, expansion, assets: assets.manifest });
        const proven = await proveAndRepairBundle({
          source,
          compile: deps.compileBundle,
          proof: (compiled) => deps.browserProof({ bundle: compiled.bundle, context, signal: pipelineSignal }),
          repair: ({ routeId, regionId, diagnostic, source: current }) => deps.repairRoute({
            routeId, regionId, diagnostic, source: current, context, provider: meteredProvider, signal: pipelineSignal,
          }),
          maxRepairs: Math.min(2, Math.max(0, meter.limits.maxRepairs - meter.usage.repairs)),
          onProof: (report) => meter.browser(report.browserMs),
          onRepair: () => meter.repair(),
        });
        await checkpoint("proofing", { candidateId: winner.candidate.candidateId, screenshots: proven.proof.screenshots });
        const artifactHash = `sha256:${proven.compiled.hash}`;
        const audit: GenerationAudit = {
          contractVersion: 1,
          promptContractVersion: STOREFRONT_AI_PROMPT_VERSION,
          generationId,
          shopId: input.shopId,
          rawPrompt: input.prompt,
          promptHash,
          contextFingerprint,
          contextSnapshot: context,
          routingResolution: input.routingResolution ?? null,
          providerCalls,
          candidateCount: meter.usage.candidates,
          rejectedCandidates,
          candidateScores,
          repairCount: meter.usage.repairs,
          assetCount: assets.persisted.length,
          assetProvenance: assets.persisted.map((asset) => ({
            logicalKey: asset.logicalKey,
            assetKey: asset.assetKey,
            contentHash: asset.contentHash,
            provenance: asset.provenance,
          })),
          routeValidation: proven.proof,
          usage: meter.snapshot(),
          finalArtifactHash: artifactHash,
        };
        const installed = await deps.installValidatedBundle({
          shopId: input.shopId,
          expectedDraftVersionId: input.expectedDraftVersionId,
          actorId: input.actorId,
          prompt: input.prompt,
          bundle: proven.compiled.bundle,
          artifactHash,
          validationReport: { compiler: proven.compiled.report, browser: proven.proof },
          persistedAssets: assets.persisted,
          audit,
        });
        audit.installedVersionId = installed.versionId;
        audit.finalArtifactHash = installed.artifactHash;
        await checkpoint("installed", { versionId: installed.versionId, artifactHash: installed.artifactHash });
        return {
          status: "installed",
          versionId: installed.versionId,
          bundle: proven.compiled.bundle,
          artifactHash: installed.artifactHash,
          audit,
        };
      } catch (error) {
        if (isAbort(error, pipelineSignal) || error instanceof GenerationBudgetError) throw error;
        rejectedCandidates.push({ candidateId: winner.candidate.candidateId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    throw new Error("Every valid concept failed route expansion, assets, compiler, or browser proof");
  } catch (error) {
    const budgetError = error instanceof GenerationBudgetError
      ? error
      : pipelineSignal.reason instanceof GenerationBudgetError ? pipelineSignal.reason : null;
    if (isAbort(error, pipelineSignal) && !budgetError) {
      await deps.checkpoint({ generationId, stage: "cancelled", at: deps.now(), usage: { ...meter.usage } }).catch(() => undefined);
      return { status: "cancelled", code: "generation_cancelled", audit: partialAudit() };
    }
    const message = error instanceof Error ? error.message : String(error);
    await deps.checkpoint({ generationId, stage: "failed", at: deps.now(), usage: { ...meter.usage }, detail: { message } }).catch(() => undefined);
    return {
      status: "failed",
      code: budgetError ? "generation_budget_exceeded" : "generation_failed",
      message,
      audit: partialAudit(message),
    };
  } finally {
    clearTimeout(wallTimer);
    input.signal?.removeEventListener("abort", forwardAbort);
  }
}
