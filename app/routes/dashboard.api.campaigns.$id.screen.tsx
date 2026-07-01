// app/routes/dashboard.api.campaigns.$id.screen.tsx
// Dashboard mirror of dashboard.api.screener's POST, campaign-scoped. Drop-in
// "screen a new creative": JSON body → creativeInputFromJson → media + SSRF
// guards → executeScreen (persists a creative_screen_run). Campaign scoping
// rides on the destinationUrl UTM today (executeScreen has no campaignId arg);
// the persisted run folds into the blended score only once the creative exists
// as a Meta ad (Phase 3) — see phase note.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { executeScreen } from "~/lib/screener/orchestrate.server";
import { validateCreativeMedia, validateCreativeMediaUrls } from "~/lib/screener/media.server";
import {
  DEFAULT_SPEND_CENTS,
  MAX_SPEND_CENTS,
  MIN_SPEND_CENTS,
  type CreativeInput,
  type MediaKind,
} from "~/lib/screener/types";

// Pure parse helper — no server imports so Vite can include this export in the
// client manifest without pulling in media.server (rule: exported route
// functions must not reference *.server modules). validateCreativeMedia/Urls
// stay inside action only.
// NOTE: deliberate browser-safe mirror of creativeInputFromJson in
// media.server — duplicated to keep this exported parser server-import-free;
// debt to consolidate into a shared browser-safe shaper later.
function parseCreativeInputFromJson(body: Record<string, unknown>): CreativeInput {
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const mediaKind = str("mediaKind");
  const videoFrameUrls = Array.isArray(body.videoFrameUrls)
    ? (body.videoFrameUrls as unknown[]).filter((f): f is string => typeof f === "string")
    : [];
  const duration = Number(body.videoDurationSec);
  return {
    imageUrl: str("imageUrl") || null,
    mediaKind: mediaKind === "image" || mediaKind === "video" ? (mediaKind as MediaKind) : null,
    videoFrameUrls,
    videoDurationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    headline: str("headline"),
    primaryText: str("primaryText"),
    cta: str("cta") || "SHOP_NOW",
    destinationUrl: str("destinationUrl"),
    audience: str("audience"),
  };
}

export function parseScreenBody(body: Record<string, unknown>): {
  input: CreativeInput;
  assumedSpendCents: number;
} {
  const input = parseCreativeInputFromJson(body);
  const raw = Math.round(Number(body.assumedSpendCents));
  const assumedSpendCents = Number.isFinite(raw)
    ? Math.min(Math.max(raw, MIN_SPEND_CENTS), MAX_SPEND_CENTS)
    : DEFAULT_SPEND_CENTS;
  return { input, assumedSpendCents };
}

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  void params.id; // campaign-scoped path; scoping rides on destinationUrl UTM (phase note)

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }
  const { input, assumedSpendCents } = parseScreenBody(body);

  const mediaError = validateCreativeMedia(input);
  if (mediaError) return jsonError(422, "missing_creative_media", mediaError);
  const urlError = validateCreativeMediaUrls(input);
  if (urlError) return jsonError(422, "disallowed_media_url", urlError);

  return dashboardJson(async () => ({
    run: await executeScreen({ shop: session.shopId, input, assumedSpendCents }),
  }));
}
