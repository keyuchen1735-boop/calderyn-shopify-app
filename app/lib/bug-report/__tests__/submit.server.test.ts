import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { sendEmail } from "../../email/send.server";
import { submitBugReport } from "../submit.server";
import type { BugReportInput } from "../submit.server";

const inserted: Record<string, unknown>[] = [];
const uploads: { path: string; opts: unknown }[] = [];
let uploadError: { message: string } | null = null;

vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push(row);
        return Promise.resolve({ error: null });
      },
    }),
    storage: {
      from: () => ({
        upload: (path: string, _body: unknown, opts: unknown) => {
          uploads.push({ path, opts });
          return Promise.resolve({ data: uploadError ? null : { path }, error: uploadError });
        },
      }),
    },
  }),
  resolveShopId: vi.fn().mockResolvedValue("shop-uuid"),
}));

vi.mock("../../email/send.server", () => ({ sendEmail: vi.fn() }));

const baseInput = (): BugReportInput => ({
  shopDomain: "test.myshopify.com",
  surface: "app",
  reporterEmail: "merchant@store.com",
  description: "It broke",
  context: { screen: "/app/alerts", userAgent: "UA", submittedAt: "2026-06-14T00:00:00.000Z" },
  attachments: [
    { filename: "shot.png", contentType: "image/png", size: 3, bytes: new Uint8Array([65, 66, 67]) },
  ],
});

beforeEach(() => {
  inserted.length = 0;
  uploads.length = 0;
  uploadError = null;
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.DIGEST_FROM = "Calderyn <bugs@calderyn.com>";
  process.env.BUG_REPORT_TO = "a@x.com,b@x.com";
});

describe("submitBugReport", () => {
  it("uploads the screenshot, emails the team reply-to the merchant, and inserts a 'sent' row", async () => {
    (sendEmail as Mock).mockResolvedValue({ sent: true, id: "email_1" });
    const out = await submitBugReport(baseInput());

    expect(out.emailStatus).toBe("sent");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toMatch(/^test\.myshopify\.com\/[0-9a-f-]+\/0-shot\.png$/);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = (sendEmail as Mock).mock.calls[0][0];
    expect(arg.replyTo).toBe("merchant@store.com");
    expect(arg.to).toEqual(["a@x.com", "b@x.com"]);
    expect(arg.attachments[0]).toEqual({ filename: "shot.png", content: "QUJD", contentType: "image/png" });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      shop_id: "shop-uuid",
      shop_domain: "test.myshopify.com",
      reporter_email: "merchant@store.com",
      surface: "app",
      email_status: "sent",
      email_error: null,
    });
    expect((inserted[0].attachments as unknown[]).length).toBe(1);
  });

  it("still inserts a 'failed' row (with error) when the email send fails", async () => {
    (sendEmail as Mock).mockResolvedValue({ sent: false, error: "Resend 500" });
    const out = await submitBugReport(baseInput());
    expect(out.emailStatus).toBe("failed");
    expect(inserted[0]).toMatchObject({ email_status: "failed", email_error: "Resend 500" });
  });

  it("still emails (and records no stored attachment) when Storage upload fails", async () => {
    uploadError = { message: "bucket missing" };
    (sendEmail as Mock).mockResolvedValue({ sent: true, id: "e" });
    const out = await submitBugReport(baseInput());
    expect(out.emailStatus).toBe("sent");
    expect((sendEmail as Mock).mock.calls[0][0].attachments).toHaveLength(1);
    expect(inserted[0].attachments).toEqual([]);
  });

  it("does not call sendEmail when email is not configured, and records the failure", async () => {
    delete process.env.RESEND_API_KEY;
    const out = await submitBugReport(baseInput());
    expect(sendEmail).not.toHaveBeenCalled();
    expect(out.emailStatus).toBe("failed");
    expect(inserted[0].email_status).toBe("failed");
    expect(String(inserted[0].email_error)).toContain("RESEND_API_KEY");
  });
});
