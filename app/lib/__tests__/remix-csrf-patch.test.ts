// Guards the patch in patches/@remix-run+server-runtime+2.17.5.patch, which lets
// the dashboard's marketing-apex reverse proxy through Remix's built-in
// throwIfPotentialCSRFAttack. Loads the REAL (patched) runtime function by
// absolute path (its subpath isn't in the package exports map) and asserts the
// trust boundary: allowlisted origins pass, everything else still throws.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

const requireCjs = createRequire(import.meta.url);
const actionsPath = path.join(
  process.cwd(),
  "node_modules/@remix-run/server-runtime/dist/actions.js",
);
const { throwIfPotentialCSRFAttack } = requireCjs(actionsPath) as {
  throwIfPotentialCSRFAttack: (headers: Headers) => void;
};

const APEX = "https://calderyncompany.com";
const APP_HOST = "app.calderyncompany.com";

function headers(origin: string | null, xForwardedHost: string): Headers {
  const h = new Headers({ "x-forwarded-host": xForwardedHost });
  if (origin) h.set("origin", origin);
  return h;
}

describe("patched @remix-run/server-runtime throwIfPotentialCSRFAttack", () => {
  // Save/restore only the keys we touch so we never clobber the wider env of a
  // parallel test file (matters if the vitest pool is ever threads, not forks).
  const KEYS = ["DASHBOARD_PUBLIC_URL", "SHOPIFY_APP_URL", "DASHBOARD_ALLOWED_ORIGINS"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.DASHBOARD_PUBLIC_URL = APEX;
    process.env.SHOPIFY_APP_URL = `https://${APP_HOST}`;
    delete process.env.DASHBOARD_ALLOWED_ORIGINS;
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("does NOT throw for a trusted proxied apex POST (the production bug case)", () => {
    expect(() => throwIfPotentialCSRFAttack(headers(APEX, APP_HOST))).not.toThrow();
  });

  it("still throws for an untrusted cross-origin POST (CSRF protection intact)", () => {
    expect(() => throwIfPotentialCSRFAttack(headers("https://evil.example", APP_HOST))).toThrow();
  });

  it("passes a genuine same-origin request (no host mismatch)", () => {
    expect(() => throwIfPotentialCSRFAttack(headers(`https://${APP_HOST}`, APP_HOST))).not.toThrow();
  });

  it("honors DASHBOARD_ALLOWED_ORIGINS entries too", () => {
    delete process.env.DASHBOARD_PUBLIC_URL;
    delete process.env.SHOPIFY_APP_URL;
    process.env.DASHBOARD_ALLOWED_ORIGINS = `https://other.example, ${APEX}`;
    expect(() => throwIfPotentialCSRFAttack(headers(APEX, APP_HOST))).not.toThrow();
  });

  it("fails closed: throws for the apex when the allowlist env is empty", () => {
    delete process.env.DASHBOARD_PUBLIC_URL;
    delete process.env.SHOPIFY_APP_URL;
    expect(() => throwIfPotentialCSRFAttack(headers(APEX, APP_HOST))).toThrow();
  });
});
