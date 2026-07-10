// Carrier tracking URL resolution. Pure + dependency-free so both the shipping
// email (server) and the dashboard order detail (client) share one map. Unknown
// carriers return null and callers fall back to showing the raw number.

const TRACKING_URLS: Array<{ match: RegExp; url: (n: string) => string }> = [
  { match: /usps/i, url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}` },
  { match: /ups/i, url: (n) => `https://www.ups.com/track?tracknum=${n}` },
  { match: /fedex/i, url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
  { match: /dhl/i, url: (n) => `https://www.dhl.com/en/express/tracking.html?AWB=${n}` },
  { match: /canada\s*post/i, url: (n) => `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${n}` },
  { match: /royal\s*mail/i, url: (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${n}` },
  { match: /australia\s*post|auspost/i, url: (n) => `https://auspost.com.au/mypost/track/#/details/${n}` },
];

export function carrierTrackingUrl(
  carrier: string | null | undefined,
  trackingNumber: string | null | undefined,
): string | null {
  if (!carrier || !trackingNumber) return null;
  const number = trackingNumber.trim();
  // Guard the URL slot: tracking numbers are alphanumeric (with optional dashes);
  // anything else must not be interpolated into a link.
  if (!number || !/^[A-Za-z0-9-]{4,40}$/.test(number)) return null;
  const entry = TRACKING_URLS.find((e) => e.match.test(carrier));
  return entry ? entry.url(encodeURIComponent(number)) : null;
}
