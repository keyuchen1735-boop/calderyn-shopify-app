// app/lib/pilot-invite/origin.server.ts
// Absolute origin for building email-safe (absolute https) asset + link URLs.
export function appOrigin(request: Request): string {
  const base = process.env.PUBLIC_APP_URL ?? process.env.SHOPIFY_APP_URL ?? new URL(request.url).origin;
  return base.replace(/\/+$/, "");
}
