import { describe, it, expect, beforeEach, vi } from "vitest";

const sendEmail = vi.fn();
const isOptedOut = vi.fn();
const hasSuccessfulInvite = vi.fn();
const logInvite = vi.fn().mockResolvedValue({ ok: true });
vi.mock("~/lib/email/send.server", () => ({ sendEmail }));
vi.mock("~/lib/pilot-invite/unsubscribe.server", () => ({ isOptedOut, signUnsubToken: async () => "tok" }));
vi.mock("~/lib/pilot-invite/invites.server", () => ({ hasSuccessfulInvite, logInvite }));

const POST = (body: unknown, auth = "Bearer s3cret") =>
  new Request("https://app.test/pilot/api/send-invite", {
    method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PILOT_INVITE_SECRET = "s3cret";
  process.env.RESEND_API_KEY = "re_x";
  process.env.PILOT_FROM = "Calderyn <onboarding@calderyncompany.com>";
  process.env.PUBLIC_APP_URL = "https://app.test";
  isOptedOut.mockResolvedValue({ optedOut: false });
  hasSuccessfulInvite.mockResolvedValue({ invited: false });
  sendEmail.mockResolvedValue({ sent: true, id: "email_1" });
});

describe("POST /pilot/api/send-invite", () => {
  it("401s without a valid bearer", async () => {
    const { action } = await import("../pilot.api.send-invite");
    const res = await action({ request: POST({ email: "a@b.co", first_name: "A", store_name: "B" }, "Bearer nope"), params: {}, context: {} });
    expect(res.status).toBe(401);
  });
  it("400s an invalid body", async () => {
    const { action } = await import("../pilot.api.send-invite");
    const res = await action({ request: POST({ email: "x" }), params: {}, context: {} });
    expect(res.status).toBe(400);
  });
  it("409s a suppressed recipient", async () => {
    isOptedOut.mockResolvedValue({ optedOut: true });
    const { action } = await import("../pilot.api.send-invite");
    const res = await action({ request: POST({ email: "a@b.co", first_name: "A", store_name: "B" }), params: {}, context: {} });
    expect(res.status).toBe(409);
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("fails closed (502) when the suppression check errors", async () => {
    isOptedOut.mockResolvedValue({ optedOut: false, error: "db down" });
    const { action } = await import("../pilot.api.send-invite");
    const res = await action({ request: POST({ email: "a@b.co", first_name: "A", store_name: "B" }), params: {}, context: {} });
    expect(res.status).toBe(502);
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("sends, logs, and returns the resend id", async () => {
    const { action } = await import("../pilot.api.send-invite");
    const res = await action({ request: POST({ email: "a@b.co", first_name: "A", store_name: "B" }), params: {}, context: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, id: "email_1" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = sendEmail.mock.calls[0][0];
    // One-click List-Unsubscribe (RFC 8058) — Gmail's bulk-sender requirement; points at the tokened unsub URL.
    expect(arg.headers).toEqual({
      "List-Unsubscribe": "<https://app.test/pilot/unsubscribe?token=tok>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(logInvite).toHaveBeenCalledWith(expect.objectContaining({ status: "sent", resendId: "email_1" }));
  });
  it("short-circuits with alreadyInvited when skip_if_invited and a prior send exists", async () => {
    hasSuccessfulInvite.mockResolvedValue({ invited: true });
    const { action } = await import("../pilot.api.send-invite");
    const res = await action({ request: POST({ email: "a@b.co", first_name: "A", store_name: "B", skip_if_invited: true }), params: {}, context: {} });
    expect(await res.json()).toEqual({ sent: false, alreadyInvited: true });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
