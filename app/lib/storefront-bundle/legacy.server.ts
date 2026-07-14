import { Fragment, createElement } from "react";
import { renderToString } from "react-dom/server";
import { isUuid } from "~/lib/ids";
import { getSupabase } from "~/lib/supabase.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { renderBlocks } from "~/lib/storebuilder/render";
import { sanitizeDocHtml } from "~/lib/storebuilder/sanitize-html.server";
import type { BlockDocument, RenderContext } from "~/lib/storebuilder/types";
import { validateDocument } from "~/lib/storebuilder/validate";
import { persistStorefrontAssetBytes } from "./assets.server";
import { hashStorefrontArtifact, StorefrontReleaseError } from "./release.server";

export interface CaptureLegacyReleaseInput {
  shopId: string;
  actorId?: string | null;
}

interface PreparedLegacyCapture {
  existingVersionId?: string;
  snapshot?: Record<string, unknown>;
  sourceAssets?: Array<{ storageKey: string; publicUrl: string; referencedValues?: string[] }>;
  captureToken?: string;
}

export interface LegacyCapturePayload {
  existingVersionId?: string;
  snapshot: Record<string, unknown> | null;
  assetManifest: Record<string, unknown> | null;
  artifactHash: string | null;
  validationReport: Record<string, unknown> | null;
  captureToken: string | null;
}

function asLegacyDocuments(snapshot: Record<string, unknown>): Record<"home" | "collection" | "pdp", BlockDocument | null> {
  if (snapshot.schemaVersion !== 1 || snapshot.runtimeVersion !== 0 || snapshot.validationProfileVersion !== 0) {
    throw new StorefrontReleaseError("legacy_capture_invalid", "Legacy snapshot version is invalid", 422);
  }
  const raw = snapshot.pageDocuments;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new StorefrontReleaseError("legacy_capture_invalid", "Legacy page documents are invalid", 422);
  }
  const docs = raw as Record<string, unknown>;
  const result = {} as Record<"home" | "collection" | "pdp", BlockDocument | null>;
  for (const key of ["home", "collection", "pdp"] as const) {
    const value = docs[key];
    if (value == null) result[key] = null;
    else if (typeof value === "object" && !Array.isArray(value) && Array.isArray((value as BlockDocument).blocks)) {
      result[key] = value as BlockDocument;
    } else {
      throw new StorefrontReleaseError("legacy_capture_invalid", `Legacy ${key} document is invalid`, 422);
    }
  }
  return result;
}

async function validateLegacySnapshot(shopId: string, snapshot: Record<string, unknown>): Promise<Record<string, unknown>> {
  const docs = asLegacyDocuments(snapshot);
  const catalog = getCatalog();
  const [products, collections] = await Promise.all([catalog.listProducts(shopId), catalog.listCollections(shopId)]);
  const valid = {
    productIds: new Set(products.map((product) => product.id)),
    collectionHandles: new Set(collections.map((collection) => collection.handle)),
  };
  const renderContext: RenderContext = {
    data: { collections: [], productsByCollection: {}, productsById: {}, allProducts: [] },
  };
  for (const [key, doc] of Object.entries(docs)) {
    if (!doc) continue;
    const sanitized = sanitizeDocHtml(doc);
    if (JSON.stringify(sanitized) !== JSON.stringify(doc)) {
      throw new StorefrontReleaseError("legacy_capture_invalid", `Legacy ${key} document requires sanitization`, 422);
    }
    const checked = validateDocument(doc, valid);
    if (checked.dropped.length > 0 || checked.missingFunctional.length > 0) {
      throw new StorefrontReleaseError("legacy_capture_invalid", `Legacy ${key} document failed validation`, 422);
    }
    renderToString(createElement(Fragment, null, ...renderBlocks(checked.doc, renderContext)));
  }
  return { valid: true, legacyAdapter: "validated", checkedRoutes: Object.keys(docs), checkedAt: new Date().toISOString() };
}

export async function prepareLegacyCapturePayload(shopId: string): Promise<LegacyCapturePayload> {
  if (!isUuid(shopId)) throw new StorefrontReleaseError("invalid_storefront_release", "shopId must be a UUID", 422);
  const preparedResult = await getSupabase().rpc("prepare_storefront_legacy_capture", { p_shop_id: shopId });
  if (preparedResult.error) throw new StorefrontReleaseError("legacy_capture_failed", preparedResult.error.message, 500, preparedResult.error);
  const prepared = preparedResult.data as PreparedLegacyCapture | null;
  if (prepared?.existingVersionId && isUuid(prepared.existingVersionId)) {
    return {
      existingVersionId: prepared.existingVersionId,
      snapshot: null,
      assetManifest: null,
      artifactHash: null,
      validationReport: null,
      captureToken: null,
    };
  }
  if (!prepared?.snapshot || !prepared.captureToken) {
    throw new StorefrontReleaseError("legacy_capture_invalid", "Database returned an invalid legacy capture candidate", 422);
  }
  const validationReport = await validateLegacySnapshot(shopId, prepared.snapshot);
  const entriesByKey = new Map<string, { key: string; contentHash: string; mediaType: string; byteSize: number }>();
  const aliases: Record<string, string> = {};
  for (const source of prepared.sourceAssets ?? []) {
    const downloaded = await getSupabase().storage.from("shop-assets").download(source.storageKey);
    if (downloaded.error || !downloaded.data) {
      throw new StorefrontReleaseError("legacy_capture_asset_failed", downloaded.error?.message ?? "Owned asset download failed", 503, downloaded.error);
    }
    const persisted = await persistStorefrontAssetBytes({
      shopId,
      bytes: new Uint8Array(await downloaded.data.arrayBuffer()),
    });
    entriesByKey.set(persisted.assetKey, {
      key: persisted.assetKey,
      contentHash: persisted.contentHash,
      mediaType: persisted.mediaType,
      byteSize: persisted.byteSize,
    });
    for (const referencedValue of source.referencedValues ?? [source.publicUrl]) {
      aliases[referencedValue] = persisted.assetKey;
    }
  }
  const entries = [...entriesByKey.values()].sort((left, right) => left.key.localeCompare(right.key));
  const snapshot = {
    ...prepared.snapshot,
    referencedAssetKeys: entries.map((entry) => entry.key),
    assetAliases: aliases,
  };
  const assetManifest = { entries };
  const artifact = { sourceKind: "legacy", snapshot };
  const artifactHash = await hashStorefrontArtifact({
    schemaVersion: 1,
    runtimeVersion: 0,
    validationProfileVersion: 0,
    artifact,
    assetManifest,
  });
  return { snapshot, assetManifest, artifactHash, validationReport, captureToken: prepared.captureToken };
}

/** The database captures documents/settings under one row lock and returns the existing capture on retries. */
export async function captureLegacyRelease(input: CaptureLegacyReleaseInput): Promise<string> {
  const payload = await prepareLegacyCapturePayload(input.shopId);
  if (payload.existingVersionId) return payload.existingVersionId;
  const { data, error } = await getSupabase().rpc("capture_storefront_legacy_release", {
    p_shop_id: input.shopId,
    p_actor_id: input.actorId ?? null,
    p_snapshot: payload.snapshot,
    p_asset_manifest: payload.assetManifest,
    p_artifact_hash: payload.artifactHash,
    p_validation_report: payload.validationReport,
    p_capture_token: payload.captureToken,
  });
  if (error) throw new StorefrontReleaseError("legacy_capture_failed", error.message, 500, error);
  if (!isUuid(data as string)) throw new StorefrontReleaseError("legacy_capture_failed", "Legacy capture returned no version id", 500);
  return data as string;
}
