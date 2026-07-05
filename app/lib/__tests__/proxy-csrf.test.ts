import { describe, it, expect } from "vitest";
import { parseAllowedOrigins, forwardedHostFix } from "../proxy-csrf";

// Oracle: a faithful copy of @remix-run/server-runtime's throwIfPotentialCSRFAttack
// (v2.17.5, dist/actions.js). The middleware exists solely to stop this from
// firing on trusted proxied posts, so the test asserts against the real logic
// rather than a restatement of our own function.
function remixWouldReject(headers: Headers): boolean {
  const originHeader = headers.get("origin");
  const originDomain =
    typeof originHeader === "string" && originHeader !== "null"
      ? new URL(originHeader).host
      : originHeader;
  const fwd = headers.get("x-forwarded-host");
  const fwdValue = fwd?.split(",")[0]?.trim();
  const hostHeader = headers.get("host");
  const host = fwdValue
    ? { type: "x-forwarded-host", value: fwdValue }
    : hostHeader
      ? { type: "host", value: hostHeader }
      : undefined;
  return Boolean(originDomain && (!host || originDomain !== host.value));
}

// Mimic exactly what middleware.ts does with forwardedHostFix's result.
function afterMiddleware(method: string, headers: Headers, allowed: Set<string>): Headers {
  const fixHost = forwardedHostFix(method, headers, allowed);
  if (!fixHost) return headers;
  const next = new Headers(headers);
  next.set("x-forwarded-host", fixHost);
  return next;
}

const APEX = "https://calderyncompany.com";
const APP = "app.calderyncompany.com";
const allowed = parseAllowedOrigins([APEX, "https://app.calderyncompany.com"]);

function proxiedPost(): Headers {
  // A real new-user "name your store" POST arriving through the apex proxy.
  return new Headers({ origin: APEX, "x-forwarded-host": APP });
}

describe("proxy-csrf forwardedHostFix", () => {
  it("reproduces the bug: an untouched proxied apex POST trips Remix's check", () => {
    expect(remixWouldReject(proxiedPost())).toBe(true);
  });

  it("resolves it: after the middleware fix, Remix's check passes", () => {
    const fixed = afterMiddleware("POST", proxiedPost(), allowed);
    expect(remixWouldReject(fixed)).toBe(false);
    // The real host is preserved as the Origin for our own checkSameOrigin.
    expect(fixed.get("origin")).toBe(APEX);
  });

  it("does NOT rescue an untrusted cross-origin POST (real CSRF still blocked)", () => {
    const evil = new Headers({ origin: "https://evil.example", "x-forwarded-host": APP });
    expect(forwardedHostFix("POST", evil, allowed)).toBeNull();
    expect(remixWouldReject(afterMiddleware("POST", evil, allowed))).toBe(true);
  });

  it("no-ops for GET (Remix never checks it)", () => {
    expect(forwardedHostFix("GET", proxiedPost(), allowed)).toBeNull();
  });

  it("no-ops when Origin is absent", () => {
    const h = new Headers({ "x-forwarded-host": APP });
    expect(forwardedHostFix("POST", h, allowed)).toBeNull();
  });

  it("no-ops when Origin host already equals x-forwarded-host", () => {
    const h = new Headers({ origin: `https://${APP}`, "x-forwarded-host": APP });
    expect(forwardedHostFix("POST", h, allowed)).toBeNull();
  });

  it("parseAllowedOrigins splits comma lists and drops malformed entries", () => {
    const set = parseAllowedOrigins([`${APEX}, not a url`, undefined, "https://app.calderyncompany.com"]);
    expect(set.has(APEX)).toBe(true);
    expect(set.has("https://app.calderyncompany.com")).toBe(true);
    expect(set.size).toBe(2);
  });
});
