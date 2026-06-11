import { RateLimitError } from "../ads/backoff";

export type MetaResponse = {
  data?: unknown;
  success?: boolean;
  error?: { message: string; code?: number; type?: string; fbtrace_id?: string };
  [k: string]: unknown;
};

// Meta throttle codes: 4/17/32/613 app-/user-/page-level limits, 80000/80004
// BUC "too many calls" for insights and ads-management objects.
const META_RATE_CODES = new Set([4, 17, 32, 613, 80000, 80004]);

/** Throw RateLimitError on a Meta throttle so withRetry can back off. */
export function assertNotRateLimited(r: MetaResponse): MetaResponse {
  const code = r.error?.code;
  if (code !== undefined && META_RATE_CODES.has(code)) {
    throw new RateLimitError(`Meta rate limit (code ${code})`);
  }
  return r;
}

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

export function check(r: MetaResponse): MetaResponse {
  // Throttles become RateLimitError FIRST so withRetry callers can back off;
  // every other error stays a plain failure.
  assertNotRateLimited(r);
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
