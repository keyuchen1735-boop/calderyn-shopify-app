import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notifyAutonomousAction } from "../notify-autonomous.server";

// Use vi.hoisted so the factory is available before vi.mock is evaluated.
const { sendEmailMock } = vi.hoisted(() => {
  const sendEmailMock = vi.fn(async (_opts: unknown) => ({ sent: true, id: "email-123" }));
  return { sendEmailMock };
});
vi.mock("../../email/send.server", () => ({ sendEmail: sendEmailMock }));

const SHOP = "00000000-0000-0000-0000-000000000042";
const EMAIL = "merchant@example.com";

/** Type-safe accessor for the first sendEmail call's first argument. */
function firstCallArg(): Record<string, unknown> {
  const arg = sendEmailMock.mock.calls[0]?.[0];
  return (arg ?? {}) as Record<string, unknown>;
}

describe("notifyAutonomousAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fires sendEmail when RESEND_API_KEY is set and email is provided", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    await notifyAutonomousAction(
      { shopId: SHOP, actionDescription: "Paused campaign Summer Sale" },
      EMAIL,
    );
    expect(sendEmailMock).toHaveBeenCalledOnce();
    const arg = firstCallArg();
    expect(arg["to"]).toBe(EMAIL);
    expect(String(arg["subject"] ?? "")).toContain("Paused campaign Summer Sale");
    expect(String(arg["text"] ?? "")).toContain("48 hours");
    expect(String(arg["html"] ?? "")).toContain("48 hours");
  });

  it("does NOT fire sendEmail when RESEND_API_KEY is absent", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    await notifyAutonomousAction(
      { shopId: SHOP, actionDescription: "Paused campaign" },
      EMAIL,
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("does NOT fire sendEmail when merchant email is null", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    await notifyAutonomousAction(
      { shopId: SHOP, actionDescription: "Paused campaign" },
      null,
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("does NOT fire sendEmail when merchant email is undefined", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    await notifyAutonomousAction(
      { shopId: SHOP, actionDescription: "Paused campaign" },
      undefined,
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("does not throw when sendEmail returns a delivery failure", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    sendEmailMock.mockResolvedValueOnce({ sent: false, error: "Resend 503 Service Unavailable" } as never);
    // Must not throw — a delivery failure is logged but never rethrown (rule 12).
    await expect(
      notifyAutonomousAction(
        { shopId: SHOP, actionDescription: "Reduced budget for campaign" },
        EMAIL,
      ),
    ).resolves.toBeUndefined();
  });

  it("does not throw when sendEmail itself throws", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    sendEmailMock.mockRejectedValueOnce(new Error("Network error"));
    // sendEmail is awaited inside notifyAutonomousAction; its error must be caught.
    await expect(
      notifyAutonomousAction(
        { shopId: SHOP, actionDescription: "Paused campaign" },
        EMAIL,
      ),
    ).resolves.toBeUndefined();
  });

  it("includes the shop name in the subject when provided", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    await notifyAutonomousAction(
      { shopId: SHOP, shopName: "Acme Store", actionDescription: "Paused campaign Summer" },
      EMAIL,
    );
    const subject = String(firstCallArg()["subject"] ?? "");
    expect(subject).toContain("Acme Store");
  });
});
