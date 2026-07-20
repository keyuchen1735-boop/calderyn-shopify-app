import type { CompiledStorefrontRouteId, DataRequirement, StorefrontBundleV1 } from "~/lib/storefront-bundle/types";
import { resolveVerifiedStorefrontAssetUrls } from "~/lib/storefront-bundle/assets.server";
import { getStoreTemplate } from "~/lib/storefront-bundle/registry";
import { getSupabase } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";
import { STOREFRONT_RECIPE_BY_ID } from "~/lib/storefront-recipes";
import { storefrontRecipeMediaPath } from "~/lib/storefront-recipes/library/media";
import { isolateCompiledShellCss } from "~/lib/storefront-compiler/css";
import { isStorefrontBundleReadEnabled } from "./csp.server";
import { resolveStorefrontVisualPlacement, type StorefrontVisualPlacement } from "./visual-layer.server";
import {
  resolvePublicData,
  routeIdForPublicContext,
  type PublicDataDependencies,
  type PublicPresentationData,
  type PublicRouteContext,
} from "./public-data.server";

export interface StorefrontVersionRecord {
  id: string;
  shopId: string;
  sourceKind: "legacy" | "recipe" | "custom";
  status: "candidate" | "validated" | "failed";
  schemaVersion: number;
  runtimeVersion: number;
  validationProfileVersion: number;
  artifactHash: string;
  artifact:
    | { sourceKind: "legacy"; snapshot: Record<string, unknown> }
    | { sourceKind: "recipe" | "custom"; bundle: StorefrontBundleV1 };
  createdAt: string;
}

export type StorefrontReleaseHistoryOperation =
  | "capture_legacy"
  | "install_draft"
  | "edit_draft"
  | "publish"
  | "rollback";

export interface StorefrontReleaseHistoryEntry {
  operation: StorefrontReleaseHistoryOperation;
  fromVersion: StorefrontVersionRecord | null;
  toVersion: StorefrontVersionRecord;
  occurredAt: string;
}

export interface StorefrontReleaseReader {
  readPublished(shopId: string): Promise<StorefrontVersionRecord | null>;
  readReleaseHistory(shopId: string): Promise<StorefrontReleaseHistoryEntry[]>;
}

const RECIPE_MEDIA_EXTENSIONS = { "image/webp": "webp", "video/webm": "webm", "video/mp4": "mp4" } as const;

function recipeDerivedStaticAssets(bundle: StorefrontBundleV1): {
  urls: Readonly<Record<string, string>>;
  ownedManifest: StorefrontBundleV1["assets"];
} {
  if (bundle.source.kind === "recipe" && bundle.source.templateId === "larder") {
    const mediaEntries = bundle.assets.entries.filter((entry) => entry.mediaType in RECIPE_MEDIA_EXTENSIONS);
    return {
      urls: Object.fromEntries(mediaEntries.map((entry) => [
        entry.key,
        `/storefront-recipes/larder/${entry.contentHash}.${RECIPE_MEDIA_EXTENSIONS[entry.mediaType as keyof typeof RECIPE_MEDIA_EXTENSIONS]}`,
      ])),
      ownedManifest: { entries: [] },
    };
  }
  if (bundle.source.kind === "recipe" && new Set(["volt", "atelier", "gilt", "larder", "ember", "roast", "fizz", "forge", "haven", "glow"]).has(bundle.source.templateId)) {
    const templateId = bundle.source.templateId;
    const mediaEntries = bundle.assets.entries.filter((entry) => entry.mediaType === "image/webp" || entry.mediaType === "video/webm" || entry.mediaType === "video/mp4");
    return {
      urls: Object.fromEntries(mediaEntries.map((entry) => [
        entry.key,
        `/storage/v1/object/public/${storefrontRecipeMediaPath(templateId, entry.contentHash, entry.mediaType as "image/webp" | "video/webm" | "video/mp4")}`,
      ])),
      ownedManifest: { entries: [] },
    };
  }
  if (bundle.source.kind !== "custom" || !bundle.source.derivedFromTemplateId || !bundle.source.derivedFromTemplateVersion) {
    return { urls: {}, ownedManifest: bundle.assets };
  }
  const templateId = bundle.source.derivedFromTemplateId;
  const templateVersion = bundle.source.derivedFromTemplateVersion;
  if (!Object.hasOwn(STOREFRONT_RECIPE_BY_ID, templateId)) {
    return { urls: {}, ownedManifest: bundle.assets };
  }
  const version = getStoreTemplate(templateId).versions.find(
    (candidate) => candidate.templateVersion === templateVersion,
  );
  if (!version) {
    return { urls: {}, ownedManifest: bundle.assets };
  }
  const registered = new Map(version.assets.entries.map((entry) => [entry.key, entry]));
  const staticEntries = new Set<string>();
  for (const entry of bundle.assets.entries) {
    const expected = registered.get(entry.key);
    if (entry.mediaType in RECIPE_MEDIA_EXTENSIONS && expected &&
      expected.contentHash === entry.contentHash && expected.mediaType === entry.mediaType && expected.byteSize === entry.byteSize) {
      staticEntries.add(entry.key);
    }
  }
  const urls = Object.fromEntries([...staticEntries].map((key) => [
    key,
    `/storefront-recipes/${templateId}/${registered.get(key)!.contentHash}.${RECIPE_MEDIA_EXTENSIONS[registered.get(key)!.mediaType as keyof typeof RECIPE_MEDIA_EXTENSIONS]}`,
  ]));
  return {
    urls,
    ownedManifest: { entries: bundle.assets.entries.filter((entry) => !staticEntries.has(entry.key)) },
  };
}

