// app/routes/app.campaigns.$campaignId.screen.tsx
// Action-only resource route at /app/campaigns/:campaignId/screen. Drop-in
// "screen a new creative" for the campaign: parse the manual form, enforce the
// mandatory-media + SSRF guards, run executeScreen (persists a creative_screen_run),
// and return the run.
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { executeScreen } from "~/lib/screener/orchestrate.server";
import { validateCreativeMedia, validateCreativeMediaUrls } from "~/lib/screener/media.server";
import {
  DEFAULT_SPEND_CENTS,
  MAX_SPEND_CENTS,
  MIN_SPEND_CENTS,
  type CreativeInput,
} from "~/lib/screener/types";

function clampSpend(raw: FormDataEntryValue | null): number {
  if (raw === null || String(raw).trim() === "") return DEFAULT_SPEND_CENTS;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_SPEND_CENTS;
  return Math.min(Math.max(n, MIN_SPEND_CENTS), MAX_SPEND_CENTS);
}

// PURE: FormData → { input, assumedSpendCents }. cta defaults SHOP_NOW; mediaKind
// only "image"|"video" else null; videoFrameUrls JSON-parsed (bad JSON → []).
export function parseCampaignScreenForm(form: FormData): {
  input: CreativeInput;
  assumedSpendCents: number;
} {
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const mediaKind = str("mediaKind");
  let videoFrameUrls: string[] = [];
  try {
    const parsed: unknown = JSON.parse(str("videoFrameUrls") || "[]");
    if (Array.isArray(parsed)) {
      videoFrameUrls = parsed.filter((f): f is string => typeof f === "string");
    }
  } catch {
    videoFrameUrls = [];
  }
  const duration = Number(str("videoDurationSec"));
  const input: CreativeInput = {
    imageUrl: str("imageUrl") || null,
    mediaKind: mediaKind === "image" || mediaKind === "video" ? mediaKind : null,
    videoFrameUrls,
    videoDurationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    headline: str("headline"),
    primaryText: str("primaryText"),
    cta: str("cta") || "SHOP_NOW",
    destinationUrl: str("destinationUrl"),
    audience: str("audience"),
  };
  return { input, assumedSpendCents: clampSpend(form.get("assumedSpendCents")) };
}

export type ScreenActionPayload =
  | { ok: true; run: Awaited<ReturnType<typeof executeScreen>> }
  | { ok: false; error: { code: string; message: string } };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const { input, assumedSpendCents } = parseCampaignScreenForm(form);

  const mediaError = validateCreativeMedia(input);
  if (mediaError) {
    return json<ScreenActionPayload>({ ok: false, error: { code: "MEDIA_REQUIRED", message: mediaError } });
  }
  const urlError = validateCreativeMediaUrls(input);
  if (urlError) {
    return json<ScreenActionPayload>({ ok: false, error: { code: "MEDIA_URL", message: urlError } });
  }
  const run = await executeScreen({ shop: session.shop, input, assumedSpendCents });
  return json<ScreenActionPayload>({ ok: true, run });
};
