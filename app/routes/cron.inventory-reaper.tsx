import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/response.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { expireStaleReservations } from "~/lib/inventory/reaper.server";

// Suggested schedule: every 5 minutes — `*/5 * * * *`.
//
// Releases inventory holds whose TTL lapsed (abandoned checkouts) back to
// available, via the engine's releaseReservation (which reverses the reserved
// bump, marks the reservation released, and re-projects inventory_level_fact).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return json(await expireStaleReservations());
};
