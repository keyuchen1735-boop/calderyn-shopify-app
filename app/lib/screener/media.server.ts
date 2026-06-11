// app/lib/screener/media.server.ts
// Pure helpers for the mandatory creative-media contract, shared by the
// extension screener action (FormData) and the dashboard screener API (JSON).
import type { CreativeInput, MediaKind } from "./types";

// The drop box is mandatory on the manual path — the score is about the actual
// creative. Meta-sourced runs are exempt (the creative comes from the live ad).
export function validateCreativeMedia(input: CreativeInput): string | null {
  if (input.mediaKind === "image") {
    return input.imageUrl ? null : "Drop the ad's image before scoring.";
  }
  if (input.mediaKind === "video") {
    return (input.videoFrameUrls?.length ?? 0) > 0
      ? null
      : "We couldn't read frames from that video — re-add it and try again.";
  }
  return "Add the actual ad creative — drop its image or video in the box.";
}

/** Shape an untrusted JSON body (dashboard POST) into a CreativeInput. */
export function creativeInputFromJson(body: Record<string, unknown>): CreativeInput {
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const mediaKind = str("mediaKind");
  const videoFrameUrls = Array.isArray(body.videoFrameUrls)
    ? (body.videoFrameUrls as unknown[]).filter((f): f is string => typeof f === "string")
    : [];
  const duration = Number(body.videoDurationSec);
  return {
    imageUrl: str("imageUrl") || null,
    mediaKind:
      mediaKind === "image" || mediaKind === "video" ? (mediaKind as MediaKind) : null,
    videoFrameUrls,
    videoDurationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    headline: str("headline"),
    primaryText: str("primaryText"),
    cta: str("cta") || "SHOP_NOW",
    destinationUrl: str("destinationUrl"),
    audience: str("audience"),
  };
}
