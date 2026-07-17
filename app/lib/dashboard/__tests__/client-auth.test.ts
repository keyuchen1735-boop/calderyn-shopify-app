// A 401 from any /dashboard/api/* call means the dashboard session is gone
// (expired, revoked, or never sent). The client must treat that as "go log in
// again" — not as a transient data error to toast or silently swallow. These
// tests lock that: a 401 navigates to the login page with the session-expired
// message (once, even under the live poller's parallel fan-out), while other
// failures keep throwing without navigating.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function freshClient() {
  // Reset module state so the "redirect only once" guard starts clean per test.
  vi.resetModules();
  return import("../client");
}

describe("dashboard client 401 handling", () => {
  let assign: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn>;
  let stored: Map<string, string>;

  beforeEach(() => {
    assign = vi.fn();
    reload = vi.fn();
    stored = new Map();
    vi.stubGlobal("location", {
      origin: "https://app.calderyncompany.com",
      assign,
      reload,
    });
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("redirects to /login with the session-expired message when a GET returns 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "unauthenticated" })));
    const { apiGet, DashboardApiError } = await freshClient();

    await expect(apiGet("/dashboard/api/overview")).rejects.toBeInstanceOf(DashboardApiError);
    expect(assign).toHaveBeenCalledWith("/login?error=session_expired");
  });

  it("redirects only once when several calls 401 together", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "unauthenticated" })));
    const { apiGet } = await freshClient();

    await Promise.allSettled([
      apiGet("/dashboard/api/overview"),
      apiGet("/dashboard/api/alerts"),
      apiGet("/dashboard/api/campaigns"),
    ]);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("does not redirect on a non-401 error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "server_error" })));
    const { apiGet, DashboardApiError } = await freshClient();

    await expect(apiGet("/dashboard/api/overview")).rejects.toBeInstanceOf(DashboardApiError);
    expect(assign).not.toHaveBeenCalled();
  });

  it("reloads once when an older deployment serves dashboard HTML to API calls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<!doctype html><title>Dashboard</title>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      ),
    );
    const { apiGet, DashboardApiError } = await freshClient();

    const results = await Promise.allSettled([
      apiGet("/dashboard/api/overview"),
      apiGet("/dashboard/api/alerts"),
    ]);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(results[0]).toMatchObject({
      reason: expect.objectContaining<Partial<InstanceType<typeof DashboardApiError>>>({
        code: "version_skew",
      }),
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not enter a reload loop when dashboard HTML survives navigation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<!doctype html><title>Dashboard</title>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      ),
    );
    let client = await freshClient();

    await expect(client.apiGet("/dashboard/api/overview")).rejects.toMatchObject({
      code: "version_skew",
    });
    client = await freshClient();
    await expect(client.apiGet("/dashboard/api/overview")).rejects.toMatchObject({
      code: "version_skew",
    });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the reload guard when an older supported API route succeeds", async () => {
    const html = new Response("<!doctype html><title>Dashboard</title>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    vi.stubGlobal("fetch", vi.fn(async () => html.clone()));
    let client = await freshClient();
    await expect(client.apiGet("/dashboard/api/new-route")).rejects.toMatchObject({
      code: "version_skew",
    });

    client = await freshClient();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { ok: true })));
    await expect(client.apiGet("/dashboard/api/old-route")).resolves.toEqual({ ok: true });
    vi.stubGlobal("fetch", vi.fn(async () => html.clone()));
    await expect(client.apiGet("/dashboard/api/new-route")).rejects.toMatchObject({
      code: "version_skew",
    });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps valid API responses working when session storage is unavailable", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      },
      removeItem: () => {
        throw new Error("storage unavailable");
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { ok: true })));
    const { apiGet } = await freshClient();

    await expect(apiGet("/dashboard/api/overview")).resolves.toEqual({ ok: true });
  });

  it("does not reload when a current API route fails with an HTML 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<!doctype html><title>Server error</title>", {
          status: 500,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      ),
    );
    const { apiGet, DashboardApiError } = await freshClient();

    await expect(apiGet("/dashboard/api/overview")).rejects.toBeInstanceOf(DashboardApiError);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads when a raw assistant request reaches an older dashboard route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<!doctype html><title>Dashboard</title>", {
          status: 405,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      ),
    );
    const { sendAssistantMessage } = await freshClient();

    await expect(sendAssistantMessage("hello", null)).rejects.toMatchObject({
      code: "version_skew",
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("redirects to login when the assistant send returns 401", async () => {
    // sendAssistantMessage uses a raw fetch (not apiSend); the 401 re-auth
    // contract must hold for it too, not just the typed fetchers.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "unauthenticated" })));
    const { sendAssistantMessage } = await freshClient();

    await expect(sendAssistantMessage("hello", null)).rejects.toBeTruthy();
    expect(assign).toHaveBeenCalledWith("/login?error=session_expired");
  });
});
