import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as SessionMod from "../session.server";
import { loader as loginLoader } from "../../../routes/login";
import { loader as signinLoader } from "../../../routes/dashboard.signin";

// Post-OAuth connector callbacks land on deep links like
// /dashboard/campaigns?meta=connected. These tests pin the two halves that keep
// that destination alive across an auth bounce (missing/expired cookie on the
// landing host): the session guards must carry the full path+query into
// /login?return_to=, and the login/signin loaders must honour it when a live
// session already exists.

// Import-time requirement of the signin route's user-store dependency.
vi.hoisted(() => {
  process.env.PASSWORD_PEPPER ||= "test-pepper-that-is-at-least-32-chars!!";
  process.env.DASHBOARD_SESSION_PEPPER ||= "test-pepper-that-is-at-least-32-chars!!";
});

const { getSessionFromRequestMock } = vi.hoisted(() => ({
  getSessionFromRequestMock: vi.fn(async (..._a: unknown[]) => null as unknown),
}));

vi.mock("../session.server", async (importOriginal) => {
  const real = await importOriginal<typeof SessionMod>();
  return {
    ...real,
    getSessionFromRequest: (...a: Parameters<typeof real.getSessionFromRequest>) =>
      getSessionFromRequestMock(...a),
  };
});

const SESSION = {
  shopId: "shop-1",
  shopDomain: "s.example",
  userId: "user-1",
  sessionId: "sess-1",
  emailVerified: true,
  onboardedAt: "2026-01-01T00:00:00Z",
  accountCreatedAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  getSessionFromRequestMock.mockResolvedValue(null);
});

async function thrownRedirect(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    if (e instanceof Response) return e.headers.get("Location");
    throw e;
  }
}

describe("session guards carry the destination into /login", () => {
  // These need the REAL guards (the vi.mock above serves the route imports), so
  // pull them via importActual: a cookieless request then drives the genuine
  // no-session redirect path.
  const realSession = () => vi.importActual<typeof SessionMod>("../session.server");

  it("requireVerifiedSession preserves path + one-shot connect query", async () => {
    const { requireVerifiedSession } = await realSession();
    const loc = await thrownRedirect(
      requireVerifiedSession(
        new Request("https://calderyncompany.com/dashboard/campaigns?meta=connected"),
      ),
    );
    expect(loc).toBe(
      `/login?return_to=${encodeURIComponent("/dashboard/campaigns?meta=connected")}`,
    );
  });

  it("getSessionOrRedirect does the same", async () => {
    const { getSessionOrRedirect } = await realSession();
    const loc = await thrownRedirect(
      getSessionOrRedirect(
        new Request("https://calderyncompany.com/dashboard/settings/connectors"),
      ),
    );
    expect(loc).toBe(
      `/login?return_to=${encodeURIComponent("/dashboard/settings/connectors")}`,
    );
  });

  it("keeps the bare /login for the dashboard root (nothing worth returning to)", async () => {
    const { requireVerifiedSession } = await realSession();
    const loc = await thrownRedirect(
      requireVerifiedSession(new Request("https://calderyncompany.com/dashboard")),
    );
    expect(loc).toBe("/login");
  });
});

describe("login loader with a live session", () => {
  it("redirects to a validated return_to instead of the bare dashboard", async () => {
    getSessionFromRequestMock.mockResolvedValue(SESSION);
    const res = (await loginLoader({
      request: new Request(
        `https://app.calderyncompany.com/login?return_to=${encodeURIComponent(
          "/dashboard/campaigns?meta=connected",
        )}`,
      ),
      params: {},
      context: {},
    })) as Response;
    expect(res.headers.get("Location")).toBe("/dashboard/campaigns?meta=connected");
  });

  it("falls back to /dashboard on a hostile return_to", async () => {
    getSessionFromRequestMock.mockResolvedValue(SESSION);
    const res = (await loginLoader({
      request: new Request(
        "https://app.calderyncompany.com/login?return_to=https://evil.example/phish",
      ),
      params: {},
      context: {},
    })) as Response;
    expect(res.headers.get("Location")).toBe("/dashboard");
  });
});

describe("signin loader with a live session", () => {
  it("redirects to a validated return_to", async () => {
    getSessionFromRequestMock.mockResolvedValue(SESSION);
    const res = (await signinLoader({
      request: new Request(
        `https://app.calderyncompany.com/dashboard/signin?return_to=${encodeURIComponent(
          "/dashboard/settings/connectors",
        )}`,
      ),
      params: {},
      context: {},
    })) as Response;
    expect(res.headers.get("Location")).toBe("/dashboard/settings/connectors");
  });
});

