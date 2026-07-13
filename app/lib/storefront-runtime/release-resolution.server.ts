import type { StorefrontBundleV1 } from "~/lib/storefront-bundle/types";
import { getSupabase } from "~/lib/supabase.server";

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

export interface StorefrontReleaseReader {
  readPublished(shopId: string): Promise<StorefrontVersionRecord | null>;
  readRetainedHistory(shopId: string): Promise<StorefrontVersionRecord[]>;
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

const VERSION_COLUMNS = [
  "id", "shop_id", "source_kind", "status", "schema_version", "runtime_version",
  "validation_profile_version", "artifact_hash", "bundle_json", "created_at",
].join(", ");

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

  async readRetainedHistory(shopId) {
    const client = getSupabase();
    const history = await client
      .from("storefront_release_history")
      .select("to_version_id, created_at")
      .eq("shop_id", shopId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (history.error) throw history.error;
    const orderedIds = [...new Set((history.data ?? []).map((row) => String(row.to_version_id)))];
    if (orderedIds.length === 0) return [];
    const versions = await client
      .from("storefront_bundle_version")
      .select(VERSION_COLUMNS)
      .eq("shop_id", shopId)
      .in("id", orderedIds);
    if (versions.error) throw versions.error;
    const byId = new Map((versions.data ?? []).map((row) => {
      const mapped = mapVersion(row as unknown as DatabaseVersionRow);
      return [mapped.id, mapped];
    }));
    return orderedIds.flatMap((id) => {
      const version = byId.get(id);
      return version ? [version] : [];
    });
  },
};

function supported(version: StorefrontVersionRecord): boolean {
  if (version.status !== "validated" || version.schemaVersion !== 1) return false;
  if (version.runtimeVersion === 0) {
    return version.sourceKind === "legacy" && version.validationProfileVersion === 0 &&
      version.artifact.sourceKind === "legacy";
  }
  return version.runtimeVersion === 1 && version.validationProfileVersion === 1 &&
    (version.sourceKind === "recipe" || version.sourceKind === "custom") &&
    version.artifact.sourceKind === version.sourceKind;
}

function newestCompatible(
  versions: readonly StorefrontVersionRecord[],
  runtime1Enabled: boolean,
): StorefrontVersionRecord | null {
  return [...versions]
    .filter((version) => supported(version) && (runtime1Enabled || version.runtimeVersion === 0))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

export type ResolvedStorefrontRelease =
  | { kind: "runtime0-live" }
  | { kind: "runtime0-snapshot"; version: StorefrontVersionRecord; fallbackFromVersionId?: string }
  | { kind: "runtime1"; version: StorefrontVersionRecord; fallbackFromVersionId?: string };

function resolvedVersion(version: StorefrontVersionRecord, fallbackFromVersionId?: string): ResolvedStorefrontRelease {
  const fallback = fallbackFromVersionId ? { fallbackFromVersionId } : {};
  return version.runtimeVersion === 0
    ? { kind: "runtime0-snapshot", version, ...fallback }
    : { kind: "runtime1", version, ...fallback };
}

export async function resolveStorefrontRelease(input: {
  shopId: string;
  runtime1Enabled?: boolean;
  reader?: StorefrontReleaseReader;
}): Promise<ResolvedStorefrontRelease> {
  const reader = input.reader ?? storefrontReleaseReader;
  const runtime1Enabled = input.runtime1Enabled ?? /^(?:1|true)$/i.test(process.env.STOREFRONT_RUNTIME_1_READ ?? "");
  const published = await reader.readPublished(input.shopId);
  if (!published) return { kind: "runtime0-live" };
  if (supported(published) && (runtime1Enabled || published.runtimeVersion === 0)) {
    return resolvedVersion(published);
  }
  const fallback = newestCompatible(await reader.readRetainedHistory(input.shopId), runtime1Enabled);
  if (!fallback) return { kind: "runtime0-live" };
  return resolvedVersion(fallback, published.id);
}
