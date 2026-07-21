import { describe, expect, it, vi } from "vitest";
import {
  FETCH_TIMEOUT_MS,
  isPathAllowed,
  loadRobots,
  MAX_RESPONSE_BYTES,
  parseRobots,
  politeFetch,
  RADAR_USER_AGENT,
} from "../fetch.server";

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" }, ...init });
}

describe("politeFetch", () => {
  it("sends the honest UA and a 5s timeout signal", async () => {
    const impl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["user-agent"]).toBe(RADAR_USER_AGENT);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return htmlResponse("<html>ok</html>");
    });
    const res = await politeFetch("https://rival.example/", impl as unknown as typeof fetch);
    expect(res).toMatchObject({ ok: true, status: 200, text: "<html>ok</html>" });
    expect(RADAR_USER_AGENT).toBe("CalderynRadar/1.0 (+https://calderyncompany.com)");
    expect(FETCH_TIMEOUT_MS).toBe(5000);
  });
  it("rejects oversized responses via content-length without reading the body", async () => {
    const impl = vi.fn(async () =>
      htmlResponse("x", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }));
    const res = await politeFetch("https://rival.example/", impl as unknown as typeof fetch);
    expect(res.ok).toBe(false);
  });
  it("caps streamed bodies at ~1MB via the reader loop", async () => {
    const big = "a".repeat(MAX_RESPONSE_BYTES + 10);
    const impl = vi.fn(async () => new Response(big, { status: 200 }));
    const res = await politeFetch("https://rival.example/", impl as unknown as typeof fetch);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("large");
  });
  it("returns ok:false with the status for HTTP errors and ok:false for network errors", async () => {
    const notFound = vi.fn(async () => new Response("nope", { status: 404 }));
    const res404 = await politeFetch("https://rival.example/", notFound as unknown as typeof fetch);
    expect(res404).toMatchObject({ ok: false, status: 404 });
    const boom = vi.fn(async () => { throw new Error("socket hang up"); });
    const resErr = await politeFetch("https://rival.example/", boom as unknown as typeof fetch);
    expect(resErr.ok).toBe(false);
    if (!resErr.ok) expect(resErr.error).toContain("socket hang up");
  });
});

describe("parseRobots / isPathAllowed", () => {
  it("applies wildcard disallow rules by prefix", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /cart\nDisallow: /admin/\n");
    expect(isPathAllowed(rules, "/products/boots")).toBe(true);
    expect(isPathAllowed(rules, "/cart")).toBe(false);
    expect(isPathAllowed(rules, "/admin/settings")).toBe(false);
  });
  it("prefers a CalderynRadar-specific group over the wildcard", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: CalderynRadar\nDisallow: /private\n");
    expect(isPathAllowed(rules, "/products/boots")).toBe(true);
    expect(isPathAllowed(rules, "/private/notes")).toBe(false);
  });
  it("treats an empty Disallow as allow-all and ignores comments", () => {
    const rules = parseRobots("# hi\nUser-agent: *\nDisallow:\n");
    expect(isPathAllowed(rules, "/anything")).toBe(true);
  });
});

describe("loadRobots", () => {
  it("parses a 200 robots.txt fetched with the honest UA", async () => {
    const impl = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe("https://rival.example/robots.txt");
      return htmlResponse("User-agent: *\nDisallow: /cart\n");
    });
    const rules = await loadRobots("https://rival.example", impl as unknown as typeof fetch);
    expect(isPathAllowed(rules, "/cart")).toBe(false);
    expect(isPathAllowed(rules, "/")).toBe(true);
  });
  it("allows all on 404 (no robots file means no restrictions)", async () => {
    const impl = vi.fn(async () => new Response("nf", { status: 404 }));
    const rules = await loadRobots("https://rival.example", impl as unknown as typeof fetch);
    expect(isPathAllowed(rules, "/anything")).toBe(true);
  });
  it("disallows all for the night on 5xx or network failure (conservative)", async () => {
    const impl = vi.fn(async () => new Response("boom", { status: 503 }));
    const rules = await loadRobots("https://rival.example", impl as unknown as typeof fetch);
    expect(isPathAllowed(rules, "/")).toBe(false);
    const down = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const rules2 = await loadRobots("https://rival.example", down as unknown as typeof fetch);
    expect(isPathAllowed(rules2, "/")).toBe(false);
  });
});
