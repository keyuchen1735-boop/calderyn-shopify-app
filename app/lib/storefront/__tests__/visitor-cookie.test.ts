// app/lib/storefront/__tests__/visitor-cookie.test.ts
import { describe, it, expect } from "vitest";
import { ensureVisitorSession, SESSION_IDLE_SEC } from "../visitor-cookie.server";

/** Turn Set-Cookie headers from a previous response into a Cookie request header. */
function cookieHeaderFrom(headers: Headers, names: string[]): string {
  const pairs: string[] = [];
  for (const sc of headers.getSetCookie()) {
    const first = sc.split(";")[0];
    if (names.some((n) => first.startsWith(`${n}=`))) pairs.push(first);
  }
  return pairs.join("; ");
}

function req(cookie?: string): Request {
  return new Request("https://x.example/storefront", {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

describe("ensureVisitorSession", () => {
  it("first visit: mints visitor + session, not returning, sets both cookies", async () => {
    const s = await ensureVisitorSession(req());
    expect(s.visitorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.isReturning).toBe(false);
    const setCookies = s.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith("cd_vid="))).toBe(true);
    expect(setCookies.some((c) => c.startsWith("cd_sid="))).toBe(true);
    // rolling session: sid carries the 30-min max-age
    const sid = setCookies.find((c) => c.startsWith("cd_sid="))!;
    expect(sid).toContain(`Max-Age=${SESSION_IDLE_SEC}`);
  });

  it("same session: ids stable, vid cookie not re-set, sid re-committed (rolling)", async () => {
    const first = await ensureVisitorSession(req());
    const cookie = cookieHeaderFrom(first.headers, ["cd_vid", "cd_sid"]);
    const second = await ensureVisitorSession(req(cookie));
    expect(second.visitorId).toBe(first.visitorId);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.isReturning).toBe(first.isReturning);
    const setCookies = second.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith("cd_vid="))).toBe(false);
    expect(setCookies.some((c) => c.startsWith("cd_sid="))).toBe(true);
  });

  it("expired session with surviving visitor cookie: new session marked returning", async () => {
    const first = await ensureVisitorSession(req());
    const vidOnly = cookieHeaderFrom(first.headers, ["cd_vid"]);
    const second = await ensureVisitorSession(req(vidOnly));
    expect(second.visitorId).toBe(first.visitorId);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.isReturning).toBe(true);
  });

  it("returning flag is frozen at session start (mid-session requests can't flip it)", async () => {
    const first = await ensureVisitorSession(req());
    const vidOnly = cookieHeaderFrom(first.headers, ["cd_vid"]);
    const returning = await ensureVisitorSession(req(vidOnly)); // returning session starts
    const both = cookieHeaderFrom(returning.headers, ["cd_sid"]) + "; " + vidOnly;
    const mid = await ensureVisitorSession(req(both));
    expect(mid.sessionId).toBe(returning.sessionId);
    expect(mid.isReturning).toBe(true);
  });
});
