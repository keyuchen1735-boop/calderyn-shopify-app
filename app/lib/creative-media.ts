// app/lib/creative-media.ts
// Client-side processing for the predictor's mandatory creative drop box,
// shared by the extension screener and the dashboard Predictor.
//
// Images are downscaled to a ≤MAX_DIM WebP data URL (same canvas approach as
// app/components/dashboard/image-slot.tsx) so the form post and the persisted
// creative_input stay small. Videos never leave the browser: we extract
// VIDEO_FRAME_POSITIONS key frames as data URLs and ship those — Claude scores
// frames, not the file, and the payload stays far under the 4.5MB function
// body limit. Browser-only APIs are confined to function bodies so the module
// is import-safe under SSR.

export const ACCEPTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
];
// MOV is accepted optimistically: H.264 .mov decodes in every major browser,
// HEVC .mov fails decode in some — that surfaces as the undecodable error.
export const ACCEPTED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];
export const MEDIA_ACCEPT = [...ACCEPTED_IMAGE_TYPES, ...ACCEPTED_VIDEO_TYPES].join(",");

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

// 2× a ~600px preview, retina-sharp; a 1280px WebP at q=0.85 is ~150–300KB.
const MAX_DIM = 1280;
const WEBP_QUALITY = 0.85;
// Hook frame, mid-story, late-story — as fractions of duration.
export const VIDEO_FRAME_POSITIONS = [0.02, 0.35, 0.7];
const DECODE_TIMEOUT_MS = 20_000;

export type ProcessedCreativeMedia =
  | { kind: "image"; imageUrl: string }
  | { kind: "video"; imageUrl: string; frameUrls: string[]; durationSec: number };

export function mediaKindForFile(mimeType: string): "image" | "video" | null {
  if (ACCEPTED_IMAGE_TYPES.includes(mimeType)) return "image";
  if (ACCEPTED_VIDEO_TYPES.includes(mimeType)) return "video";
  return null;
}

/** Seek targets for frame extraction. Pure for unit tests. */
export function frameTimestamps(durationSec: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0];
  const latest = Math.max(0, durationSec - 0.1);
  // Deduplicate (a sub-second clip collapses every position onto ~0) so we
  // never burn seeks — or scorer image slots — on identical frames.
  return [...new Set(VIDEO_FRAME_POSITIONS.map((p) => Math.min(durationSec * p, latest)))];
}

function scaleToFit(w: number, h: number): { w: number; h: number } {
  const scale = Math.min(1, MAX_DIM / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

function drawToDataUrl(source: CanvasImageSource, srcW: number, srcH: number): string {
  const { w, h } = scaleToFit(srcW, srcH);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't read that file — your browser blocked canvas access.");
  ctx.drawImage(source, 0, 0, w, h);
  return canvas.toDataURL("image/webp", WEBP_QUALITY);
}

async function processImage(file: File): Promise<ProcessedCreativeMedia> {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error("That image is over 20MB — export a smaller version and try again.");
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Couldn't read that image — use PNG, JPEG, WebP, or AVIF.");
  }
  try {
    return { kind: "image", imageUrl: drawToDataUrl(bitmap, bitmap.width, bitmap.height) };
  } finally {
    bitmap.close?.();
  }
}

/** Resolve on `okEvent`, reject on error/timeout — a stalled decode must not hang the form. */
function nextEvent(video: HTMLVideoElement, okEvent: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Reading the video timed out — try a shorter clip or MP4 (H.264)."));
    }, DECODE_TIMEOUT_MS);
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error("Couldn't read that video — use MP4 (H.264) or WebM."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(okEvent, onOk);
      video.removeEventListener("error", onErr);
    };
    video.addEventListener(okEvent, onOk);
    video.addEventListener("error", onErr);
  });
}

async function processVideo(file: File): Promise<ProcessedCreativeMedia> {
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error("That video is over 300MB — export a smaller version and try again.");
  }
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    const metadataReady = nextEvent(video, "loadedmetadata");
    video.src = objectUrl;
    await metadataReady;
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error("Couldn't read that video — use MP4 (H.264) or WebM.");
    }
    const durationSec = Number.isFinite(video.duration) ? video.duration : 0;
    const frameUrls: string[] = [];
    for (const t of frameTimestamps(durationSec)) {
      const seeked = nextEvent(video, "seeked");
      // Never seek to exactly 0: the element is already at 0 after load, and a
      // same-position seek may not fire 'seeked' (we'd stall until the timeout).
      video.currentTime = Math.max(t, 0.01);
      await seeked;
      frameUrls.push(drawToDataUrl(video, video.videoWidth, video.videoHeight));
    }
    return { kind: "video", imageUrl: frameUrls[0], frameUrls, durationSec };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

export async function processCreativeMedia(file: File): Promise<ProcessedCreativeMedia> {
  const kind = mediaKindForFile(file.type);
  if (kind === "image") return processImage(file);
  if (kind === "video") return processVideo(file);
  throw new Error("Drop an image (PNG, JPEG, WebP, AVIF) or a video (MP4, WebM, MOV).");
}
