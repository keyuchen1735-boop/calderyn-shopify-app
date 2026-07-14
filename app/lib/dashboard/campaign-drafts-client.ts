// Client fetchers for owned campaign drafts. Kept in its own module (not
// client.ts) so parallel surface work never collides on one file.
import { apiGet, apiSend } from "./client";
import type {
  CampaignDraftInput,
  CampaignDraftPlatform,
  CampaignDraftRow,
} from "~/lib/ads/campaign-draft-types";

export type { CampaignDraftInput, CampaignDraftPlatform, CampaignDraftRow };

export async function fetchCampaignDrafts(): Promise<CampaignDraftRow[]> {
  const data = await apiGet<{ drafts: CampaignDraftRow[] }>(
    "/dashboard/api/campaign-drafts",
  );
  return data.drafts;
}

export async function createCampaignDraft(
  input: CampaignDraftInput,
): Promise<CampaignDraftRow> {
  const data = await apiSend<{ draft: CampaignDraftRow }>(
    "POST",
    "/dashboard/api/campaign-drafts",
    input,
  );
  return data.draft;
}

export async function updateCampaignDraft(
  id: string,
  input: CampaignDraftInput,
): Promise<CampaignDraftRow> {
  const data = await apiSend<{ draft: CampaignDraftRow }>(
    "PUT",
    `/dashboard/api/campaign-drafts?id=${encodeURIComponent(id)}`,
    input,
  );
  return data.draft;
}

/** Delete one draft. The route 404s if it is already gone or belongs to
 *  another shop — apiSend surfaces that as a DashboardApiError. */
export async function deleteCampaignDraft(id: string): Promise<void> {
  await apiSend(
    "DELETE",
    `/dashboard/api/campaign-drafts?id=${encodeURIComponent(id)}`,
  );
}
