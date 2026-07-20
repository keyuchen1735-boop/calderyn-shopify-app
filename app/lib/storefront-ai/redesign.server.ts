import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { StorefrontBundleV1, StorefrontRouteId } from "../storefront-bundle/types";
import type { CompiledBundleResult } from "../storefront-compiler/compile";
import { validateCompiledBundle, type BundleValidationReport, type CompilerDiagnostic } from "../storefront-compiler/validate";
import { recipeCompilerSource, type DefinedRecipe } from "../storefront-recipes/factory";
import { storefrontAiBrowserProof } from "../storefront-validation/browser.server";
import {
  compileAuthoring,
  type StorefrontAuthoringV1,
  type StorefrontVersionArtifactV1,
} from "./authoring.server";
import type {
  BrowserDiagnostic,
  BrowserProofReport,
  MerchantStorefrontContext,
  StorefrontReferenceMediaType,
} from "./contracts";
import type { StorefrontContextAssembly } from "./context.server";
import {
  redesignGroupPrompt,
  redesignPlanPrompt,
  storefrontRedesignRepairSystemPrompt,
  storefrontRedesignSystemPrompt,
  structuralRedesignPrompt,
  redesignRepairPrompt,
} from "./redesign-prompts.server";
import { completeRedesignRequest } from "./redesign-provider.server";
import {
  REDESIGN_GROUP_SCHEMAS,
  REDESIGN_REPAIR_RESPONSE_SCHEMAS,
  STOREFRONT_DESIGN_PLAN_SCHEMA,
  STRUCTURAL_ROUTE_SCHEMAS,
  parseRedesignGroup,
  parseRedesignRepairResponse,
  parseStorefrontDesignPlan,
  parseStructuralRouteResponse,
  type RedesignProviderAudit,
} from "./redesign-schema.server";

const OPERATION_TIMEOUT_MS = 600_000;
const PROOF_TIMEOUT_MS = 180_000;
const OPERATION_TIMEOUT = Symbol("storefront redesign operation timeout");
const PROOF_TIMEOUT = Symbol("storefront redesign proof timeout");
const FULL_ROUTE_IDS = ["home", "collection", "product", "search", "cart", "checkout"] as const;

export interface RunStorefrontRedesignInput {
  shopId: string;
  prompt: string;
  mode: "structural_edit" | "full_redesign";
  scope?: { routeId: StorefrontRouteId };
  baseVersionId: string;
  baseArtifact: StorefrontVersionArtifactV1;
  recipe?: DefinedRecipe;
  context: StorefrontContextAssembly;
  referenceImages: Array<{ url: string; mediaType: StorefrontReferenceMediaType }>;
  signal?: AbortSignal;
}

export interface StorefrontRedesignAudit {
  mode: RunStorefrontRedesignInput["mode"];
  baseVersionId: string;
  generationId: string;
  promptHash: string;
  changedRouteIds: StorefrontRouteId[];
  shellChanged: boolean;
  repairs: number;
  provider: RedesignProviderAudit[];
}

export interface StorefrontRedesignResult {
  artifact: StorefrontVersionArtifactV1 & { authoring: StorefrontAuthoringV1 };
  validation: BundleValidationReport;
  browserProof: BrowserProofReport;
  audit: StorefrontRedesignAudit;
}

type ProveInput = {
  bundle: StorefrontBundleV1;
  context: MerchantStorefrontContext;
  persistedAssets: [];
  routes?: readonly StorefrontRouteId[];
  signal?: AbortSignal;
  timeoutMs?: number;
};

export interface StorefrontRedesignDependencies {
  complete: typeof completeRedesignRequest;
  compile(authoring: StorefrontAuthoringV1): CompiledBundleResult;
  validate(bundle: StorefrontBundleV1): BundleValidationReport;
  prove(input: ProveInput): Promise<BrowserProofReport>;
  generationId(): string;
}

const defaults: StorefrontRedesignDependencies = {
  complete: completeRedesignRequest,
  compile: compileAuthoring,
  validate: validateCompiledBundle,
  prove: storefrontAiBrowserProof,
  generationId: randomUUID,
};

export class StorefrontRedesignError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "StorefrontRedesignError";
  }
}

