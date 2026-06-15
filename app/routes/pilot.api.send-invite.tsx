// app/routes/pilot.api.send-invite.tsx
// POST-only, bearer-protected. Suppress-check (fail closed) → validate → render → send → log.
import type { ActionFunctionArgs } from "@remix-run/node";
import { isAuthorizedBearer } from "~/lib/cron-auth.server";
import { parseInviteInput } from "~/lib/pilot-invite/validate";
import { isOptedOut, signUnsubToken } from "~/lib/pilot-invite/unsubscribe.server";
import { hasSuccessfulInvite, logInvite } from "~/lib/pilot-invite/invites.server";
import { renderPilotEmail } from "~/lib/pilot-invite/email.server";
import { sendEmail } from "~/lib/email/send.server";
import { appOrigin } from "~/lib/pilot-invite/origin.server";

function j(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  if (request.method !== "POST") return j({ sent: false, error: "method not allowed" }, 405);
  if (!isAuthorizedBearer(request.headers.get("Authorization"), process.env.PILOT_INVITE_SECRET)) {
    return j({ sent: false, error: "unauthorized" }, 401);
  }

  let body: unknown;
  try { body = await request.json(); } catch { return j({ sent: false, error: "body: invalid JSON" }, 400); }
  const parsed = parseInviteInput(body);
  if (!parsed.ok) return j({ sent: false, error: parsed.error }, 400);
  const { email, firstName, storeName, skipIfInvited } = parsed.value;

  const supp = await isOptedOut(email);
  if (supp.error) return j({ sent: false, error: `suppression check failed: ${supp.error}` }, 502); // fail closed
  if (supp.optedOut) return j({ sent: false, error: "recipient unsubscribed" }, 409);

  if (skipIfInvited) {
    const prior = await hasSuccessfulInvite(email);
    if (prior.error) return j({ sent: false, error: `invite check failed: ${prior.error}` }, 502);
    if (prior.invited) return j({ sent: false, alreadyInvited: true }, 200);
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.PILOT_FROM;
  if (!apiKey || !from) return j({ sent: false, error: `missing ${!apiKey ? "RESEND_API_KEY" : "PILOT_FROM"}` }, 500);

  const base = appOrigin(request);
  const token = await signUnsubToken(email);
  const unsubscribeUrl = `${base}/pilot/unsubscribe?token=${encodeURIComponent(token)}`;
  const { subject, html, text } = renderPilotEmail({ firstName, storeName, baseUrl: base, unsubscribeUrl });

  // No List-Unsubscribe header on purpose: Gmail reads it as a bulk-list signal and
  // routes the message to the Promotions tab. These are low-volume, founder-sent
  // invites to opted-in waitlist members, so the visible (tokened) footer unsubscribe
  // link is sufficient and the invite lands in the primary inbox.
  const delivery = await sendEmail({
    apiKey, from, to: email, subject, html, text,
  });

  const log = await logInvite({
    email, firstName, storeName,
    status: delivery.sent ? "sent" : "failed",
    resendId: delivery.id ?? null, error: delivery.error ?? null,
  });

  if (!delivery.sent) return j({ sent: false, error: delivery.error ?? "send failed" }, 502);
  if (!log.ok) return j({ sent: true, id: delivery.id, logWarning: log.error }, 200);
  return j({ sent: true, id: delivery.id }, 200);
}
