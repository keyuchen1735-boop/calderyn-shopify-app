// D1 server-side belt-and-suspenders (designer-flagship spec): a store command
// arriving for a shop whose designer engine is on must never run the classic
// pipeline — the merchant gets an explicit "reload to open the designer"
// answer instead of a misleading classic rejection. Routing check only; the
// classic dispatch itself is untouched.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { action } from "../dashboard.api.store";

const { requireDashboardSession, getStoreSettings, runStoreCommand, rateLimit } = vi.hoisted(() => ({
  requireDashboardSession: vi.fn(),
  getStoreSettings: vi.fn(),
  runStoreCommand: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession }));
vi.mock("~/lib/storefront/settings.server", () => ({ getStoreSettings }));
vi.mock("~/lib/storebuilder/studio.server", () => ({ loadStudioState: vi.fn() }));
vi.mock("~/lib/storefront-command/command.server", () => ({
  runStoreCommand,
  StoreCommandError: class StoreCommandError extends Error {},
}));
vi.mock("~/lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/dashboard/http.server")>()),
  rateLimit,
}));

const SHOP = "00000000-0000-0000-0000-000000000010";
const ORIGIN = "https://app.example.test";

function request(body: unknown): Request {
  return new Request(`${ORIGIN}/dashboard/api/store`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

const PROMPT_COMMAND = { kind: "prompt", prompt: "Make my store beautiful", expectedDraftVersionId: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SHOPIFY_APP_URL", ORIGIN);
  requireDashboardSession.mockResolvedValue({ shopId: SHOP, userId: "u1" });
  getStoreSettings.mockResolvedValue({ composerEnabled: false });
  rateLimit.mockResolvedValue(true);
  runStoreCommand.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("dashboard.api.store designer routing guard", () => {
  it("answers a designer-enabled shop with the explicit reload message, never the classic pipeline", async () => {
    getStoreSettings.mockResolvedValue({ composerEnabled: true });
    const res = await action({ request: request(PROMPT_COMMAND), params: {}, context: {} } as never);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("designer_enabled");
    expect(body.message).toBe("The designer is on for this store — reload the Store screen to open it.");
    expect(runStoreCommand).not.toHaveBeenCalled();
  });

  it("runs the classic pipeline as before when the designer is off", async () => {
    const res = await action({ request: request(PROMPT_COMMAND), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    // Drain the NDJSON stream so the command actually executes.
    await res.text();
    expect(getStoreSettings).toHaveBeenCalledWith(SHOP);
    expect(runStoreCommand).toHaveBeenCalledTimes(1);
    expect(runStoreCommand.mock.calls[0][0]).toMatchObject({ shopId: SHOP });
  });

  it("fails open when the settings lookup itself breaks (classic shops keep working)", async () => {
    getStoreSettings.mockRejectedValue(new Error("db blip"));
    const res = await action({ request: request(PROMPT_COMMAND), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    await res.text();
    expect(runStoreCommand).toHaveBeenCalledTimes(1);
  });
});
