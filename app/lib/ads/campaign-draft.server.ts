// Owned campaign-draft read/write model. The dashboard's Create-campaign screen
// writes a draft row; the Campaigns list reads them back alongside synced
// campaigns. All access is service-role with shop_id threaded explicitly on
// every read/write (same contract as the rest of app/lib).

import { getSupabase } from "../supabase.server";
import type { CampaignDraftInput, CampaignDraftRow } from "./campaign-draft-types";

const LIST_CAP = 50;

interface DraftDbRow {
  id: string;
  name: string;
  platform: CampaignDraftRow["platform"];
  created_at: string;
}

function toRow(r: DraftDbRow): CampaignDraftRow {
  return { id: r.id, name: r.name, platform: r.platform, createdAt: r.created_at };
}

/** Newest-first drafts for a shop, capped at 50. */
export async function listCampaignDrafts(shopId: string): Promise<CampaignDraftRow[]> {
  const { data, error } = await getSupabase()
    .from("campaign_draft")
    .select("id, name, platform, created_at")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(LIST_CAP);
  if (error) throw error;
  return ((data ?? []) as DraftDbRow[]).map(toRow);
}

/** Insert one draft (input already validated at the API boundary). */
export async function createCampaignDraft(
  shopId: string,
  input: CampaignDraftInput,
): Promise<CampaignDraftRow> {
  const { data, error } = await getSupabase()
    .from("campaign_draft")
    .insert({ shop_id: shopId, name: input.name, platform: input.platform })
    .select("id, name, platform, created_at")
    .single();
  if (error) throw error;
  return toRow(data as DraftDbRow);
}

/** Delete one draft, scoped to the shop. Returns false when no row matched
 *  (already deleted, or belongs to another shop) so the route can 404 honestly
 *  instead of reporting success for a no-op. */
export async function deleteCampaignDraft(shopId: string, id: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("campaign_draft")
    .delete()
    .eq("shop_id", shopId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data != null;
}
