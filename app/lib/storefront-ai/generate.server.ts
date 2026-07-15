import { createHash, randomUUID } from "node:crypto";
import { MAX_IMAGE_BYTES, SHOP_ASSETS_BUCKET, fetchExternalImageBytes, sniffImageMime } from "~/lib/assets/persist.server";
import { getSupabase } from "~/lib/supabase.server";
import { assertCanGenerate, consumeGenerateQuotaReservation } from "~/lib/storegen/guard.server";
import { getImageProvider } from "~/lib/storegen/imagery/provider.server";
import {
  garbageCollectUnreferencedStorefrontAsset,
  persistStorefrontAssetBytes,
} from "../storefront-bundle/assets.server";
import {
  hashStorefrontArtifact,
  installGeneratedStorefrontBundle,
} from "../storefront-bundle/release.server";
import { compileBundle } from "../storefront-compiler/compile";
import { materializeOwnedAssets } from "./assets.server";
import { persistGenerationCheckpoint } from "./checkpoint.server";
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
  maxModelTokens: 300_000,
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
    shopId: input.shopId,
    productTitle: input.context.store.name,
    productDescription: `${input.request.purpose}. ${input.context.prompt}`.slice(0, 2_000),
    sourceImageUrl: null,
    mode: "lifestyle_scene",
    purpose: "storefront_design",
  });
  const fetched = await fetchExternalImageBytes(generated.url, { maxBytes: MAX_IMAGE_BYTES, signal: input.signal });
  if (fetched.mediaType === "image/gif") return null;
  return {
    bytes: fetched.bytes,
    provenance: `${imageProvider.name}:generated`,
  };
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Generation cancelled", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Generation cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function defaultLoadReferenceImages(input: Parameters<GenerateDependencies["loadReferenceImages"]>[0]) {
  if (input.references.length > 4 || input.context.referenceImages.length !== input.references.length) {
    throw new Error("Reference image set is invalid or exceeds its bounded limit");
  }
  const storage = getSupabase().storage.from(SHOP_ASSETS_BUCKET);
  return Promise.all(input.references.map(async (reference, index) => {
    if (/^(?:https?:)?\/\//i.test(reference.assetKey) || reference.assetKey.includes("..")) {
      throw new Error("Reference image must be an owned storage key");
    }
    const downloaded = await raceAbort(storage.download(reference.assetKey), input.signal);
    if (downloaded.error || !downloaded.data) throw new Error("Reference image bytes are unavailable");
    const bytes = new Uint8Array(await raceAbort(downloaded.data.arrayBuffer(), input.signal));
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES || sniffImageMime(bytes) !== reference.mediaType) {
      throw new Error("Reference image bytes failed bounded media verification");
    }
    const opaque = input.context.referenceImages[index];
    if (!opaque || !/^reference-image-[0-9]{3}$/.test(opaque.assetKey)) throw new Error("Reference image mapping is invalid");
    return { key: opaque.assetKey, mediaType: reference.mediaType, bytes };
  }));
}

async function defaultInstallValidatedBundle(input: InstallValidatedBundleInput & { signal?: AbortSignal }): Promise<{
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
    signal: input.signal,
  });
  input.audit.finalArtifactHash = databaseArtifactHash;
  const installed = await installGeneratedStorefrontBundle({
    shopId: input.shopId,
    expectedDraftVersionId: input.expectedDraftVersionId,
    actorId: input.actorId,
    schemaVersion: input.bundle.schemaVersion,
    runtimeVersion: input.bundle.runtimeVersion,
    validationProfileVersion: input.bundle.validationProfileVersion,
    artifact,
    assetManifest,
    validationReport: { valid: true, ...input.validationReport, compilerArtifactHash: input.artifactHash },
    generationPrompt: input.prompt,
    resolution: {
      kind: "custom_compiler",
      audit: { ...input.audit, rawPrompt: undefined, contextSnapshot: undefined },
    },
    assetReferences: input.persistedAssets.map((asset) => ({
      logicalKey: asset.logicalKey,
      assetKey: asset.assetKey,
    })),
    signal: input.signal,
  });
  return { ...installed, artifactHash: databaseArtifactHash };
}