function fail(code: string, message: string): never {
  throw new StorefrontRedesignError(code, message);
}

function ownedProofContext(assembly: StorefrontContextAssembly): MerchantStorefrontContext {
  const context = structuredClone(assembly.context);
  const owned = <T>(record: Readonly<Record<string, T>>, key: string, label: string): T =>
    record[key] ?? fail("storefront_redesign_context_invalid", `Missing owned ${label} reference.`);
  const asset = (key: string | null): string | null => key === null ? null : owned(assembly.references.assets, key, "asset");
  context.store.logoAssetKey = asset(context.store.logoAssetKey);
  context.store.publicBrandAssetKeys = context.store.publicBrandAssetKeys.map((key) => asset(key)!);
  context.collections = context.collections.map((collection) => ({
    ...collection,
    id: owned(assembly.references.collections, collection.id, "collection").id,
  }));
  context.products = context.products.map((product) => ({
    ...product,
    id: owned(assembly.references.products, product.id, "product").id,
    collectionIds: product.collectionIds?.map((id) => owned(assembly.references.collections, id, "collection").id),
    images: product.images.map((image) => ({ ...image, assetKey: asset(image.assetKey)! })),
  }));
  context.referenceImages = context.referenceImages.map((image) => ({ ...image, assetKey: asset(image.assetKey)! }));
  context.reusableAssets = context.reusableAssets.map((item) => ({ ...item, assetKey: asset(item.assetKey)! }));
  return context;
}

function assetKeys(html: string): string[] {
  return [...html.matchAll(/\bdata-cd-asset\s*=\s*(?:"([^"]*)"|'([^']*)'|([a-z0-9_-]+))/giu)]
    .map((match) => match[1] ?? match[2] ?? match[3]!);
}

function assertAllowedAssets(html: string, allowed: ReadonlySet<string>): void {
  for (const key of assetKeys(html)) {
    if (!allowed.has(key)) fail("storefront_redesign_asset_invalid", "Generated storefront route references an unknown asset.");
  }
}

function boundedDiagnostic(code: string, message: string, path?: string): CompilerDiagnostic {
  return { code: code.slice(0, 120), message: message.slice(0, 1_000), path: (path ?? "source").slice(0, 240) };
}

function diagnostics(error: unknown): CompilerDiagnostic[] {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    const path = "path" in error && typeof error.path === "string" ? error.path : undefined;
    return [boundedDiagnostic(error.code, error instanceof Error ? error.message : "Compilation failed.", path)];
  }
  return [boundedDiagnostic("compile.failed", error instanceof Error ? error.message : "Compilation failed.")];
}

function proofDiagnostics(report: BrowserProofReport, routeId: StorefrontRouteId): Array<{ code: string; message: string; regionId?: string }> {
  const matching = report.diagnostics.filter((item) => item.routeId === routeId);
  const selected: BrowserDiagnostic[] = matching;
  if (selected.length === 0) return [{ code: "proof.failed", message: "Browser proof failed." }];
  return selected.slice(0, 20).map(({ code, message, regionId }) => ({
    code: code.slice(0, 120),
    message: message.slice(0, 1_000),
    ...(regionId ? { regionId: regionId.slice(0, 120) } : {}),
  }));
}

function routeFromDiagnostics(items: ReadonlyArray<{ path: string }>, allowed: ReadonlySet<StorefrontRouteId>): StorefrontRouteId | undefined {
  for (const item of items) {
    const match = /(?:^|\.)routes\.(home|collection|product|search|cart|checkout)(?:\.|$)/u.exec(item.path);
    if (match && allowed.has(match[1] as StorefrontRouteId)) return match[1] as StorefrontRouteId;
  }
}

function refreshAssets(source: StorefrontAuthoringV1["source"], allowlistedEntries: StorefrontAuthoringV1["source"]["assets"]["entries"]): void {
  const allowed = new Set(allowlistedEntries.map((entry) => entry.key));
  const referenced = new Set<string>();
  for (const html of [source.shell.html, ...FULL_ROUTE_IDS.map((id) => source.routes[id].html)]) {
    assertAllowedAssets(html, allowed);
    for (const key of assetKeys(html)) referenced.add(key);
  }
  source.assets.entries = allowlistedEntries.filter((entry) => referenced.has(entry.key)).map((entry) => structuredClone(entry));
}

