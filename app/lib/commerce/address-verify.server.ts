// app/lib/commerce/address-verify.server.ts
//
// Best-effort address verification at the checkout quote step (shipping deferred D3).
// When the shop has a carrier credential, the buyer's typed address is run through
// EasyPost's delivery verification; if the verified (standardized) form differs, the
// checkout offers a one-click "use suggested address". STRICTLY ADVISORY:
//   - hard 2s budget — a slow verifier must not slow the options step;
//   - never throws, never blocks — no credential, API failure, timeout, or an
//     unverifiable address all yield null (no suggestion), and checkout proceeds
//     with whatever the buyer typed.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "~/lib/supabase.server";
import { basicAuthHeader, apiBase, loadEasyPostApiKey } from "~/lib/ship-cost/adapters/easypost.server";
import { toEasyPostAddress } from "~/lib/ship-cost/adapters/easypost-rate.server";
import type { Address } from "~/lib/ship-cost/adapters/rate-quote";

const VERIFY_TIMEOUT_MS = 2000;

/** The standardized form, shaped like the checkout form's field names. No country:
 *  the comparison deliberately ignores it (a country "correction" is never suggested),
 *  so the buyer's chosen country always stands. */
export interface AddressSuggestion {
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postal: string;
}

/** Fields we read off EasyPost's POST /v2/addresses response. */
interface EasyPostVerifiedAddress {
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  verifications?: { delivery?: { success?: boolean | null } | null } | null;
}

function norm(v: string | null | undefined): string {
  return (v ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

/** True when the verified form meaningfully differs from what the buyer typed. */
function differs(typed: Address, verified: AddressSuggestion): boolean {
  return (
    norm(typed.street1) !== norm(verified.line1) ||
    norm(typed.street2) !== norm(verified.line2) ||
    norm(typed.city) !== norm(verified.city) ||
    norm(typed.state) !== norm(verified.region) ||
    norm(typed.zip) !== norm(verified.postal)
  );
}


/**
 * Verify the buyer's shipping address; returns the standardized form when it differs,
 * else null. NEVER throws and never exceeds the ~2s budget — see the module header.
 * The budget is enforced END-TO-END (credential read + decrypt + HTTP) via a race, not
 * just on the HTTP call: a hung Supabase read must not stall the options step either.
 */
export async function verifyCheckoutAddress(
  shopId: string,
  destination: Address,
  fetchImpl: typeof fetch = fetch,
  sb?: SupabaseClient,
): Promise<AddressSuggestion | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), VERIFY_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([attemptVerify(shopId, destination, fetchImpl, sb), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function attemptVerify(
  shopId: string,
  destination: Address,
  fetchImpl: typeof fetch,
  sb?: SupabaseClient,
): Promise<AddressSuggestion | null> {
  try {
    // Resolved INSIDE the try: even a misconfigured Supabase client must degrade to
    // "no suggestion", never fail the quote step this rides along with.
    const apiKey = await loadEasyPostApiKey(shopId, sb ?? getSupabase());
    if (!apiKey) return null; // no carrier credential → no verification, never a block

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${apiBase()}/addresses`, {
        method: "POST",
        headers: {
          Authorization: basicAuthHeader(apiKey),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          // Same serializer as quoting/labels — the verifier must standardize the
          // exact address shape the other EasyPost surfaces post.
          address: toEasyPostAddress(destination),
          verify: ["delivery"],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Advisory result, but the upstream failure is still surfaced (rule: never
        // swallow error payloads) — a revoked key must be diagnosable from logs.
        const snippet = (await res.text().catch(() => "")).slice(0, 200);
        console.warn(`[address-verify] EasyPost verify failed for shop ${shopId} (${res.status}): ${snippet}`);
        return null;
      }
      const json = (await res.json().catch(() => null)) as EasyPostVerifiedAddress | null;
      if (!json || json.verifications?.delivery?.success !== true) return null;
      const suggestion: AddressSuggestion = {
        line1: (json.street1 ?? "").trim(),
        line2: json.street2?.trim() || null,
        city: (json.city ?? "").trim(),
        region: (json.state ?? "").trim(),
        postal: (json.zip ?? "").trim(),
      };
      if (!suggestion.line1 || !suggestion.city || !suggestion.postal) return null;
      return differs(destination, suggestion) ? suggestion : null;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Advisory only: log quietly (no buyer PII) and move on.
    console.warn(
      `[address-verify] verification skipped for shop ${shopId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