type DatabaseVersionRow = {
  id: unknown;
  shop_id: unknown;
  source_kind: unknown;
  status: unknown;
  schema_version: unknown;
  runtime_version: unknown;
  validation_profile_version: unknown;
  artifact_hash: unknown;
  bundle_json: unknown;
  created_at: unknown;
};

type DatabaseHistoryRow = {
  from_version_id: unknown;
  to_version_id: unknown;
  operation: unknown;
  created_at: unknown;
};

const VERSION_COLUMNS = [
  "id", "shop_id", "source_kind", "status", "schema_version", "runtime_version",
  "validation_profile_version", "artifact_hash", "bundle_json", "created_at",
].join(", ");
const HISTORY_PAGE_SIZE = 100;
const VERSION_CHUNK_SIZE = 200;

function mapVersion(row: DatabaseVersionRow): StorefrontVersionRecord {
  return {
    id: String(row.id),
    shopId: String(row.shop_id),
    sourceKind: row.source_kind as StorefrontVersionRecord["sourceKind"],
    status: row.status as StorefrontVersionRecord["status"],
    schemaVersion: Number(row.schema_version),
    runtimeVersion: Number(row.runtime_version),
    validationProfileVersion: Number(row.validation_profile_version),
    artifactHash: String(row.artifact_hash),
    artifact: row.bundle_json as StorefrontVersionRecord["artifact"],
    createdAt: String(row.created_at),
  };
}

async function readPublishedHistoryRows(shopId: string): Promise<DatabaseHistoryRow[]> {
  const rows: DatabaseHistoryRow[] = [];
  for (let offset = 0; ; offset += HISTORY_PAGE_SIZE) {
    const result = await getSupabase()
      .from("storefront_release_history")
      .select("from_version_id, to_version_id, operation, created_at")
      .eq("shop_id", shopId)
      .in("operation", ["publish", "rollback"])
      .order("created_at", { ascending: false })
      .range(offset, offset + HISTORY_PAGE_SIZE - 1);
    if (result.error) throw result.error;
    const page = (result.data ?? []) as unknown as DatabaseHistoryRow[];
    rows.push(...page);
    if (page.length < HISTORY_PAGE_SIZE) return rows;
  }
}

async function readHistoryVersions(shopId: string, ids: readonly string[]): Promise<Map<string, StorefrontVersionRecord>> {
  const versions = new Map<string, StorefrontVersionRecord>();
  for (let offset = 0; offset < ids.length; offset += VERSION_CHUNK_SIZE) {
    const result = await getSupabase()
      .from("storefront_bundle_version")
      .select(VERSION_COLUMNS)
      .eq("shop_id", shopId)
      .in("id", ids.slice(offset, offset + VERSION_CHUNK_SIZE));
    if (result.error) throw result.error;
    for (const row of result.data ?? []) {
      const version = mapVersion(row as unknown as DatabaseVersionRow);
      versions.set(version.id, version);
    }
  }
  return versions;
}

export const storefrontReleaseReader: StorefrontReleaseReader = {
  async readPublished(shopId) {
    const client = getSupabase();
    const release = await client
      .from("storefront_release")
      .select("published_version_id")
      .eq("shop_id", shopId)
      .maybeSingle();
    if (release.error) throw release.error;
    const versionId = release.data?.published_version_id;
    if (!versionId) return null;
    const version = await client
      .from("storefront_bundle_version")
      .select(VERSION_COLUMNS)
      .eq("shop_id", shopId)
      .eq("id", versionId)
      .maybeSingle();
    if (version.error) throw version.error;
    return version.data ? mapVersion(version.data as unknown as DatabaseVersionRow) : null;
  },

  async readReleaseHistory(shopId) {
    const rows = await readPublishedHistoryRows(shopId);
    const ids = [...new Set(rows.flatMap((row) => [row.to_version_id, row.from_version_id]
      .filter((value): value is string => typeof value === "string")))];
    const versions = await readHistoryVersions(shopId, ids);
    return rows.map((row): StorefrontReleaseHistoryEntry => {
      const toVersion = versions.get(String(row.to_version_id));
      if (!toVersion) {
        throw new StorefrontReleaseResolutionError(
          "invalid_storefront_release_history",
          "Published storefront history references a missing release.",
          500,
        );
      }
      const fromVersionId = typeof row.from_version_id === "string" ? row.from_version_id : null;
      return {
        operation: row.operation as "publish" | "rollback",
        fromVersion: fromVersionId ? versions.get(fromVersionId) ?? null : null,
        toVersion,
        occurredAt: String(row.created_at),
      };
    });
  },
};

