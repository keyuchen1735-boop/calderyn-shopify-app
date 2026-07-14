import type { StorefrontRouteId } from "../storefront-bundle/types";
import type { CompiledBundleResult, StorefrontBundleSourceV1 } from "../storefront-compiler/compile";
import type { BrowserProofReport, MerchantStorefrontContext, RouteRepair, StorefrontAiProvider, StructuredModelResponse } from "./contracts";
import { COMPILER_SYSTEM_PROMPT, ROUTE_REPAIR_SCHEMA, routeRepairPrompt } from "./prompts";

export class BrowserProofError extends Error {
  constructor(message: string, public readonly report: BrowserProofReport) {
    super(message);
    this.name = "BrowserProofError";
  }
}

export async function repairRouteWithProvider(input: {
  routeId: StorefrontRouteId;
  regionId?: string;
  diagnostic: BrowserProofReport["diagnostics"][number];
  source: StorefrontBundleSourceV1;
  context: MerchantStorefrontContext;
  provider: StorefrontAiProvider;
  signal?: AbortSignal;
  onModelCall?: (operation: "repairRoute", response: StructuredModelResponse) => void;
}): Promise<RouteRepair> {
  const response = await input.provider.complete({
    operation: "repairRoute",
    system: COMPILER_SYSTEM_PROMPT,
    prompt: routeRepairPrompt(input.routeId, input.regionId, input.diagnostic, input.source.routes[input.routeId]),
    schema: ROUTE_REPAIR_SCHEMA,
    signal: input.signal,
  });
  input.onModelCall?.("repairRoute", response);
  if (!response.value || typeof response.value !== "object") throw new Error("Route repair output must be an object");
  const value = response.value as Record<string, unknown>;
  if (value.routeId !== input.routeId || !value.route || typeof value.route !== "object" || Array.isArray(value.route)) {
    throw new Error("Route repair must return exactly the requested route");
  }
  return { routeId: input.routeId, route: value.route as unknown as RouteRepair["route"] };
}

export interface ProveAndRepairBundleInput {
  source: StorefrontBundleSourceV1;
  compile(source: StorefrontBundleSourceV1): CompiledBundleResult;
  proof(input: CompiledBundleResult): Promise<BrowserProofReport>;
  repair(input: {
    routeId: StorefrontRouteId;
    regionId?: string;
    diagnostic: BrowserProofReport["diagnostics"][number];
    source: StorefrontBundleSourceV1;
  }): Promise<RouteRepair>;
  maxRepairs: number;
  onProof?: (report: BrowserProofReport) => void;
  onRepair?: () => void;
}

function applyRouteRepair(source: StorefrontBundleSourceV1, repair: RouteRepair): StorefrontBundleSourceV1 {
  const next = structuredClone(source);
  if (repair.routeId === "checkout") next.routes.checkout = repair.route as StorefrontBundleSourceV1["routes"]["checkout"];
  else next.routes[repair.routeId] = repair.route as StorefrontBundleSourceV1["routes"][Exclude<StorefrontRouteId, "checkout">];
  return next;
}

export async function proveAndRepairBundle(input: ProveAndRepairBundleInput): Promise<{
  source: StorefrontBundleSourceV1;
  compiled: CompiledBundleResult;
  proof: BrowserProofReport;
  repairs: number;
}> {
  let source = structuredClone(input.source);
  let repairs = 0;
  for (;;) {
    const compiled = input.compile(source);
    if (!compiled.report.ok) throw new Error("Bundle compiler validation failed before browser proof");
    const proof = await input.proof(compiled);
    input.onProof?.(proof);
    if (proof.ok) return { source, compiled, proof, repairs };
    if (repairs >= input.maxRepairs || proof.diagnostics.length === 0) {
      throw new BrowserProofError("Browser proof failed after targeted repair budget", proof);
    }
    const diagnostic = proof.diagnostics[0];
    const repair = await input.repair({
      routeId: diagnostic.routeId,
      regionId: diagnostic.regionId,
      diagnostic,
      source: structuredClone(source),
    });
    if (repair.routeId !== diagnostic.routeId) throw new Error("Targeted repair changed a route outside the failing scope");
    source = applyRouteRepair(source, repair);
    repairs += 1;
    input.onRepair?.();
  }
}
