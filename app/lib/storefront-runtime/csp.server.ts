const NONCE_PATTERN = /^[A-Za-z0-9+/_=-]{8,160}$/;

export function isStorefrontDocumentPath(pathname: string): boolean {
  return /^\/storefront(?:\/|$)/.test(pathname) && !/^\/storefront\/api(?:\/|$)/.test(pathname);
}

export function isRuntime1StorefrontReadEnabled(value = process.env.STOREFRONT_RUNTIME_1_READ): boolean {
  return /^(?:1|true)$/i.test(value ?? "");
}

function directive(name: string, values: readonly string[]): string {
  return `${name} ${values.join(" ")}`;
}

export function buildStorefrontCsp(input: { nonce: string; checkout: boolean }): string {
  if (!NONCE_PATTERN.test(input.nonce)) throw new Error("Invalid storefront CSP nonce");
  const nonce = `'nonce-${input.nonce}'`;
  const stripeScript = input.checkout ? ["https://js.stripe.com"] : [];
  const stripeConnect = input.checkout ? ["https://api.stripe.com", "https://r.stripe.com"] : [];
  const stripeFrames = input.checkout ? ["https://js.stripe.com", "https://hooks.stripe.com"] : [];
  const stripeImages = input.checkout ? ["https://*.stripe.com"] : [];
  return [
    directive("default-src", ["'none'"]),
    directive("script-src", ["'self'", nonce, ...stripeScript]),
    directive("style-src", ["'self'", nonce]),
    directive("connect-src", ["'self'", ...stripeConnect]),
    directive("font-src", ["'self'"]),
    directive("img-src", ["'self'", "data:", "blob:", ...stripeImages]),
    directive("frame-src", input.checkout ? stripeFrames : ["'none'"]),
    directive("object-src", ["'none'"]),
    directive("worker-src", ["'none'"]),
    directive("form-action", ["'self'"]),
    directive("base-uri", ["'self'"]),
    directive("frame-ancestors", ["'none'"]),
    "upgrade-insecure-requests",
  ].join("; ") + ";";
}
