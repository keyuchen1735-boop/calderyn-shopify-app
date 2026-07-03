// DTO shapes + input validation shared by the campaign-draft read/write model
// (campaign-draft.server.ts) and the dashboard client/screen. Plain types and
// pure functions only — safe to import from the browser.

export const CAMPAIGN_DRAFT_PLATFORMS = ["meta", "google", "tiktok"] as const;
export type CampaignDraftPlatform = (typeof CAMPAIGN_DRAFT_PLATFORMS)[number];

/** Display labels matching the Platform union the campaigns list renders. */
export const CAMPAIGN_DRAFT_PLATFORM_LABELS: Record<CampaignDraftPlatform, string> = {
  meta: "Meta",
  google: "Google",
  tiktok: "TikTok",
};

export const MAX_CAMPAIGN_DRAFT_NAME_LENGTH = 120;

export interface CampaignDraftRow {
  id: string;
  name: string;
  platform: CampaignDraftPlatform;
  createdAt: string;
}

export interface CampaignDraftInput {
  name: string;
  platform: CampaignDraftPlatform;
}

/** Validate an untrusted JSON body at the API boundary: name 1–120 chars after
 *  trimming, platform one of the fixed set. Never trusts the inbound shape. */
export function validateCampaignDraftInput(
  raw: unknown,
): { ok: true; value: CampaignDraftInput } | { ok: false; code: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, code: "invalid_body" };
  const r = raw as Record<string, unknown>;

  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) return { ok: false, code: "missing_name" };
  if (name.length > MAX_CAMPAIGN_DRAFT_NAME_LENGTH) return { ok: false, code: "name_too_long" };

  const platform = CAMPAIGN_DRAFT_PLATFORMS.includes(r.platform as CampaignDraftPlatform)
    ? (r.platform as CampaignDraftPlatform)
    : null;
  if (!platform) return { ok: false, code: "invalid_platform" };

  return { ok: true, value: { name, platform } };
}
