// Absolute public origin for a storefront request. Behind Vercel's proxy the tenant
// host arrives as x-forwarded-host; locally it is the plain Host header.
export function storefrontOrigin(request: Request): string {
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    new URL(request.url).host;
  const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  const proto = request.headers.get("x-forwarded-proto") ?? (isLocal ? "http" : "https");
  return `${proto}://${host}`;
}