function supported(version: StorefrontVersionRecord): boolean {
  return version.status === "validated" && version.schemaVersion === 1 &&
    version.runtimeVersion === 1 && version.validationProfileVersion === 1 &&
    (version.sourceKind === "recipe" || version.sourceKind === "custom") &&
    version.artifact.sourceKind === version.sourceKind;
}

function retainedPublishedVersions(history: readonly StorefrontReleaseHistoryEntry[]): StorefrontVersionRecord[] {
  const versions: StorefrontVersionRecord[] = [];
  const seen = new Set<string>();
  for (const entry of history) {
    if (entry.operation !== "publish" && entry.operation !== "rollback") continue;
    for (const version of [entry.toVersion, entry.fromVersion]) {
      if (version && !seen.has(version.id)) {
        seen.add(version.id);
        versions.push(version);
      }
    }
  }
  return versions;
}

function firstCompatible(
  history: readonly StorefrontReleaseHistoryEntry[],
  bundleReadEnabled: boolean,
): StorefrontVersionRecord | null {
  return retainedPublishedVersions(history).find((version) =>
    bundleReadEnabled && supported(version)) ?? null;
}

export class StorefrontReleaseResolutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "StorefrontReleaseResolutionError";
  }
}

export type ResolvedStorefrontRelease = {
  kind: "runtime1";
  version: StorefrontVersionRecord;
  fallbackFromVersionId?: string;
};

export async function resolveStorefrontRelease(input: {
  shopId: string;
  bundleReadEnabled?: boolean;
  reader?: StorefrontReleaseReader;
  request?: Request;
}): Promise<ResolvedStorefrontRelease> {
  const reader = input.reader ?? storefrontReleaseReader;
  const bundleReadEnabled = input.bundleReadEnabled ?? isStorefrontBundleReadEnabled();
  if (input.request) {
    let byReader = requestReleaseMemo.get(input.request);
    if (!byReader) {
      byReader = new Map();
      requestReleaseMemo.set(input.request, byReader);
    }
    let byShopAndFlag = byReader.get(reader);
    if (!byShopAndFlag) {
      byShopAndFlag = new Map();
      byReader.set(reader, byShopAndFlag);
    }
    const key = `${input.shopId}:${bundleReadEnabled ? "1" : "0"}`;
    let pending = byShopAndFlag.get(key);
    if (!pending) {
      pending = resolveStorefrontRelease({ ...input, request: undefined, reader, bundleReadEnabled });
      byShopAndFlag.set(key, pending);
    }
    return pending;
  }
  const published = await reader.readPublished(input.shopId);
  if (published && bundleReadEnabled && supported(published)) {
    return { kind: "runtime1", version: published };
  }
  const fallback = firstCompatible(await reader.readReleaseHistory(input.shopId), bundleReadEnabled);
  if (!fallback) {
    throw new StorefrontReleaseResolutionError(
      "no_compatible_storefront_release",
      "No compatible immutable storefront release is available.",
      503,
    );
  }
  return {
    kind: "runtime1",
    version: fallback,
    ...(published ? { fallbackFromVersionId: published.id } : {}),
  };
}

const requestReleaseMemo = new WeakMap<
  Request,
  Map<StorefrontReleaseReader, Map<string, Promise<ResolvedStorefrontRelease>>>
>();

export interface Runtime1RouteData {
  runtime: 1;
  bundleId: string;
  artifactHash: string;
  routeId: CompiledStorefrontRouteId;
  bundle: StorefrontBundleV1;
  data: PublicPresentationData;
  visualLayerPlacement: StorefrontVisualPlacement | null;
}

export type StorefrontAssetUrlLoader = (input: {
  shopId: string;
  bundleId: string;
  manifest: StorefrontBundleV1["assets"];
}) => Promise<Readonly<Record<string, string>>>;

function resolvedRouteId(bundle: StorefrontBundleV1, route: PublicRouteContext): CompiledStorefrontRouteId {
  const requested = routeIdForPublicContext(route);
  if (requested === "collections" || requested === "story" || requested === "notFound") {
    return bundle.routes[requested] ? requested : "home";
  }
  return requested;
}

