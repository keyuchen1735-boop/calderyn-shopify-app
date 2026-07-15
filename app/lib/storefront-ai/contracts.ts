import type { AssetManifest, AssetManifestEntry, StoreDesignResolution, StorefrontBundleV1, StorefrontRouteId, StoreTemplateId } from "../storefront-bundle/types";
import type { CompiledBundleResult, RouteSource, StorefrontBundleSourceV1 } from "../storefront-compiler/compile";

export const STOREFRONT_AI_CONTRACT_VERSION = 1 as const;
export const CONCEPT_STRATEGIES = ["asymmetric-commerce", "narrative-utility", "spatial-catalog"] as const;
export const STOREFRONT_REFERENCE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ConceptStrategy = (typeof CONCEPT_STRATEGIES)[number];
export type StorefrontReferenceMediaType = (typeof STOREFRONT_REFERENCE_MEDIA_TYPES)[number];

export interface NoveltySignature {
  layoutTopology: string;
  typeTreatment: string;
  sectionSequence: string;
  navigationModel: string;
  interactionStyle: string;
}

export interface MerchantReferenceImage {
  assetKey: string;
  mediaType: StorefrontReferenceMediaType;
}

export interface MerchantStorefrontContext {
  version: 1;
  prompt: string;
  promptHash: string;
  referenceImages: MerchantReferenceImage[];
  store: { name: string; logoAssetKey: string | null; publicBrandAssetKeys: string[] };
  collections: Array<{ id: string; handle: string; title: string; productCount: number }>;
  products: Array<{
    id: string;
    handle: string;
    title: string;
    productType: string | null;
    tags: string[];
    optionNames: string[];
    priceMin: number;
    priceMax: number;
    currency: string;
    availability: "available" | "sold_out" | "mixed";
    collectionIds?: string[];
    images: Array<{ assetKey: string; aspectRatio: number | null }>;
  }>;
  reusableAssets: Array<{ assetKey: string; mediaType: string; width: number | null; height: number | null }>;
  recipeNoveltySignatures: Array<{ templateId: StoreTemplateId; signature: NoveltySignature }>;
  fingerprint: string;
}

export interface ContextAssemblyInput {
  shopId: string;
  prompt: string;
  referenceImages?: MerchantReferenceImage[];
}

export interface AssetRequest {
  key: string;
  purpose: string;
  required: boolean;
  aspectRatio?: number;
}

export interface ConceptCandidateSource {
  candidateId: string;
  concept: {
    name: string;
    rationale: string;
    noveltySignature: NoveltySignature;
  };
  designSystem: StorefrontBundleSourceV1["designSystem"];
  shell: StorefrontBundleSourceV1["shell"];
  home: StorefrontBundleSourceV1["routes"]["home"];
  assetRequests: AssetRequest[];
}

export interface CompiledConcept {
  candidate: ConceptCandidateSource;
  compiledFingerprint: string;
  structuralSignature: NoveltySignature;
}

export interface ExploredConcept extends CompiledConcept {
  strategy: ConceptStrategy;
}

export interface RouteExpansion {
  collection: StorefrontBundleSourceV1["routes"]["collection"];
  product: StorefrontBundleSourceV1["routes"]["product"];
  search: StorefrontBundleSourceV1["routes"]["search"];
  cart: StorefrontBundleSourceV1["routes"]["cart"];
  checkout: StorefrontBundleSourceV1["routes"]["checkout"];
  assetRequests?: AssetRequest[];
}

export type ProviderOperation = "concept" | "repairConcept" | "judge" | "expand" | "repairRoute" | "patch";

export interface StructuredModelRequest {
  operation: ProviderOperation;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  images?: VisualEvidenceImage[];
  signal?: AbortSignal;
}

