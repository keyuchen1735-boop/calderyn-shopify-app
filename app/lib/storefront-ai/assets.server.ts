import { isCompilerIdentifier } from "../storefront-compiler/assets";
import type { AssetRequest, MaterializedAssetResult, PersistedOwnedAsset, ProducedAsset } from "./contracts";

const HASH = /^[a-f0-9]{64}$/i;
const OWNED_MEDIA = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);

export interface MaterializeOwnedAssetsInput {
  shopId: string;
  requests: AssetRequest[];
  produce(request: AssetRequest): Promise<ProducedAsset | null>;
  persist(input: { shopId: string; bytes: Uint8Array; signal?: AbortSignal }): Promise<PersistedOwnedAsset>;
  signal?: AbortSignal;
  onImage?: () => void;
  onPersisted?: (asset: MaterializedAssetResult["persisted"][number]) => void;
}

export async function materializeOwnedAssets(input: MaterializeOwnedAssetsInput): Promise<MaterializedAssetResult> {
  const seen = new Set<string>();
  for (const request of input.requests) {
    if (!isCompilerIdentifier(request.key) || seen.has(request.key)) throw new Error(`Invalid or duplicate asset request ${request.key}`);
    seen.add(request.key);
  }
  const persisted: MaterializedAssetResult["persisted"] = [];
  const proofAssets: MaterializedAssetResult["proofAssets"] = [];
  for (const request of input.requests) {
    if (input.signal?.aborted) throw new DOMException("Generation cancelled", "AbortError");
    const produced = await input.produce(request);
    if (!produced) {
      if (request.required) throw new Error(`Required asset ${request.key} could not be produced`);
      continue;
    }
    input.onImage?.();
    if (!(produced.bytes instanceof Uint8Array) || produced.bytes.byteLength === 0) throw new Error(`Asset ${request.key} produced no bytes`);
    const stored = await input.persist({ shopId: input.shopId, bytes: produced.bytes, signal: input.signal });
    if (!stored.assetKey || /^(?:https?:)?\/\//i.test(stored.assetKey) || stored.assetKey.includes("..")) throw new Error("Persisted storefront asset is not an owned key");
    if (!HASH.test(stored.contentHash) || !OWNED_MEDIA.has(stored.mediaType) || stored.byteSize !== produced.bytes.byteLength) {
      throw new Error(`Persisted storefront asset ${request.key} failed immutable identity verification`);
    }
    const persistedAsset = { ...stored, logicalKey: request.key, provenance: produced.provenance.slice(0, 500) };
    persisted.push(persistedAsset);
    proofAssets.push({
      key: request.key,
      logicalKey: request.key,
      contentHash: stored.contentHash,
      mediaType: stored.mediaType,
      byteSize: stored.byteSize,
      bytes: produced.bytes.slice(),
    });
    input.onPersisted?.(persistedAsset);
  }
  return {
    manifest: { entries: persisted.map((asset) => ({ key: asset.logicalKey, contentHash: asset.contentHash, mediaType: asset.mediaType, byteSize: asset.byteSize })) },
    persisted,
    proofAssets,
  };
}