function routeRequirements(bundle: StorefrontBundleV1, route: PublicRouteContext): DataRequirement[] {
  const routeId = resolvedRouteId(bundle, route);
  const artifact = bundle.routes[routeId];
  if (!artifact) throw new Error(`Missing compiled route ${routeId}`);
  const required: DataRequirement[] = [...bundle.shell.requiredData, ...artifact.requiredData];
  const force = (requirement: DataRequirement) => {
    if (!required.some((entry) => entry.kind === requirement.kind)) required.push(requirement);
  };
  if (route.kind === "product") force({ kind: "currentProduct" });
  if (route.kind === "collection") force({ kind: "currentCollection" });
  if (route.kind === "search") force({ kind: "searchResults", limit: 24 });
  if (route.kind === "cart") force({ kind: "cart" });
  return required;
}

/** Resolve once, then derive shell, route artifact, and presentation data from that immutable bundle. */
export async function resolveRuntime1Route(input: {
  shopId: string;
  route: PublicRouteContext;
  request?: Request;
  bundleReadEnabled?: boolean;
  reader?: StorefrontReleaseReader;
  dataDependencies?: PublicDataDependencies;
  assetUrlLoader?: StorefrontAssetUrlLoader;
}): Promise<Runtime1RouteData | null> {
  if (!(input.bundleReadEnabled ?? isStorefrontBundleReadEnabled())) return null;
  if (!isUuid(input.shopId)) return null;
  let release: ResolvedStorefrontRelease;
  try {
    release = await resolveStorefrontRelease(input);
  } catch (error) {
    // A shop with nothing published has nothing to serve — that's the
    // callers' clean 503 path, not an unhandled crash in the error logs
    // (crawlers hit unpublished tenant domains constantly).
    if (
      error instanceof StorefrontReleaseResolutionError
      && error.code === "no_compatible_storefront_release"
    ) {
      return null;
    }
    throw error;
  }
  if (release.kind !== "runtime1") return null;
  return resolveRuntime1VersionRoute({ ...input, version: release.version });
}

export async function resolveRuntime1VersionRoute(input: {
  shopId: string;
  route: PublicRouteContext;
  version: StorefrontVersionRecord;
  dataDependencies?: PublicDataDependencies;
  assetUrlLoader?: StorefrontAssetUrlLoader;
}): Promise<Runtime1RouteData | null> {
  const bundle = input.version.runtimeVersion === 1 && input.version.artifact.sourceKind !== "legacy"
    ? input.version.artifact.bundle
    : null;
  if (!bundle) return null;
  const routeId = resolvedRouteId(bundle, input.route);
  const derivedStaticAssets = recipeDerivedStaticAssets(bundle);
  const [data, storefrontAssetUrls] = await Promise.all([
    resolvePublicData({
      shopId: input.shopId,
      route: input.route,
      requiredData: routeRequirements(bundle, input.route),
      ...(input.route.kind === "home" && bundle.featuredProductIds
        ? { featuredProductIds: bundle.featuredProductIds }
        : {}),
    }, input.dataDependencies),
    bundle.source.kind === "custom" && derivedStaticAssets.ownedManifest.entries.length > 0
      ? (input.assetUrlLoader ?? resolveVerifiedStorefrontAssetUrls)({
          shopId: input.shopId,
          bundleId: input.version.id,
          manifest: derivedStaticAssets.ownedManifest,
        })
      : Promise.resolve({}),
  ]);
  const resolvedAssetUrls = { ...derivedStaticAssets.urls, ...storefrontAssetUrls };
  const isolatedShellCss = isolateCompiledShellCss(bundle.shell.css);
  const resolvedBundle = isolatedShellCss === bundle.shell.css
    ? bundle
    : { ...bundle, shell: { ...bundle.shell, css: isolatedShellCss } };
  return {
    runtime: 1,
    bundleId: input.version.id,
    artifactHash: input.version.artifactHash,
    routeId,
    bundle: resolvedBundle,
    data: Object.keys(resolvedAssetUrls).length > 0 ? { ...data, storefrontAssetUrls: resolvedAssetUrls } : data,
    visualLayerPlacement: resolveStorefrontVisualPlacement(resolvedBundle, routeId),
  };
}

export async function hasRuntime1Storefront(input: {
  shopId: string;
  request?: Request;
  bundleReadEnabled?: boolean;
  reader?: StorefrontReleaseReader;
}): Promise<boolean> {
  if (!(input.bundleReadEnabled ?? isStorefrontBundleReadEnabled())) return false;
  if (!isUuid(input.shopId)) return false;
  return (await resolveStorefrontRelease(input)).kind === "runtime1";
}
