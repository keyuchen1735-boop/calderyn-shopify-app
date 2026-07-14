import { getSupabase } from "~/lib/supabase.server";
import type { GenerationCheckpoint } from "./contracts";

const DETAIL_KEYS = new Set(["candidateId", "valid", "rejected", "accepted", "assets", "versionId", "artifactHash"]);

function redactedDetail(detail: GenerationCheckpoint["detail"]): Record<string, unknown> {
  if (!detail) return {};
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (!DETAIL_KEYS.has(key)) continue;
    if (typeof value === "string") redacted[key] = value.slice(0, 160);
    else if (typeof value === "number" && Number.isFinite(value)) redacted[key] = value;
    else if (typeof value === "boolean") redacted[key] = value;
  }
  return redacted;
}

export function generationCheckpointRow(event: GenerationCheckpoint) {
  const terminal = event.stage === "installed" || event.stage === "failed" || event.stage === "cancelled";
  const timestamp = new Date(event.at).toISOString();
  return {
    generation_id: event.generationId,
    shop_id: event.shopId,
    stage: event.stage,
    prompt_hash: event.promptHash,
    context_fingerprint: event.contextFingerprint ?? null,
    usage_json: event.usage,
    detail_json: redactedDetail(event.detail),
    updated_at: timestamp,
    ...(terminal ? { completed_at: timestamp } : {}),
  };
}

export async function persistGenerationCheckpoint(event: GenerationCheckpoint): Promise<void> {
  const { error } = await getSupabase()
    .from("storefront_generation_run")
    .upsert(generationCheckpointRow(event), { onConflict: "generation_id" });
  if (error) throw new Error(`Storefront generation checkpoint failed: ${error.message}`);
}
