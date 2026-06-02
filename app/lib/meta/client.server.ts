import { getSupabase, resolveShopId } from "../supabase.server";
import { decrypt } from "../crypto.server";
import type { MetaClient, MetaResponse } from "./campaigns.server";

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export type MetaConnection = { client: MetaClient; adAccountId: string };

export async function metaClientForShop(shopDomain: string): Promise<MetaConnection | null> {
  const shopId = await resolveShopId(shopDomain);
  const { data, error } = await getSupabase()
    .from("integration_credentials")
    .select("access_token_encrypted, external_account_id")
    .eq("shop_id", shopId)
    .eq("kind", "meta_ads")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const token = decrypt(data.access_token_encrypted as string);
  const adAccountId = (data.external_account_id as string | null) ?? "";

  const client: MetaClient = {
    async get(path, params = {}) {
      const qs = new URLSearchParams({ ...params, access_token: token }).toString();
      const res = await fetch(`${GRAPH_BASE}${path}?${qs}`);
      return (await res.json()) as MetaResponse;
    },
    async post(path, body) {
      const form = new URLSearchParams({ ...body, access_token: token });
      const res = await fetch(`${GRAPH_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      return (await res.json()) as MetaResponse;
    },
  };
  return { client, adAccountId };
}
