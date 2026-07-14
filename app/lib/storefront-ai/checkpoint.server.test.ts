import { describe, expect, it } from "vitest";
import { generationCheckpointRow } from "./checkpoint.server";

describe("durable generation checkpoints", () => {
  it("persists only hashes, bounded counters, and allowlisted stage metadata", () => {
    const row = generationCheckpointRow({
      generationId: "11111111-1111-4111-8111-111111111111",
      shopId: "22222222-2222-4222-8222-222222222222",
      stage: "failed",
      at: 123,
      promptHash: `sha256:${"a".repeat(64)}`,
      contextFingerprint: `sha256:${"b".repeat(64)}`,
      usage: { candidates: 3, modelTokens: 10, images: 1, browserMs: 2, repairs: 0, wallMs: 4 },
      detail: {
        candidateId: "concept-1",
        message: "secret merchant prompt and provider response",
        storageUrl: "https://storage.example/private",
        screenshots: ["proof-1"],
      },
    });
    expect(row).toMatchObject({
      generation_id: "11111111-1111-4111-8111-111111111111",
      shop_id: "22222222-2222-4222-8222-222222222222",
      prompt_hash: `sha256:${"a".repeat(64)}`,
      context_fingerprint: `sha256:${"b".repeat(64)}`,
      detail_json: { candidateId: "concept-1" },
    });
    expect(JSON.stringify(row)).not.toMatch(/secret|storage\.example|proof-1/);
  });
});
