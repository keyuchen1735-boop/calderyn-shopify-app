import { describe, expect, it, vi } from "vitest";
import {
  FETCH_TIMEOUT_MS,
  isPathAllowed,
  isPubliclyRoutableHttps,
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

describe("isPubliclyRoutableHttps", () => {
  it("allows a normal public https host", () => {
    expect(isPubliclyRoutableHttps("https://rival.example/")).toBe(true);
  });
  it("rejects localhost", () => {
    expect(isPubliclyRoutableHttps("https://localhost/")).toBe(false);
  });
  it("rejects IPv4 literals in private/reserved ranges", () => {
    expect(isPubliclyRoutableHttps("https://10.0.0.1/")).toBe(false);
    expect(isPubliclyRoutableHttps("https://172.16.0.5/")).toBe(false);
    expect(isPubliclyRoutableHttps("https://172.31.255.255/")).toBe(false);
    expect(isPubliclyRoutableHttps("https://192.168.1.1/")).toBe(false);
    expect(isPubliclyRoutableHttps("https://127.0.0.1/")).toBe(false);
    expect(isPubliclyRoutableHttps("https://169.254.169.254/")).toBe(false);
    expect(isPubliclyRoutableHttps("https://0.0.0.0/")).toBe(false);
  });
  it("rejects bracketed IPv6 literals of any kind", () => {
    expect(isPubliclyRoutableHttps("https://[::1]/")).toBe(false);
    expect(isPubliclyRoutableHttps("https://[2001:db8::1]/")).toBe(false);
  });
  it("rejects .internal and .local suffixed hosts", () => {
    expect(isPubliclyRoutableHttps("https://svc.internal/")).toBe(false);
    expect(isPubliclyRoutableHttps("https://printer.local/")).toBe(false);
  });
  it("rejects non-https protocols and invalid URLs", () => {
    expect(isPubliclyRoutableHttps("http://rival.example/")).toBe(false);
    expect(isPubliclyRoutableHttps("not-a-url")).toBe(false);
  });
});

describe("politeFetch SSRF guard", () => {
  it("blocks a private-target URL at entry without calling fetchImpl", async () => {
    const impl = vi.fn();
    const res = await politeFetch("https://10.0.0.1/", impl as unknown as typeof fetch);
    expect(res).toMatchObject({ ok: false, reason: "blocked_host" });
    expect(impl).not.toHaveBeenCalled();
  });
  it("blocks localhost and loopback IPv6 targets", async () => {
    const impl = vi.fn();
    const res1 = await politeFetch("https://localhost/", impl as unknown as typeof fetch);
    expect(res1).toMatchObject({ ok: false, reason: "blocked_host" });
    const res2 = await politeFetch("https://[::1]/", impl as unknown as typeof fetch);
    expect(res2).toMatchObject({ ok: false, reason: "blocked_host" });
    expect(impl).not.toHaveBeenCalled();
  });
});

describe("politeFetch redirect handling", () => {
  it("follows same-origin redirects (2 hops)", async () => {
    const impl = vi.fn(async (url: string) => {
      if (url === "https://rival.example/initial") {
        return new Response("redirecting", {
          status: 302,
          headers: { location: "https://rival.example/final" },
        });
      }
      if (url === "https://rival.example/final") {
        return htmlResponse("final body");
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const res = await politeFetch("https://rival.example/initial", impl as unknown as typeof fetch);
    expect(res).toMatchObject({ ok: true, status: 200, text: "final body" });
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it("rejects cross-origin redirects without fetching the foreign URL", async () => {
    const impl = vi.fn(async (url: string) => {
      if (url === "https://rival.example/") {
        return new Response("go away", {
          status: 301,
          headers: { location: "https://evil.example/hijack" },
        });
      }
      if (url === "https://evil.example/hijack") {
        throw new Error("should not fetch evil.example");
      }
      return htmlResponse("fallback");
    });
    const res = await politeFetch("https://rival.example/", impl as unknown as typeof fetch);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("cross_host_redirect");
    expect(impl).toHaveBeenCalledTimes(1); // never fetches evil.example
  });

  it("fails on 4+ same-origin hops", async () => {
    const impl = vi.fn(async (url: string) => {
      const match = url.match(/\d+/);
      const n = match ? parseInt(match[0]) : 0;
      const next = n + 1;
      if (next <= 5) {
        return new Response("", {
          status: 302,
          headers: { location: `https://rival.example/r${next}` },
        });
      }
      return htmlResponse("final");
    });
    const res = await politeFetch("https://rival.example/r1", impl as unknown as typeof fetch);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("too_many_redirects");
  });

  it("aborts a redirect chain that overruns the ~12s overall wall-clock cap", async () => {
    // Deterministic stand-in for real network latency: each hop advances a
    // mocked Date.now() by 5s (matching FETCH_TIMEOUT_MS), so a 3-hop chain
    // simulates ~15s of wall-clock time without any real sleeping.
    let now = 0;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const impl = vi.fn(async (url: string) => {
        now += FETCH_TIMEOUT_MS;
        const match = url.match(/\d+/);
        const n = match ? parseInt(match[0]) : 0;
        return new Response("", {
          status: 302,
          headers: { location: `https://rival.example/r${n + 1}` },
        });
      });
      const res = await politeFetch("https://rival.example/r1", impl as unknown as typeof fetch);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("timeout");
      // Cap enforced before a 4th hop could be attempted.
      expect(impl.mock.calls.length).toBeLessThan(4);
    } finally {
      dateSpy.mockRestore();
    }
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
  it("uses exact token match for CalderynRadar (not substring)", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: NotCalderynRadarBot\nDisallow: /allow-bot\n");
    // NotCalderynRadarBot should NOT match because it's not exactly "calderynradar"
    expect(isPathAllowed(rules, "/anything")).toBe(false); // uses * group instead
    expect(isPathAllowed(rules, "/allow-bot")).toBe(false); // NotCalderynRadarBot group is NOT chosen
  });
  it("handles mixed-case directives", () => {
    const rules = parseRobots("User-agent: *\nDISALLOW: /cart\nUser-Agent: Googlebot\n");
    expect(isPathAllowed(rules, "/cart")).toBe(false);
  });
  it("handles multiple user-agents in a single group", () => {
    const rules = parseRobots(
      "User-agent: Googlebot\nUser-agent: CalderynRadar\nDisallow: /private\nUser-agent: *\nDisallow: /\n");
    expect(isPathAllowed(rules, "/private")).toBe(false);
    expect(isPathAllowed(rules, "/public")).toBe(true); // CalderynRadar group is chosen
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
  it("treats cross-host-redirected robots.txt as unreachable (blocked)", async () => {
    const impl = vi.fn(async (url: string) => {
      if (url === "https://rival.example/robots.txt") {
        return new Response("", {
          status: 301,
          headers: { location: "https://cdn.example/robots.txt" },
        });
      }
      throw new Error(`should not fetch ${url}`);
    });
    const rules = await loadRobots("https://rival.example", impl as unknown as typeof fetch);
    // cross-host redirect → fail closed (unreachable)
    expect(isPathAllowed(rules, "/anything")).toBe(false);
  });
});
