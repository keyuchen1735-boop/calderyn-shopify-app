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

// --- SSRF policy on remote-fetched media URLs ---------------------------
// imageUrl / videoFrameUrls reach external fetchers (Anthropic via a url image
// block in score.server.ts, Higgsfield's referenceImageUrl). The client uploads
// arrive as `data:` URLs we hand to the model inline, so those stay allowed; any
// remote URL must be https: to a non-private host. Meta-sourced runs are exempt
// (their creative comes from the live ad, not untrusted JSON) — this is only
// enforced on the dashboard/manual path.

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return true; // malformed → treat as unsafe
  const [a, b] = o;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a >= 224) return true; // multicast / reserved
  return false;
}

// Expand an IPv6 literal (lowercased, brackets + zone id already stripped) to its
// eight 16-bit groups, decoding any embedded dotted-IPv4 tail (e.g. ::ffff:127.0.0.1)
// into two hextets. Returns null when the literal isn't parseable.
function expandIpv6(host: string): number[] | null {
  let s = host;
  const v4 = /:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    s = s.slice(0, v4.index) + `:${hi}:${lo}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string) =>
    part === "" ? [] : part.split(":").map((g) => parseInt(g, 16));
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  const groups =
    halves.length === 2
      ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill(0), ...tail]
      : head;
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/%.*$/, ""); // drop any zone id
  const g = expandIpv6(h);
  if (!g) return true; // unparseable → treat as unsafe
  // loopback (::1) and unspecified (::)
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true;
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // Embedded IPv4: IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96),
  // NAT64 (64:ff9b::/96) — decode the low 32 bits and reuse the v4 policy.
  const mapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  const compat = g.slice(0, 6).every((x) => x === 0) && (g[6] !== 0 || g[7] > 1);
  if (mapped || nat64 || compat) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    return isPrivateIpv4(v4);
  }
  return false;
}

/**
 * URL policy for media that gets fetched by an external service. Allows inline
 * `data:` images (client-produced) and `https:` URLs to a public host; rejects
 * every other scheme and any private/reserved/loopback/link-local host.
 */
// Inline images are client-produced WebP/PNG/JPEG; cap the encoded length so a
// non-image or multi-hundred-MB data: payload can't slip through or amplify load.
const MAX_DATA_URL_LEN = 12_000_000; // ~12 MB encoded

export function isAllowedMediaUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "data:") {
    return url.length <= MAX_DATA_URL_LEN && /^data:image\//i.test(url);
  }
  if (parsed.protocol !== "https:") return false;

  // URL lowercases the host and keeps the brackets on IPv6 literals — strip them,
  // plus any single trailing dot (FQDN form like "localhost." / "127.0.0.1.").
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.includes(":")) return !isPrivateIpv6(host);
  return !isPrivateIpv4(host);
}

/**
 * Enforce the media URL policy across imageUrl + every videoFrameUrl. Returns an
 * error string (same convention as validateCreativeMedia) or null when clean.
 * Null/absent fields are ignored here — media presence is enforced by
 * validateCreativeMedia.
 */
export function validateCreativeMediaUrls(input: CreativeInput): string | null {
  if (input.imageUrl && !isAllowedMediaUrl(input.imageUrl)) {
    return "That image URL isn't allowed — use an uploaded image or an https link to a public host.";
  }
  for (const frame of input.videoFrameUrls ?? []) {
    if (!isAllowedMediaUrl(frame)) {
      return "One of the video frame URLs isn't allowed — use an uploaded video or https links to a public host.";
    }
  }
  return null;
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
