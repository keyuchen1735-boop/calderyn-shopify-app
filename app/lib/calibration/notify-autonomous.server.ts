// Notification sent when Calderyn's autopilot takes an autonomous action on a
// merchant's behalf (a graduated pair has executed without a per-action click).
// The merchant gets an email with the action summary + a reminder that they have
// 48 hours to undo. Fire-and-forget: a delivery failure is logged but MUST NOT
// fail or roll back the action that already landed on the platform (rule 12).

import { sendEmail } from "../email/send.server";

export interface AutonomousActionNotifyInput {
  shopId: string;
  shopName?: string | null;
  /** Human-readable action description, e.g. "Paused campaign 'Summer Sale'" */
  actionDescription: string;
  /** ISO-8601 timestamp of the action — used to compute the undo deadline. */
  actionTimestamp?: string;
}

/** Compute the undo deadline (48h from now or from actionTimestamp). */
function undoDeadlineLabel(actionTimestamp?: string): string {
  const base = actionTimestamp ? new Date(actionTimestamp) : new Date();
  const deadline = new Date(base.getTime() + 48 * 60 * 60 * 1000);
  return deadline.toUTCString();
}

/** Minimal text-only email body — no images, no HTML builder dependency. */
function buildEmail(input: AutonomousActionNotifyInput): { subject: string; text: string; html: string } {
  const store = input.shopName ?? "your store";
  const subject = `Calderyn acted for ${store}: ${input.actionDescription}`;
  const deadline = undoDeadlineLabel(input.actionTimestamp);
  const dashboardUrl = "https://app.calderyncompany.com/dashboard";

  const text = [
    `Calderyn took an autonomous action for ${store}:`,
    ``,
    `  ${input.actionDescription}`,
    ``,
    `You have 48 hours to undo this action (before ${deadline}).`,
    ``,
    `Review + undo in the dashboard: ${dashboardUrl}`,
    ``,
    `— The Calderyn autopilot`,
  ].join("\n");

  // Minimal inline-styled HTML — no external CSS, no images.
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#F4F5F7;padding:32px 16px;margin:0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;">
    <tr><td>
      <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#6B7280;">Autopilot Action</p>
      <h1 style="margin:0 0 20px;font-size:20px;font-weight:700;color:#1D1D1F;letter-spacing:-0.02em;">Calderyn acted for ${esc(store)}</h1>
      <div style="background:#F9FAFB;border-radius:8px;padding:16px;margin-bottom:20px;font-size:15px;color:#1D1D1F;">
        ${esc(input.actionDescription)}
      </div>
      <p style="margin:0 0 20px;font-size:14px;color:#4B5563;line-height:1.5;">
        You have <strong>48 hours</strong> to undo this action (before ${esc(deadline)}).
      </p>
      <a href="${dashboardUrl}" style="display:inline-block;background:#24556E;color:#fff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:8px;">
        Review &amp; Undo
      </a>
      <p style="margin:24px 0 0;font-size:12px;color:#9CA3AF;">— Calderyn autopilot</p>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

/**
 * Fire-and-forget notification to the merchant after a successful autonomous
 * action. A missing RESEND_API_KEY is silently skipped (not all envs have it);
 * a delivery failure is logged but never rethrown — the action already landed.
 *
 * @param merchantEmail  The recipient. If absent/empty the notification is a
 *                       no-op (some shops may not have a contact email yet).
 */
export async function notifyAutonomousAction(
  input: AutonomousActionNotifyInput,
  merchantEmail: string | null | undefined,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY ?? "";
  if (!apiKey) {
    console.info("[autopilot-notify] RESEND_API_KEY not set; skipping notification");
    return;
  }
  if (!merchantEmail) {
    console.info(`[autopilot-notify] no merchant email for shop ${input.shopId}; skipping notification`);
    return;
  }

  const { subject, text, html } = buildEmail(input);
  try {
    const result = await sendEmail({
      apiKey,
      from: "Calderyn <autopilot@calderyncompany.com>",
      to: merchantEmail,
      subject,
      text,
      html,
    });

    if (!result.sent) {
      console.error(
        `[autopilot-notify] delivery failed for shop ${input.shopId}: ${result.error ?? "unknown error"}`,
      );
    } else {
      console.info(`[autopilot-notify] notified ${merchantEmail} for shop ${input.shopId} (id=${result.id})`);
    }
  } catch (err) {
    // sendEmail never throws in production (catches internally), but guard defensively
    // so a mock or edge-case never propagates out and rolls back the already-landed action.
    console.error(`[autopilot-notify] unexpected error for shop ${input.shopId}:`, err);
  }
}
