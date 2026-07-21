// QuickBooks Online API client (clone of app/lib/google/client.server.ts).
//
// Loads the shop's stored QBO refresh token, exchanges it for a short-lived
// access token, PERSISTS the rotated refresh token back (QBO invalidates the old
// one on each exchange), then runs the Inventory items query. Returns null when
// there is no usable credential row — never a fake token.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../supabase.server";
import { encrypt, decrypt } from "../crypto.server";
import { refreshAccessToken, type QboTokenResponse, type TokenFetcher } from "./oauth.server";

const PROD_BASE = "https://quickbooks.api.intuit.com";
const SANDBOX_BASE = "https://sandbox-quickbooks.api.intuit.com";

// Inventory items only — the cost source. Paginated with STARTPOSITION/MAXRESULTS
// (QBO caps a page at 1000) so large catalogs are pulled in full, not truncated.
const ITEMS_QUERY_BASE =
  "SELECT Id, Name, Sku, PurchaseCost, Type FROM Item WHERE Type = 'Inventory'";
const ITEMS_PAGE_SIZE = 1000; // QBO query MAXRESULTS hard cap
const MAX_PAGES = 100; // safety bound (≤100k items) against an unterminated loop

export function qboApiBase(env: string | undefined): string {
  return env === "production" ? PROD_BASE : SANDBOX_BASE;
}

export type QboClient = {
  queryItems(): Promise<unknown>;
  /** The company's home currency (e.g. "USD"), or null if it can't be determined. */
  queryHomeCurrency(): Promise<string | null>;
  queryReport(
    report: "ProfitAndLoss" | "CashFlow",
    params: { startDate: string; endDate: string; accountingMethod: "Accrual" | "Cash"; summarizeBy?: "Days" | "Months" | "Years" },
  ): Promise<unknown>;
};
export type QboConnection = { client: QboClient; realmId: string };

type CredentialRow = { access_token_encrypted: string | null; external_account_id: string | null };
type QboFaultBody = { Fault?: { Error?: Array<{ Message?: string }> } };
type ItemsResponse = { QueryResponse?: { Item?: unknown[] } };
type PreferencesResponse = {
  QueryResponse?: { Preferences?: Array<{ CurrencyPrefs?: { HomeCurrency?: { value?: string } } }> };
};

const realTokenFetcher: TokenFetcher = async (url, init) =>
  (await fetch(url, init)).json() as Promise<QboTokenResponse>;

export async function quickbooksClientForShop(
  shopId: string,
  deps: { sb?: SupabaseClient; fetcher?: TokenFetcher; httpFetch?: typeof fetch } = {},
): Promise<QboConnection | null> {
  const sb = deps.sb ?? getSupabase();
  const fetcher = deps.fetcher ?? realTokenFetcher;
  const httpFetch = deps.httpFetch ?? fetch;

  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("QBO_CLIENT_ID and QBO_CLIENT_SECRET must be set");
  }

  const { data, error } = await sb
    .from("integration_credentials")
    .select("access_token_encrypted, external_account_id")
    .eq("shop_id", shopId)
    .eq("kind", "quickbooks")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as CredentialRow;
  if (!row.access_token_encrypted || !row.external_account_id) return null;

  const storedRefresh = decrypt(row.access_token_encrypted);
  const tok = await refreshAccessToken(fetcher, { clientId, clientSecret, refreshToken: storedRefresh });

  // Persist the rotated refresh token immediately — the old one is now dead.
  const now = new Date().toISOString();
  const refreshExpiresAt = tok.refreshExpiresInSec
    ? new Date(Date.now() + tok.refreshExpiresInSec * 1000).toISOString()
    : null;
  const upd = await sb
    .from("integration_credentials")
    .update({
      access_token_encrypted: encrypt(tok.refreshToken),
      token_expires_at: refreshExpiresAt,
      updated_at: now,
    })
    .eq("shop_id", shopId)
    .eq("kind", "quickbooks");
  if (upd.error) throw upd.error;

  const base = qboApiBase(process.env.QBO_ENV);
  const realmId = row.external_account_id;

  // Injection safety: realmId must be an Intuit numeric id. NEVER interpolate
  // untrusted text into the request path.
  if (!/^\d+$/.test(realmId)) {
    throw new Error("Invalid QuickBooks realm id");
  }

  // Run one QBO query; throws on a non-2xx (never silently parses an error body).
  async function runQuery(qbql: string): Promise<unknown> {
    const u = `${base}/v3/company/${realmId}/query?query=${encodeURIComponent(qbql)}&minorversion=65`;
    const res = await httpFetch(u, {
      headers: { Authorization: `Bearer ${tok.accessToken}`, Accept: "application/json" },
    });
    const json = (await res.json()) as unknown;
    if (!res.ok) {
      const msg = (json as QboFaultBody)?.Fault?.Error?.[0]?.Message;
      throw new Error(`QuickBooks API error: ${msg ?? `HTTP ${res.status}`}`);
    }
    return json;
  }

  async function runReport(
    report: "ProfitAndLoss" | "CashFlow",
    params: { startDate: string; endDate: string; accountingMethod: "Accrual" | "Cash"; summarizeBy?: "Days" | "Months" | "Years" },
  ): Promise<unknown> {
    const query = new URLSearchParams({
      start_date: params.startDate,
      end_date: params.endDate,
      accounting_method: params.accountingMethod,
      minorversion: "65",
    });
    if (params.summarizeBy) query.set("summarize_column_by", params.summarizeBy);
    const u = `${base}/v3/company/${realmId}/reports/${report}?${query}`;
    const res = await httpFetch(u, {
      headers: { Authorization: `Bearer ${tok.accessToken}`, Accept: "application/json" },
    });
    const json = (await res.json()) as unknown;
    if (!res.ok) {
      const msg = (json as QboFaultBody)?.Fault?.Error?.[0]?.Message;
      throw new Error(`QuickBooks API error: ${msg ?? `HTTP ${res.status}`}`);
    }
    return json;
  }

  const client: QboClient = {
    async queryItems(): Promise<unknown> {
      const all: unknown[] = [];
      let start = 1;
      for (let page = 0; page < MAX_PAGES; page++) {
        const json = await runQuery(`${ITEMS_QUERY_BASE} STARTPOSITION ${start} MAXRESULTS ${ITEMS_PAGE_SIZE}`);
        const items = (json as ItemsResponse)?.QueryResponse?.Item ?? [];
        all.push(...items);
        if (items.length < ITEMS_PAGE_SIZE) break; // last (partial) page
        start += ITEMS_PAGE_SIZE;
      }
      return { QueryResponse: { Item: all } };
    },
    async queryHomeCurrency(): Promise<string | null> {
      // A failed/odd Preferences read degrades to "no currency check" rather
      // than failing the whole sync — the guard is a safety net, not core.
      try {
        const json = await runQuery("SELECT * FROM Preferences");
        const value = (json as PreferencesResponse)?.QueryResponse?.Preferences?.[0]?.CurrencyPrefs
          ?.HomeCurrency?.value;
        return typeof value === "string" && value ? value : null;
      } catch {
        return null;
      }
    },
    queryReport: runReport,
  };
  return { client, realmId };
}
