// app/lib/bug-report/submit.server.ts
//
// The shared "brain" for a bug report. parseBugReportForm normalizes a multipart
// FormData (both surfaces post identical fields) into a validated input;
// submitBugReport uploads screenshots (best-effort), emails the team (reply-to the
// merchant), and persists the row with the real delivery status. It never throws
// on email/storage failure — the report is the priority.
import { getSupabase, resolveShopId } from "../supabase.server";
import { sendEmail, type EmailAttachment } from "../email/send.server";
import { validateBugReportInput, type AttachmentMeta } from "./validate";

export const BUG_REPORT_BUCKET = "bug-reports";

export interface BugReportContext {
  screen: string;
  userAgent: string;
  submittedAt: string;
}

export interface ParsedAttachment extends AttachmentMeta {
  bytes: Uint8Array;
}

export interface BugReportInput {
  shopDomain: string;
  surface: "app" | "dashboard";
  reporterEmail: string;
  description: string;
  context: BugReportContext;
  attachments: ParsedAttachment[];
}

export type ParseResult =
  | { ok: true; value: BugReportInput }
  | { ok: false; code: string; message: string };

export async function parseBugReportForm(
  form: FormData,
  opts: { shopDomain: string; surface: "app" | "dashboard"; userAgent: string },
): Promise<ParseResult> {
  const files = form
    .getAll("screenshots")
    .filter((f): f is File => f instanceof File && f.size > 0);

  // Validate against count/size/type limits using File metadata BEFORE reading any
  // bytes, so an oversized or over-count submission is rejected without buffering it.
  const validated = validateBugReportInput({
    description: form.get("description"),
    email: form.get("email"),
    attachments: files.map((f) => ({ filename: f.name, contentType: f.type, size: f.size })),
  });
  if (!validated.ok) return validated;

  const attachments: ParsedAttachment[] = [];
  for (const f of files) {
    attachments.push({
      filename: f.name,
      contentType: f.type,
      size: f.size,
      bytes: new Uint8Array(await f.arrayBuffer()),
    });
  }

  const screenRaw = form.get("screen");
  return {
    ok: true,
    value: {
      shopDomain: opts.shopDomain,
      surface: opts.surface,
      reporterEmail: validated.value.reporterEmail,
      description: validated.value.description,
      context: {
        screen: typeof screenRaw === "string" ? screenRaw.slice(0, 200) : "",
        userAgent: opts.userAgent.slice(0, 400),
        submittedAt: new Date().toISOString(),
      },
      attachments,
    },
  };
}

function recipients(): { to: string[]; from?: string; apiKey?: string } {
  const explicit = (process.env.BUG_REPORT_TO || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fallback = [process.env.DIGEST_TO, ...(process.env.DIGEST_CC || "").split(",")]
    .map((s) => (s || "").trim())
    .filter(Boolean);
  return {
    to: explicit.length ? explicit : fallback,
    from: process.env.DIGEST_FROM,
    apiKey: process.env.RESEND_API_KEY,
  };
}

function safeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (cleaned.length <= 80) return cleaned || "image";
  const ext = cleaned.match(/\.[^.]+$/)?.[0] ?? "";
  return (cleaned.slice(0, 80 - ext.length) + ext) || "image";
}

function emailText(input: BugReportInput): string {
  return [
    input.description,
    "",
    "—",
    `Shop: ${input.shopDomain}`,
    `Surface: ${input.surface}`,
    `Screen: ${input.context.screen || "(unknown)"}`,
    `Reply to: ${input.reporterEmail}`,
    `User agent: ${input.context.userAgent || "(unknown)"}`,
    `Submitted: ${input.context.submittedAt}`,
  ].join("\n");
}

export interface SubmitResult {
  id: string;
  emailStatus: "sent" | "failed";
}

export async function submitBugReport(input: BugReportInput): Promise<SubmitResult> {
  const sb = getSupabase();
  const reportId = crypto.randomUUID();

  // 1. Screenshots: always attach the in-memory bytes to the email; best-effort
  //    persist a durable copy to the private Storage bucket.
  const emailAttachments: EmailAttachment[] = [];
  const stored: Array<{ path: string; filename: string; content_type: string; size_bytes: number }> = [];
  for (let i = 0; i < input.attachments.length; i++) {
    const a = input.attachments[i];
    emailAttachments.push({
      filename: a.filename,
      content: Buffer.from(a.bytes).toString("base64"),
      contentType: a.contentType,
    });
    const path = `${input.shopDomain}/${reportId}/${i}-${safeName(a.filename)}`;
    try {
      const { error } = await sb.storage
        .from(BUG_REPORT_BUCKET)
        .upload(path, a.bytes, { contentType: a.contentType, upsert: false });
      if (error) {
        console.error("[bug-report] storage upload failed", error.message);
      } else {
        stored.push({ path, filename: a.filename, content_type: a.contentType, size_bytes: a.size });
      }
    } catch (err) {
      console.error("[bug-report] storage upload threw", err);
    }
  }

  // 2. Email the team. sendEmail never throws.
  const { to, from, apiKey } = recipients();
  let delivery: { sent: boolean; error?: string };
  if (!apiKey || !from || to.length === 0) {
    const missing = [
      !apiKey && "RESEND_API_KEY",
      !from && "DIGEST_FROM",
      to.length === 0 && "BUG_REPORT_TO/DIGEST_TO",
    ]
      .filter(Boolean)
      .join(", ");
    delivery = { sent: false, error: `email not configured (${missing})` };
  } else {
    delivery = await sendEmail({
      apiKey,
      from,
      to,
      replyTo: input.reporterEmail,
      subject: `Bug report from ${input.shopDomain}`,
      text: emailText(input),
      attachments: emailAttachments,
    });
  }

  // 3. Persist with the true delivery status. Never throw: the email is the
  //    primary channel, so a shop-resolution or insert failure must not surface
  //    as an error after the report was already emailed — just log it.
  try {
    const shopId = await resolveShopId(input.shopDomain);
    const { error: insertError } = await sb.from("bug_report").insert({
      id: reportId,
      shop_id: shopId,
      shop_domain: input.shopDomain,
      reporter_email: input.reporterEmail,
      description: input.description,
      surface: input.surface,
      context: input.context,
      attachments: stored,
      email_status: delivery.sent ? "sent" : "failed",
      email_error: delivery.sent ? null : delivery.error ?? "unknown",
    });
    if (insertError) {
      console.error("[bug-report] row insert failed", insertError.message);
    }
  } catch (err) {
    console.error("[bug-report] persist failed", err);
  }

  return { id: reportId, emailStatus: delivery.sent ? "sent" : "failed" };
}
