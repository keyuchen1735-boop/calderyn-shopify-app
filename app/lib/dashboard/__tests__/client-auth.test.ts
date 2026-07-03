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

  beforeEach(() => {
    assign = vi.fn();
    vi.stubGlobal("location", {
      origin: "https://app.calderyncompany.com",
      assign,
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

  it("redirects to login when the assistant send returns 401", async () => {
    // sendAssistantMessage uses a raw fetch (not apiSend); the 401 re-auth
    // contract must hold for it too, not just the typed fetchers.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "unauthenticated" })));
    const { sendAssistantMessage } = await freshClient();

    await expect(sendAssistantMessage("hello", null)).rejects.toBeTruthy();
    expect(assign).toHaveBeenCalledWith("/login?error=session_expired");
  });
});
