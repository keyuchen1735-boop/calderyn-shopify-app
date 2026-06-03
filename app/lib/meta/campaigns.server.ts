export type MetaResponse = {
  data?: unknown;
  success?: boolean;
  error?: { message: string; code?: number; type?: string; fbtrace_id?: string };
  [k: string]: unknown;
};

export type MetaClient = {
  get(path: string, params?: Record<string, string>): Promise<MetaResponse>;
  post(path: string, body: Record<string, string>): Promise<MetaResponse>;
};

export type MetaCampaign = {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  dailyBudgetCents: number | null;
};

function check(r: MetaResponse): MetaResponse {
  if (r.error) {
    const code = r.error.code != null ? ` (code ${r.error.code})` : "";
    throw new Error(`Meta API error: ${r.error.message}${code}`);
  }
  return r;
}

type RawCampaign = {
  id: string;
  name: string;
  status?: string;
  effective_status?: string;
  daily_budget?: string;
};

export async function listCampaigns(client: MetaClient, adAccountId: string): Promise<MetaCampaign[]> {
  const body = check(
    await client.get(`/${adAccountId}/campaigns`, {
      fields: "id,name,status,effective_status,daily_budget",
    }),
  );
  const data = (body.data as RawCampaign[]) ?? [];
  return data.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status ?? "UNKNOWN",
    effectiveStatus: c.effective_status ?? c.status ?? "UNKNOWN",
    dailyBudgetCents: c.daily_budget != null ? Number(c.daily_budget) : null,
  }));
}

export async function setCampaignStatus(
  client: MetaClient,
  campaignId: string,
  status: "PAUSED" | "ACTIVE",
): Promise<void> {
  check(await client.post(`/${campaignId}`, { status }));
}

// Reads the campaign's current status from Meta so callers can record the true
// prior status (e.g. for audit pre_state / undo) rather than assuming it.
export async function getCampaignStatus(client: MetaClient, campaignId: string): Promise<string> {
  const body = check(await client.get(`/${campaignId}`, { fields: "status" }));
  return String((body as { status?: unknown }).status ?? "UNKNOWN");
}

type RawInsight = {
  campaign_id: string;
  spend?: string;
  purchase_roas?: { action_type?: string; value?: string }[];
};

function parsePurchaseRoas(pr: RawInsight["purchase_roas"]): number {
  if (!Array.isArray(pr) || pr.length === 0) return 0;
  const entry = pr.find((e) => e.action_type === "omni_purchase") ?? pr[0];
  const v = Number(entry?.value ?? 0);
  return Number.isFinite(v) ? v : 0;
}

export async function fetchCampaignInsights(
  client: MetaClient,
  adAccountId: string,
): Promise<Record<string, { spend7dCents: number; roas7d: number }>> {
  const out: Record<string, { spend7dCents: number; roas7d: number }> = {};
  let params: Record<string, string> = {
    level: "campaign",
    date_preset: "last_7d",
    fields: "campaign_id,spend,purchase_roas",
  };
  for (let page = 0; page < 50; page++) {
    const body = check(await client.get(`/${adAccountId}/insights`, params));
    for (const row of (body.data as RawInsight[]) ?? []) {
      out[String(row.campaign_id)] = {
        spend7dCents: Math.round(Number(row.spend ?? 0) * 100),
        roas7d: parsePurchaseRoas(row.purchase_roas),
      };
    }
    const paging = body.paging as { next?: string; cursors?: { after?: string } } | undefined;
    if (!paging?.next || !paging.cursors?.after) break;
    params = { ...params, after: paging.cursors.after };
  }
  return out;
}

export async function setCampaignBudget(
  client: MetaClient,
  campaignId: string,
  dailyBudgetCents: number,
): Promise<void> {
  check(await client.post(`/${campaignId}`, { daily_budget: String(dailyBudgetCents) }));
}
