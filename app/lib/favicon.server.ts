// Shared favicon response. Browsers request /favicon.ico (and some /favicon.png)
// on every top-level page (OAuth consent, dashboard login); with no route they
// 404 into the production error logs as recurring noise. Content-Type, not the
// file extension, decides how the browser treats it, so one SVG serves both.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#1a1a2e"/>
  <path d="M21.5 11.2a7 7 0 1 0 0 9.6" fill="none" stroke="#7ee0c3" stroke-width="3.2" stroke-linecap="round"/>
</svg>`;

export function faviconResponse(): Response {
  return new Response(FAVICON_SVG, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
