import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { sendEmail } from "../../email/send.server";
import { submitContactMessage, type ContactInput } from "../submit.server";
import { validateContactInput, MAX_MESSAGE_CHARS } from "../validate";

vi.mock("../../email/send.server", () => ({ sendEmail: vi.fn() }));

const baseInput = (): ContactInput => ({
  shopDomain: "test.calderyn.com",
  senderEmail: "merchant@store.com",
  message: "Hello, quick question about payouts.",
  screen: "dashboard",
  userAgent: "UA",
  submittedAt: "2026-07-13T00:00:00.000Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.DIGEST_FROM = "Calderyn <team@calderyn.com>";
  process.env.CONTACT_TO = "a@x.com, b@x.com";
  delete process.env.DIGEST_CC;
});

describe("validateContactInput", () => {
  it("accepts a trimmed message and email", () => {
    const out = validateContactInput({ message: "  hi there  ", email: " me@shop.com " });
    expect(out).toEqual({ ok: true, value: { message: "hi there", senderEmail: "me@shop.com" } });
  });

  it.each([
    ["", "me@shop.com", "EMPTY_MESSAGE"],
    ["x".repeat(MAX_MESSAGE_CHARS + 1), "me@shop.com", "MESSAGE_TOO_LONG"],
    ["hi", "", "EMPTY_EMAIL"],
    ["hi", "not-an-email", "INVALID_EMAIL"],
    ["hi", "me,you@x.com", "INVALID_EMAIL"],
    ["hi", "me@x.com;you@x.com", "INVALID_EMAIL"],
    [42, "me@shop.com", "EMPTY_MESSAGE"],
  ])("rejects message=%j email=%j with %s", (message, email, code) => {
    const out = validateContactInput({ message, email });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe(code);
  });
});

describe("submitContactMessage", () => {
  it("emails every CONTACT_TO recipient with reply-to the merchant", async () => {
    (sendEmail as Mock).mockResolvedValue({ sent: true, id: "email_1" });
    const out = await submitContactMessage(baseInput());

    expect(out.sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const args = (sendEmail as Mock).mock.calls[0][0];
    expect(args.to).toEqual(["a@x.com", "b@x.com"]);
    expect(args.replyTo).toBe("merchant@store.com");
    expect(args.subject).toBe("Contact from test.calderyn.com");
    expect(args.text).toContain("Hello, quick question about payouts.");
    expect(args.text).toContain("Shop: test.calderyn.com");
  });

  it("falls back to DIGEST_TO + DIGEST_CC when CONTACT_TO is unset", async () => {
    delete process.env.CONTACT_TO;
    process.env.DIGEST_TO = "d@x.com";
    process.env.DIGEST_CC = "e@x.com,f@x.com";
    (sendEmail as Mock).mockResolvedValue({ sent: true, id: "email_2" });

    await submitContactMessage(baseInput());
    const args = (sendEmail as Mock).mock.calls[0][0];
    expect(args.to).toEqual(["d@x.com", "e@x.com", "f@x.com"]);
  });

  it("returns a not-configured error without calling Resend when env is missing", async () => {
    delete process.env.RESEND_API_KEY;
    const out = await submitContactMessage(baseInput());
    expect(out.sent).toBe(false);
    expect(out.error).toContain("RESEND_API_KEY");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("passes through a delivery failure", async () => {
    (sendEmail as Mock).mockResolvedValue({ sent: false, error: "Resend 500" });
    const out = await submitContactMessage(baseInput());
    expect(out).toEqual({ sent: false, error: "Resend 500" });
  });
});