function requiredSlotDiagnostics(base: StorefrontBundleV1, candidate: StorefrontBundleV1): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  for (const id of ["shell", ...FULL_ROUTE_IDS.filter((routeId) => routeId !== "checkout")] as const) {
    const baseSlots = id === "shell" ? base.shell.trustedSlots : base.routes[id].trustedSlots;
    const candidateSlots = id === "shell" ? candidate.shell.trustedSlots : candidate.routes[id].trustedSlots;
    const required = new Map<string, number>();
    for (const slot of baseSlots) {
      required.set(slot.kind, (required.get(slot.kind) ?? 0) + 1);
    }
    for (const [kind, count] of required) {
      if (candidateSlots.filter((slot) => slot.kind === kind).length < count) {
        diagnostics.push(boundedDiagnostic("slot.required_missing", `Required trusted commerce slot ${kind} is missing.`, id === "shell" ? "shell.trustedSlots" : `routes.${id}.trustedSlots`));
      }
    }
  }
  return diagnostics;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function runStorefrontRedesign(
  input: RunStorefrontRedesignInput,
  dependencies: Partial<StorefrontRedesignDependencies> = {},
): Promise<StorefrontRedesignResult> {
  const routeId = input.scope?.routeId;
  if (input.mode === "structural_edit" && !routeId) fail("storefront_redesign_scope_invalid", "A structural redesign requires a route.");
  if (input.signal?.aborted) fail("storefront_redesign_cancelled", "Storefront redesign was cancelled.");

  const deps = { ...defaults, ...dependencies };
  const operation = new AbortController();
  const cancel = () => operation.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", cancel, { once: true });
  const operationTimer = setTimeout(() => operation.abort(OPERATION_TIMEOUT), OPERATION_TIMEOUT_MS);

  try {
    const generationId = deps.generationId();
    const baseSource = input.baseArtifact.authoring?.source
      ?? (input.recipe ? recipeCompilerSource(input.recipe) : fail("storefront_redesign_source_missing", "The storefront has no editable source."));
    const source = structuredClone(baseSource);
    source.source = {
      kind: "custom",
      generationId,
      promptHash: `sha256:${createHash("sha256").update(input.prompt).digest("hex")}`,
      derivedFromVersionId: input.baseVersionId,
      ...(baseSource.source.kind === "recipe"
        ? { derivedFromTemplateId: baseSource.source.templateId, derivedFromTemplateVersion: baseSource.source.templateVersion }
        : {
            ...(baseSource.source.derivedFromTemplateId ? { derivedFromTemplateId: baseSource.source.derivedFromTemplateId } : {}),
            ...(baseSource.source.derivedFromTemplateVersion ? { derivedFromTemplateVersion: baseSource.source.derivedFromTemplateVersion } : {}),
          }),
    };
    const providerAudits: RedesignProviderAudit[] = [];
    const allowlistedEntries = structuredClone(source.assets.entries);
    const allowedAssets = new Set(allowlistedEntries.map((entry) => entry.key));
    const repairableRouteIds: StorefrontRouteId[] = input.mode === "structural_edit" ? [routeId!] : [...FULL_ROUTE_IDS];

    if (input.mode === "structural_edit") {
      const generated = await abortable(deps.complete({
        system: storefrontRedesignSystemPrompt(),
        prompt: structuralRedesignPrompt({ prompt: input.prompt, routeId: routeId!, targetRoute: source.routes[routeId!], source, context: input.context }),
        schema: STRUCTURAL_ROUTE_SCHEMAS[routeId!],
        parse: (value) => parseStructuralRouteResponse(value, routeId!),
        maxTokens: 24_000,
        referenceImages: input.referenceImages,
        signal: operation.signal,
      }), operation.signal);
      providerAudits.push(generated.audit);
      source.routes[routeId!] = structuredClone(generated.value.route) as never;
      assertAllowedAssets(generated.value.route.html, allowedAssets);
    } else {
      const planned = await abortable(deps.complete({
        system: storefrontRedesignSystemPrompt(),
        prompt: redesignPlanPrompt({ prompt: input.prompt, source, context: input.context }),
        schema: STOREFRONT_DESIGN_PLAN_SCHEMA,
        parse: parseStorefrontDesignPlan,
        maxTokens: 24_000,
        referenceImages: input.referenceImages,
        signal: operation.signal,
      }), operation.signal);
      providerAudits.push(planned.audit);
      source.concept = structuredClone(planned.value.concept);
      source.designSystem = structuredClone(planned.value.designSystem);

      for (const groupId of ["shell_home", "catalog", "commerce"] as const) {
        const generated = await abortable(deps.complete({
          system: storefrontRedesignSystemPrompt(),
          prompt: redesignGroupPrompt({ prompt: input.prompt, group: groupId, plan: planned.value, source, context: input.context }),
          schema: REDESIGN_GROUP_SCHEMAS[groupId],
          parse: (value) => parseRedesignGroup(value, groupId),
          maxTokens: 24_000,
          referenceImages: input.referenceImages,
          signal: operation.signal,
        }), operation.signal);
        providerAudits.push(generated.audit);
        if (generated.value.group === "shell_home") {
          source.shell = structuredClone(generated.value.shell);
          source.routes.home = structuredClone(generated.value.home);
        } else if (generated.value.group === "catalog") {
          source.routes.collection = structuredClone(generated.value.collection);
          source.routes.product = structuredClone(generated.value.product);
          source.routes.search = structuredClone(generated.value.search);
        } else {
          source.routes.cart = structuredClone(generated.value.cart);
          source.routes.checkout = structuredClone(generated.value.checkout);
        }
      }

    }
    refreshAssets(source, allowlistedEntries);

    const authoring: StorefrontAuthoringV1 = {
      version: 1,
      source,
      overrides: structuredClone(input.baseArtifact.authoring?.overrides ?? {
        ...(input.baseArtifact.bundle.featuredProductIds ? { featuredProductIds: input.baseArtifact.bundle.featuredProductIds } : {}),
        ...(input.baseArtifact.bundle.visualLayer ? { visualLayer: input.baseArtifact.bundle.visualLayer } : {}),
      }),
    };
    let repairs = 0;
    let validation: BundleValidationReport;
    let compiled: CompiledBundleResult;
    let browserProof: BrowserProofReport | undefined;
    const repairedRouteIds = new Set<StorefrontRouteId>();

    while (true) {
      browserProof = undefined;
      let repairDiagnostics: Array<{ code: string; message: string; regionId?: string }> | undefined;
      let failingRouteId: StorefrontRouteId | undefined;
      try {
        compiled = deps.compile(authoring);
        validation = compiled.report.ok ? deps.validate(compiled.bundle) : compiled.report;
        if (validation.ok) {
          const slotDiagnostics = requiredSlotDiagnostics(input.baseArtifact.bundle, compiled.bundle);
          if (slotDiagnostics.length > 0) validation = { profileVersion: 1, ok: false, diagnostics: slotDiagnostics };
        }
        if (!validation.ok) {
          const failedValidation = validation;
          const bounded = failedValidation.diagnostics.slice(0, 20).map(({ code, message, path }) => boundedDiagnostic(code, message, path));
          repairDiagnostics = bounded;
          failingRouteId = routeFromDiagnostics(bounded, new Set(repairableRouteIds));
        }
      } catch (error) {
        let compileDiagnostics = diagnostics(error);
        repairDiagnostics = compileDiagnostics;
        if (input.mode === "structural_edit") {
          failingRouteId = routeId;
        } else {
          const baselineSource = structuredClone(source);
          baselineSource.routes = structuredClone(baseSource.routes);
          baselineSource.assets.entries = structuredClone(allowlistedEntries);
          const baselineAuthoring = { ...authoring, source: baselineSource };
          try {
            deps.compile(baselineAuthoring);
            for (const id of repairableRouteIds) {
              const isolatedSource = structuredClone(baselineSource);
              isolatedSource.routes[id] = structuredClone(source.routes[id]) as never;
              try {
                deps.compile({ ...authoring, source: isolatedSource });
              } catch (routeError) {
                failingRouteId = id;
                compileDiagnostics = diagnostics(routeError);
                repairDiagnostics = compileDiagnostics;
                break;
              }
            }
          } catch (preflightError) {
            compileDiagnostics = diagnostics(preflightError);
            repairDiagnostics = compileDiagnostics;
          }
        }
      }

      if (!repairDiagnostics) {
        if (operation.signal.aborted) throw operation.signal.reason;
        const proofTimeout = new AbortController();
        const proofTimer = setTimeout(() => proofTimeout.abort(PROOF_TIMEOUT), PROOF_TIMEOUT_MS);
        const proofSignal = AbortSignal.any([operation.signal, proofTimeout.signal]);
        try {
          browserProof = await abortable(deps.prove({
            bundle: compiled!.bundle,
            context: ownedProofContext(input.context),
            persistedAssets: [],
            routes: repairableRouteIds,
            signal: proofSignal,
            timeoutMs: PROOF_TIMEOUT_MS,
          }), proofSignal);
        } catch (error) {
          if (proofTimeout.signal.reason === PROOF_TIMEOUT && operation.signal.reason !== OPERATION_TIMEOUT) fail("storefront_redesign_proof_timeout", "Storefront browser proof timed out.");
          throw error;
        } finally {
          clearTimeout(proofTimer);
        }
        if (browserProof.ok) break;
        const failedProof = browserProof;
        failingRouteId = repairableRouteIds.find((id) => failedProof.diagnostics.some((item) => item.routeId === id) && !repairedRouteIds.has(id));
        if (failingRouteId) repairDiagnostics = proofDiagnostics(failedProof, failingRouteId);
      }

      const repairLimit = input.mode === "structural_edit" ? 1 : 2;
      if (!repairDiagnostics) fail("storefront_redesign_compile_failed", "Storefront redesign did not pass validation.");
      if (!failingRouteId || repairedRouteIds.has(failingRouteId) || repairs === repairLimit) {
        fail(browserProof?.ok === false ? "storefront_redesign_proof_failed" : "storefront_redesign_compile_failed", repairDiagnostics[0]?.message ?? "Storefront redesign did not pass validation.");
      }
      const repaired = await abortable(deps.complete({
        system: storefrontRedesignRepairSystemPrompt(),
        prompt: redesignRepairPrompt({ prompt: input.prompt, designSystem: source.designSystem, repair: { routeId: failingRouteId, route: source.routes[failingRouteId], diagnostics: repairDiagnostics }, context: input.context }),
        schema: REDESIGN_REPAIR_RESPONSE_SCHEMAS[failingRouteId],
        parse: (value) => parseRedesignRepairResponse(value, failingRouteId),
        maxTokens: 24_000,
        referenceImages: input.referenceImages,
        signal: operation.signal,
      }), operation.signal);
      providerAudits.push(repaired.audit);
      source.routes[failingRouteId] = structuredClone(repaired.value.route) as never;
      assertAllowedAssets(repaired.value.route.html, allowedAssets);
      refreshAssets(source, allowlistedEntries);
      repairedRouteIds.add(failingRouteId);
      repairs += 1;
    }

    const changedRouteIds = FULL_ROUTE_IDS.filter((id) => !isDeepStrictEqual(source.routes[id], baseSource.routes[id]));
    const shellChanged = !isDeepStrictEqual(source.shell, baseSource.shell);
    return {
      artifact: { sourceKind: "custom", bundle: compiled!.bundle, authoring },
      validation: validation!,
      browserProof: browserProof!,
      audit: {
        mode: input.mode,
        baseVersionId: input.baseVersionId,
        generationId,
        promptHash: source.source.promptHash,
        changedRouteIds,
        shellChanged,
        repairs,
        provider: providerAudits,
      },
    };
  } catch (error) {
    if (error instanceof StorefrontRedesignError) throw error;
    if (operation.signal.reason === OPERATION_TIMEOUT) fail("storefront_redesign_timeout", "Storefront redesign timed out.");
    if (input.signal?.aborted) fail("storefront_redesign_cancelled", "Storefront redesign was cancelled.");
    return fail("storefront_redesign_provider_failed", error instanceof Error ? error.message : "Storefront redesign failed.");
  } finally {
    clearTimeout(operationTimer);
    input.signal?.removeEventListener("abort", cancel);
  }
}