export function createDefaultGenerateDependencies(): GenerateDependencies {
  let resolvedProvider: StorefrontAiProvider | null = null;
  const provider: StorefrontAiProvider = {
    complete: (request) => (resolvedProvider ??= createAnthropicStructuredProvider()).complete(request),
  };
  return {
    enabled: () => process.env.STOREFRONT_CUSTOM_BUILD === "1",
    preflight: async ({ shopId, prompt, trusted, reservationToken }) => {
      if (reservationToken) consumeGenerateQuotaReservation({ token: reservationToken, shopId, prompt });
      else await assertCanGenerate(shopId, prompt, { trusted });
    },
    assembleContext: (input) => assembleStorefrontContext(input),
    loadReferenceImages: defaultLoadReferenceImages,
    provider,
    compileConcept: compileConceptCandidate,
    renderConcept: renderConceptWithMerchantData,
    produceAsset: defaultProduceAsset,
    persistAsset: ({ shopId, bytes, signal }) => raceAbort(persistStorefrontAssetBytes({ shopId, bytes, signal }), signal),
    cleanupAsset: ({ shopId, assetKey, signal }) => raceAbort(
      garbageCollectUnreferencedStorefrontAsset({ shopId, assetKey }),
      signal,
    ),
    compileBundle,
    browserProof: async (input) => {
      if (!browserProofAdapter) {
        const { storefrontAiBrowserProof } = await import("../storefront-validation/browser.server");
        registerStorefrontAiBrowserProof(storefrontAiBrowserProof);
      }
      const adapter = browserProofAdapter;
      if (!adapter) throw new Error("Storefront custom build browser proof is unavailable");
      return adapter(input);
    },
    repairRoute: (input) => repairRouteWithProvider(input),
    installValidatedBundle: defaultInstallValidatedBundle,
    checkpoint: persistGenerationCheckpoint,
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
  let referenceImageEvidence: Awaited<ReturnType<GenerateDependencies["loadReferenceImages"]>> = [];
  const meteredProvider: StorefrontAiProvider = {
    async complete(request) {
      meter.check();
      const response = await raceAbort(deps.provider.complete({
        ...request,
        signal: pipelineSignal,
        ...((request.operation === "concept" || request.operation === "repairConcept") && referenceImageEvidence.length
          ? { images: referenceImageEvidence }
          : {}),
      }), pipelineSignal);
      meter.model(response.usage);
      providerCalls.push({ operation: request.operation, provider: response.provider, model: response.model, usage: response.usage });
      return response;
    },
  };
  let contextFingerprint = "";
  let contextSnapshot: GenerationAudit["contextSnapshot"] | undefined;
  let promptHash = `sha256:${createHash("sha256").update(input.prompt.trim()).digest("hex")}`;

  const checkpoint = async (stage: GenerationCheckpoint["stage"], detail?: Record<string, unknown>) => {
    await raceAbort(deps.checkpoint({
      generationId,
      shopId: input.shopId,
      stage,
      at: deps.now(),
      promptHash,
      ...(contextFingerprint ? { contextFingerprint } : {}),
      usage: meter.snapshot(),
      detail,
    }), pipelineSignal);
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
    await raceAbort(deps.preflight({
      shopId: input.shopId,
      prompt: input.prompt,
      trusted: input.trusted,
      ...(input.quotaReservationToken ? { reservationToken: input.quotaReservationToken } : {}),
    }), pipelineSignal);
    meter.check();
    const context = await raceAbort(deps.assembleContext({ shopId: input.shopId, prompt: input.prompt, referenceImages: input.referenceImages }), pipelineSignal);
    contextSnapshot = context;
    contextFingerprint = context.fingerprint;
    promptHash = context.promptHash;
    referenceImageEvidence = await raceAbort(deps.loadReferenceImages({
      shopId: input.shopId,
      references: input.referenceImages ?? [],
      context,
      signal: pipelineSignal,
    }), pipelineSignal);
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
      render: async (renderInput) => {
        const rendered = await raceAbort(deps.renderConcept({ ...renderInput, signal: pipelineSignal }), pipelineSignal);
        meter.browser(rendered.browserMs);
        return rendered;
      },
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
      const candidatePersisted: MaterializedAssetResult["persisted"] = [];
      try {
        const expansion = await expandWinningConcept({ winner, context, provider: meteredProvider, signal: pipelineSignal });
        await checkpoint("expanding", { candidateId: winner.candidate.candidateId });
        const requests = mergeAssetRequests(winner.candidate.assetRequests, expansion.assetRequests ?? []);
        const assets: MaterializedAssetResult = await materializeOwnedAssets({
          shopId: input.shopId,
          requests,
          signal: pipelineSignal,
          produce: (request) => raceAbort(deps.produceAsset({ shopId: input.shopId, request, context, signal: pipelineSignal }), pipelineSignal),
          persist: (persistInput) => raceAbort(deps.persistAsset({ ...persistInput, signal: pipelineSignal }), pipelineSignal),
          onImage: () => meter.image(),
          onPersisted: (asset) => { candidatePersisted.push(asset); },
        });
        await checkpoint("assets", { candidateId: winner.candidate.candidateId, assets: assets.persisted.length });
        const source = expandedBundleSource({ generationId, promptHash, winner, expansion, assets: assets.manifest });
        const proven = await proveAndRepairBundle({
          source,
          compile: deps.compileBundle,
          proof: (compiled) => raceAbort(deps.browserProof({
            bundle: compiled.bundle,
            context,
            persistedAssets: assets.proofAssets,
            signal: pipelineSignal,
          }), pipelineSignal),
          repair: ({ routeId, regionId, diagnostic, source: current }) => raceAbort(deps.repairRoute({
            routeId, regionId, diagnostic, source: current, context, provider: meteredProvider, signal: pipelineSignal,
          }), pipelineSignal),
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
        const installed = await raceAbort(deps.installValidatedBundle({
          shopId: input.shopId,
          expectedDraftVersionId: input.expectedDraftVersionId,
          actorId: input.actorId,
          prompt: input.prompt,
          bundle: proven.compiled.bundle,
          artifactHash,
          validationReport: { compiler: proven.compiled.report, browser: proven.proof },
          persistedAssets: assets.persisted,
          audit,
          signal: pipelineSignal,
        }), pipelineSignal);
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
        const fatal = isAbort(error, pipelineSignal) || error instanceof GenerationBudgetError;
        const cleanupSignal = fatal ? AbortSignal.timeout(10_000) : pipelineSignal;
        const cleanup = await Promise.allSettled(candidatePersisted.map((asset) => deps.cleanupAsset({
          shopId: input.shopId,
          assetKey: asset.assetKey,
          signal: cleanupSignal,
        })));
        const cleanupFailures = cleanup.filter((result) => result.status === "rejected");
        if (cleanupFailures.length) throw new Error(`Failed to garbage-collect ${cleanupFailures.length} rejected storefront asset(s)`);
        if (fatal) throw error;
        rejectedCandidates.push({ candidateId: winner.candidate.candidateId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    throw new Error("Every valid concept failed route expansion, assets, compiler, or browser proof");
  } catch (error) {
    const budgetError = error instanceof GenerationBudgetError
      ? error
      : pipelineSignal.reason instanceof GenerationBudgetError ? pipelineSignal.reason : null;
    if (isAbort(error, pipelineSignal) && !budgetError) {
      await deps.checkpoint({
        generationId, shopId: input.shopId, stage: "cancelled", at: deps.now(), promptHash,
        ...(contextFingerprint ? { contextFingerprint } : {}), usage: { ...meter.usage },
      }).catch(() => undefined);
      return { status: "cancelled", code: "generation_cancelled", audit: partialAudit() };
    }
    const message = error instanceof Error ? error.message : String(error);
    await deps.checkpoint({
      generationId, shopId: input.shopId, stage: "failed", at: deps.now(), promptHash,
      ...(contextFingerprint ? { contextFingerprint } : {}), usage: { ...meter.usage }, detail: { message },
    }).catch(() => undefined);
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
