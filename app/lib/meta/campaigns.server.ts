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