export interface VisualEvidenceImage {
  key: string;
  mediaType: StorefrontReferenceMediaType;
  bytes: Uint8Array;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface StructuredModelResponse {
  value: unknown;
  usage: ModelUsage;
  provider: string;
  model: string;
}

export interface StorefrontAiProvider {
  complete(request: StructuredModelRequest): Promise<StructuredModelResponse>;
}

export interface JudgeScores {
  promptFit: number;
  ecommerceClarity: number;
  hierarchy: number;
  responsiveQuality: number;
  interactionClarity: number;
  typographyImagery: number;
  accessibility: number;
  originality: number;
}

export interface CandidateJudgment {
  candidate: ExploredConcept;
  scores: JudgeScores;
  overall: number;
  noveltyScore: number;
  rationale: string;
}

export interface BrowserDiagnostic {
  routeId: StorefrontRouteId;
  regionId?: string;
  code: string;
  message: string;
}

export interface BrowserProofReport {
  ok: boolean;
  diagnostics: BrowserDiagnostic[];
  screenshots: string[];
  browserMs: number;
}

export interface RouteRepair {
  routeId: StorefrontRouteId;
  route: RouteSource | StorefrontBundleSourceV1["routes"]["checkout"];
}

export interface ProducedAsset {
  bytes: Uint8Array;
  provenance: string;
}

export interface PersistedOwnedAsset extends Omit<AssetManifestEntry, "key"> {
  assetKey: string;
}

export interface MaterializedAssetResult {
  manifest: AssetManifest;
  persisted: Array<PersistedOwnedAsset & { logicalKey: string; provenance: string }>;
  proofAssets: Array<AssetManifestEntry & { logicalKey: string; bytes: Uint8Array }>;
}

export interface GenerationBudget {
  maxCandidates: number;
  maxModelTokens: number;
  maxImages: number;
  maxBrowserMs: number;
  maxRepairs: number;
  maxWallMs: number;
}

export type GenerationBudgetOverride = Partial<GenerationBudget>;

export interface GenerationUsage {
  candidates: number;
  modelTokens: number;
  images: number;
  browserMs: number;
  repairs: number;
  wallMs: number;
}

export type GenerationStage = "context" | "concepts" | "judging" | "expanding" | "assets" | "proofing" | "installed" | "failed" | "cancelled";

export interface GenerationCheckpoint {
  generationId: string;
  shopId: string;
  stage: GenerationStage;
  at: number;
  promptHash: string;
  contextFingerprint?: string;
  usage: GenerationUsage;
  detail?: Record<string, unknown>;
}

export interface GenerationAudit {
  contractVersion: 1;
  promptContractVersion: 1;
  generationId: string;
  shopId: string;
  rawPrompt: string;
  promptHash: string;
  contextFingerprint: string;
  contextSnapshot: MerchantStorefrontContext;
  routingResolution: StoreDesignResolution | null;
  providerCalls: Array<{ operation: ProviderOperation; provider: string; model: string; usage: ModelUsage }>;
  candidateCount: number;
  rejectedCandidates: Array<{ candidateId: string; reason: string }>;
  candidateScores: Array<{ candidateId: string; overall: number; noveltyScore: number; scores: JudgeScores }>;
  repairCount: number;
  assetCount: number;
  assetProvenance: Array<{ logicalKey: string; assetKey: string; contentHash: string; provenance: string }>;
  routeValidation: BrowserProofReport;
  usage: GenerationUsage;
  finalArtifactHash: string;
  installedVersionId?: string;
}

export interface InstallValidatedBundleInput {
  shopId: string;
  expectedDraftVersionId: string | null;
  actorId: string | null;
  prompt: string;
  bundle: StorefrontBundleV1;
  artifactHash: string;
  validationReport: Record<string, unknown>;
  persistedAssets: MaterializedAssetResult["persisted"];
  audit: GenerationAudit;
}

export interface GenerateDependencies {
  enabled(): boolean;
  preflight(input: { shopId: string; prompt: string; trusted: boolean; reservationToken?: string }): Promise<void>;
  assembleContext(input: ContextAssemblyInput): Promise<MerchantStorefrontContext>;
  loadReferenceImages(input: {
    shopId: string;
    references: MerchantReferenceImage[];
    context: MerchantStorefrontContext;
    signal?: AbortSignal;
  }): Promise<VisualEvidenceImage[]>;
  provider: StorefrontAiProvider;
  compileConcept(candidate: ConceptCandidateSource): CompiledConcept;
  produceAsset(input: { shopId: string; request: AssetRequest; context: MerchantStorefrontContext; signal?: AbortSignal }): Promise<ProducedAsset | null>;
  persistAsset(input: { shopId: string; bytes: Uint8Array; signal?: AbortSignal }): Promise<PersistedOwnedAsset>;
  cleanupAsset(input: { shopId: string; assetKey: string; signal?: AbortSignal }): Promise<void>;
  compileBundle(source: StorefrontBundleSourceV1): CompiledBundleResult;
  browserProof(input: {
    bundle: StorefrontBundleV1;
    context: MerchantStorefrontContext;
    persistedAssets: MaterializedAssetResult["proofAssets"];
    signal?: AbortSignal;
  }): Promise<BrowserProofReport>;
  repairRoute(input: {
    routeId: StorefrontRouteId;
    regionId?: string;
    diagnostic: BrowserDiagnostic;
    source: StorefrontBundleSourceV1;
    context: MerchantStorefrontContext;
    provider: StorefrontAiProvider;
    signal?: AbortSignal;
  }): Promise<RouteRepair>;
  installValidatedBundle(input: InstallValidatedBundleInput & { signal?: AbortSignal }): Promise<{
    versionId: string;
    installedDraftVersionId: string;
    artifactHash: string;
  }>;
  checkpoint(event: GenerationCheckpoint): Promise<void>;
  now(): number;
  randomId(): string;
}

export interface ConceptRenderEvidence {
  desktop: VisualEvidenceImage;
  desktopCatalog: VisualEvidenceImage;
  mobile: VisualEvidenceImage;
  mobileCatalog: VisualEvidenceImage;
  browserMs: number;
}

export interface GenerateOriginalStorefrontInput {
  shopId: string;
  prompt: string;
  referenceImages?: MerchantReferenceImage[];
  expectedDraftVersionId: string | null;
  actorId: string | null;
  trusted: boolean;
  quotaReservationToken?: string;
  routingResolution?: StoreDesignResolution;
  signal?: AbortSignal;
  budget?: GenerationBudgetOverride;
}

export type GenerateOriginalStorefrontResult =
  | { status: "disabled"; code: "storefront_custom_build_disabled" }
  | { status: "cancelled"; code: "generation_cancelled"; audit?: Partial<GenerationAudit> }
  | { status: "failed"; code: "generation_failed" | "generation_budget_exceeded"; message: string; audit?: Partial<GenerationAudit> }
  | { status: "installed"; versionId: string; bundle: StorefrontBundleV1; artifactHash: string; audit: GenerationAudit };
