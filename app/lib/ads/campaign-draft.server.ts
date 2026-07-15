// Owned campaign-draft read/write model. The dashboard's Create-campaign screen
// writes a draft row; the Campaigns list reads them back alongside synced
// campaigns. All access is service-role with shop_id threaded explicitly on
// every read/write (same contract as the rest of app/lib).

import { getSupabase } from "../supabase.server";
import {
  parseCampaignDraftState,
  type CampaignDraftInput,
  type CampaignDraftRow,
} from "./campaign-draft-types";

const LIST_CAP = 50;

interface DraftDbRow {
  id: string;
  name: string;
  platform: CampaignDraftRow["platform"];
  created_at: string;
  updated_at: string;
  state: unknown;
}

function toRow(r: DraftDbRow): CampaignDraftRow {
  return {
    id: r.id,
    name: r.name,
    platform: r.platform,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    state: parseCampaignDraftState(r.state),
  };
}

async function findCampaignDraft(
  shopId: string,
  column: "id" | "run_id",
  value: string,
): Promise<CampaignDraftRow | null> {
  const { data, error } = await getSupabase()
    .from("campaign_draft")
    .select("id, name, platform, created_at, updated_at, state")
    .eq("shop_id", shopId)
    .eq(column, value)
    .maybeSingle();
  if (error) throw error;
  return data ? toRow(data as DraftDbRow) : null;
}

export function getCampaignDraftById(
  shopId: string,
  id: string,
): Promise<CampaignDraftRow | null> {
  return findCampaignDraft(shopId, "id", id);
}

export function getCampaignDraftByRunId(
  shopId: string,
  runId: string,
): Promise<CampaignDraftRow | null> {
  return findCampaignDraft(shopId, "run_id", runId);
}

/** Most recently touched drafts for a shop, capped at 50. */
export async function listCampaignDrafts(
  shopId: string,
): Promise<CampaignDraftRow[]> {
  const { data, error } = await getSupabase()
    .from("campaign_draft")
    .select("id, name, platform, created_at, updated_at, state")
    .eq("shop_id", shopId)
    .order("updated_at", { ascending: false })
    .limit(LIST_CAP);
  if (error) throw error;
  return ((data ?? []) as DraftDbRow[]).map(toRow);
}

/** Insert one draft (input already validated at the API boundary). */
export async function createCampaignDraft(
  shopId: string,
  input: CampaignDraftInput,
): Promise<CampaignDraftRow> {
  const row = {
    shop_id: shopId,
    name: input.name,
    platform: input.platform,
    state: input.state ?? {},
    run_id: input.state?.runId ?? null,
    updated_at: new Date().toISOString(),
  };
  const query = input.state?.runId
    ? getSupabase()
        .from("campaign_draft")
        .upsert(row, { onConflict: "shop_id,run_id" })
    : getSupabase().from("campaign_draft").insert(row);
  const { data, error } = await query
    .select("id, name, platform, created_at, updated_at, state")
    .single();
  if (error) throw error;
  return toRow(data as DraftDbRow);
}

/** Replace a saved draft in place so list ordering and deep links remain stable. */
export async function updateCampaignDraft(
  shopId: string,
  id: string,
  input: CampaignDraftInput,
): Promise<CampaignDraftRow | null> {
  const { data, error } = await getSupabase()
    .from("campaign_draft")
    .update({
      name: input.name,
      platform: input.platform,
      state: input.state ?? {},
      run_id: input.state?.runId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("shop_id", shopId)
    .eq("id", id)
    .select("id, name, platform, created_at, updated_at, state")
    .maybeSingle();
  if (error) throw error;
  return data ? toRow(data as DraftDbRow) : null;
}

/** Delete one draft, scoped to the shop. Returns false when no row matched
 *  (already deleted, or belongs to another shop) so the route can 404 honestly
 *  instead of reporting success for a no-op. */
export async function deleteCampaignDraft(
  shopId: string,
  id: string,
): Promise<boolean> {
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
