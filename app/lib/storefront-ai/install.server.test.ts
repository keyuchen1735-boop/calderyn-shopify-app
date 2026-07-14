import { describe, expect, it, vi } from "vitest";
import { compileBundle } from "../storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "../storefront-compiler/__fixtures__/valid-bundle";
import type { InstallGeneratedStorefrontBundleInput } from "../storefront-bundle/release.server";
import { createDefaultGenerateDependencies } from "./generate.server";
import type { GenerationAudit } from "./contracts";
import { createContext } from "./__fixtures__/deterministic";

const calls = vi.hoisted(() => ({
  createVersion: vi.fn(async () => "22222222-2222-4222-8222-222222222222"),
  attachAsset: vi.fn(async () => undefined),
  hashArtifact: vi.fn(async () => `sha256:${"b".repeat(64)}`),
  validateVersion: vi.fn(async () => "22222222-2222-4222-8222-222222222222"),
  installDraft: vi.fn(async () => "22222222-2222-4222-8222-222222222222"),
  atomicInstall: vi.fn(async (_input: InstallGeneratedStorefrontBundleInput) => ({
    versionId: "22222222-2222-4222-8222-222222222222",
    installedDraftVersionId: "22222222-2222-4222-8222-222222222222",
  })),
}));

vi.mock("../storefront-bundle/release.server", () => ({
  createStorefrontBundleVersion: calls.createVersion,
  hashStorefrontArtifact: calls.hashArtifact,
  validateStorefrontBundleVersion: calls.validateVersion,
  installStorefrontDraft: calls.installDraft,
  installGeneratedStorefrontBundle: calls.atomicInstall,
}));
vi.mock("../storefront-bundle/assets.server", () => ({
  attachVerifiedStorefrontAsset: calls.attachAsset,
  persistStorefrontAssetBytes: vi.fn(),
}));

describe("generated storefront installation", () => {
  it("persists the runtime custom envelope and attaches logical keys to immutable objects", async () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.assets.entries = [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 3 }];
    const bundle = compileBundle(source).bundle;
    const audit = {
      contractVersion: 1,
      promptContractVersion: 1,
      generationId: "generation-1",
      shopId: "11111111-1111-4111-8111-111111111111",
      rawPrompt: "Original",
      promptHash: `sha256:${"c".repeat(64)}`,
      contextFingerprint: `sha256:${"d".repeat(64)}`,
      contextSnapshot: createContext(),
      routingResolution: null,
      providerCalls: [],
      candidateCount: 3,
      rejectedCandidates: [],
      candidateScores: [],
      repairCount: 0,
      assetCount: 1,
      assetProvenance: [],
      routeValidation: { ok: true, diagnostics: [], screenshots: [], browserMs: 1 },
      usage: { candidates: 3, modelTokens: 0, images: 1, browserMs: 1, repairs: 0, wallMs: 1 },
      finalArtifactHash: `sha256:${"e".repeat(64)}`,
    } satisfies GenerationAudit;

    const installed = await createDefaultGenerateDependencies().installValidatedBundle({
      shopId: audit.shopId,
      expectedDraftVersionId: null,
      actorId: null,
      prompt: audit.rawPrompt,
      bundle,
      artifactHash: audit.finalArtifactHash,
      validationReport: { valid: true },
      persistedAssets: [{
        logicalKey: "hero",
        assetKey: "11111111-1111-4111-8111-111111111111/storefront/sha256/object.webp",
        contentHash: "a".repeat(64),
        mediaType: "image/webp",
        byteSize: 3,
        provenance: "fixture",
      }],
      audit,
    });

    expect(calls.atomicInstall).toHaveBeenCalledWith(expect.objectContaining({
      shopId: audit.shopId,
      expectedDraftVersionId: null,
      artifact: { sourceKind: "custom", bundle },
      assetReferences: [expect.objectContaining({
        logicalKey: "hero",
        assetKey: expect.stringContaining("/storefront/sha256/"),
      })],
      resolution: expect.objectContaining({
        audit: expect.objectContaining({ finalArtifactHash: `sha256:${"b".repeat(64)}` }),
      }),
    }));
    const installPayload = calls.atomicInstall.mock.calls[0][0];
    expect(JSON.stringify(installPayload.resolution)).not.toContain(audit.rawPrompt);
    expect(JSON.stringify(installPayload.resolution)).not.toContain("Arc Lamp");
    expect(calls.createVersion).not.toHaveBeenCalled();
    expect(calls.attachAsset).not.toHaveBeenCalled();
    expect(calls.validateVersion).not.toHaveBeenCalled();
    expect(calls.installDraft).not.toHaveBeenCalled();
    expect(installed.artifactHash).toBe(`sha256:${"b".repeat(64)}`);
  });
});
