// app/lib/contact/submit.server.ts
//
// Delivers a merchant contact-us message to the team inbox(es) with reply-to
// set to the merchant, so a plain email reply reaches them. Email is the only
// channel (no durable row), so a failed send is returned to the caller and
// surfaced to the merchant for retry rather than swallowed.
import { sendEmail, type DeliveryResult } from "../email/send.server";

export interface ContactInput {
  shopDomain: string;
  senderEmail: string;
  message: string;
  screen: string;
  userAgent: string;
  submittedAt: string;
}

function recipients(): { to: string[]; from?: string; apiKey?: string } {
  const explicit = (process.env.CONTACT_TO || "")
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

function emailText(input: ContactInput): string {
  return [
    input.message,
    "",
    "—",
    `Shop: ${input.shopDomain}`,
    `Reply to: ${input.senderEmail}`,
    `Screen: ${input.screen || "(unknown)"}`,
    `User agent: ${input.userAgent || "(unknown)"}`,
    `Submitted: ${input.submittedAt}`,
  ].join("\n");
}

export async function submitContactMessage(input: ContactInput): Promise<DeliveryResult> {
  const { to, from, apiKey } = recipients();
  if (!apiKey || !from || to.length === 0) {
    const missing = [
      !apiKey && "RESEND_API_KEY",
      !from && "DIGEST_FROM",
      to.length === 0 && "CONTACT_TO/DIGEST_TO",
    ]
      .filter(Boolean)
      .join(", ");
    return { sent: false, error: `email not configured (${missing})` };
  }
  return sendEmail({
    apiKey,
    from,
    to,
    replyTo: input.senderEmail,
    subject: `Contact from ${input.shopDomain}`,
    text: emailText(input),
  });
}
