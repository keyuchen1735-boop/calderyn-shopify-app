import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { reapAbandonedCheckouts } from "~/lib/order/abandon-reaper.server";

// Suggested schedule: hourly, offset from the :00/:15/:30/:45 crowd — `20 * * * *`.
//
// Cancels `orders` rows still checkout_pending more than 24h after creation (across every
// shop), voiding their Stripe PaymentIntent first so a stale client_secret can never be
// confirmed after the order is cancelled. See abandon-reaper.server.ts for the full rationale.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return json(await reapAbandonedCheckouts());
};
