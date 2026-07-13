export type StorefrontEditJson = Record<string, unknown> | unknown[];

export interface StorefrontEditAuditInput {
  baseArtifactHash: string;
  resultArtifactHash: string;
  prompt: string;
  scope: StorefrontEditJson;
  patch: StorefrontEditJson;
  provider: StorefrontEditJson;
  validation: StorefrontEditJson;
}

export interface StorefrontEditAuditRpcParams {
  p_base_artifact_hash: string;
  p_result_artifact_hash: string;
  p_prompt: string;
  p_scope_json: StorefrontEditJson;
  p_patch_json: StorefrontEditJson;
  p_provider_json: StorefrontEditJson;
  p_validation_json: StorefrontEditJson;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

/** Keep the edit audit vocabulary in one place so deterministic and AI edit paths replay identically. */
export function editAuditRpcParams(input: StorefrontEditAuditInput): StorefrontEditAuditRpcParams {
  return {
    p_base_artifact_hash: required(input.baseArtifactHash, "baseArtifactHash"),
    p_result_artifact_hash: required(input.resultArtifactHash, "resultArtifactHash"),
    p_prompt: required(input.prompt, "prompt"),
    p_scope_json: input.scope,
    p_patch_json: input.patch,
    p_provider_json: input.provider,
    p_validation_json: input.validation,
  };
}
