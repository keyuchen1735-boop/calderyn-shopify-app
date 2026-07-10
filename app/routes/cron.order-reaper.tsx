import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { reapAbandonedCheckouts } from "~/lib/order/abandon-reaper.server";
import { autoSendRecoveryEmails } from "~/lib/order/recovery.server";

// Suggested schedule: hourly, offset from the :00/:15/:30/:45 crowd — `20 * * * *`.
//
// Cancels `orders` rows still checkout_pending more than 24h after creation (across every
// shop), voiding their Stripe PaymentIntent first so a stale client_secret can never be
// confirmed after the order is cancelled. See abandon-reaper.server.ts for the full rationale.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Give a stalled buyer their recovery window (a resume-link email, 4h-24h old) BEFORE the reap
  // sweep below cancels the order at 24h — running recovery after reaping would let the reaper
  // race the very orders recovery is meant to save. A failure in the recovery sweep must never
  // block the reap: they are independent phases, isolated in their own try/catch (rule 12).
  let recovery = { sent: 0, skipped: 0 };
  try {
    recovery = await autoSendRecoveryEmails();
  } catch (err) {
    console.error("[cron.order-reaper] auto-recovery sweep failed; continuing to reap:", err);
  }

  const reap = await reapAbandonedCheckouts();
  return json({ ...reap, recovery });
};
