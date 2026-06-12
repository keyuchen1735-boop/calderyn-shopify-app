// GET → the shop's latest creative screen run; POST (JSON creative payload,
// mandatory media) → live executeScreen run. The dashboard Predictor's live
// scoring path — mirrors the extension screener's manual submit.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { executeScreen } from "~/lib/screener/orchestrate.server";
import { getLatestRun } from "~/lib/screener/runs.server";
import {
  creativeInputFromJson,
  validateCreativeMedia,
  validateCreativeMediaUrls,
} from "~/lib/screener/media.server";
import {
  DEFAULT_SPEND_CENTS,
  MAX_SPEND_CENTS,
  MIN_SPEND_CENTS,
} from "~/lib/screener/types";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({ latest: await getLatestRun(session.shopDomain) }));
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }

  const input = creativeInputFromJson(body);
  const mediaError = validateCreativeMedia(input);
  if (mediaError) return jsonError(422, "missing_creative_media", mediaError);

  const urlError = validateCreativeMediaUrls(input);
  if (urlError) return jsonError(422, "disallowed_media_url", urlError);

  const spendRaw = Math.round(Number(body.assumedSpendCents));
  const assumedSpendCents = Number.isFinite(spendRaw)
    ? Math.min(Math.max(spendRaw, MIN_SPEND_CENTS), MAX_SPEND_CENTS)
    : DEFAULT_SPEND_CENTS;

  return dashboardJson(async () => ({
    run: await executeScreen({ shop: session.shopDomain, input, assumedSpendCents }),
  }));
}
