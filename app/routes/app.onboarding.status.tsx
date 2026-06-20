import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { calderynClient } from "~/lib/calderyn.server";
import { providerPaired } from "~/lib/integrations";

/**
 * Lightweight pairing-status poll for the onboarding connect step's NEW-TAB OAuth
 * flow. The setup tab polls this (and re-checks on focus) while a provider is
 * "connecting", then flips its row to Connected when the server's shop_integrations
 * row appears. One integrations.list read; deliberately never 500s the poll.
 */
export type OnboardingStatus = {
  ok: boolean;
  google: boolean;
  meta: boolean;
  tiktok: boolean;
  quickbooks: boolean;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const integrations = await client.integrations.list(request.signal);
    return json<OnboardingStatus>({
      ok: true,
      google: providerPaired(integrations, "google"),
      meta: providerPaired(integrations, "meta"),
      tiktok: providerPaired(integrations, "tiktok"),
      quickbooks: providerPaired(integrations, "quickbooks"),
    });
  } catch {
    // A transient read failure must not downgrade the UI or throw mid-poll;
    // ok:false tells the client to ignore this tick (don't revert "connecting").
    return json<OnboardingStatus>({
      ok: false,
      google: false,
      meta: false,
      tiktok: false,
      quickbooks: false,
    });
  }
};
