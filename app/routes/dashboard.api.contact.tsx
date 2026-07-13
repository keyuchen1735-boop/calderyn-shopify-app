// app/routes/dashboard.api.contact.tsx
// POST JSON { message, email, screen } -> emails the team with reply-to set to
// the merchant. Dashboard cookie auth + same-origin CSRF guard, mirroring
// dashboard.api.bug-report.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { jsonError, jsonOk, rateLimit, requireSameOrigin } from "~/lib/dashboard/http.server";
import { validateContactInput } from "~/lib/contact/validate";
import { submitContactMessage } from "~/lib/contact/submit.server";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(422, "invalid_json");
  }
  const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  // Validate BEFORE consuming rate-limit quota, so a typo'd email retried a few
  // times can't lock the merchant out of ever sending the corrected message.
  const validated = validateContactInput({ message: raw.message, email: raw.email });
  if (!validated.ok) return jsonError(422, validated.code.toLowerCase(), validated.message);

  // One outbound email per submit; cap per shop to blunt inbox spam.
  if (!(await rateLimit(`contact:${session.shopId}`, 5, 15 * 60_000))) {
    return jsonError(429, "rate_limited", "Too many messages. Please wait a few minutes.");
  }

  // Collapse whitespace in free-form context strings: they land on single lines
  // of the email footer, so embedded newlines must not forge extra footer rows.
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  const result = await submitContactMessage({
    shopDomain: session.shopDomain ?? session.shopId,
    senderEmail: validated.value.senderEmail,
    message: validated.value.message,
    screen: typeof raw.screen === "string" ? oneLine(raw.screen).slice(0, 200) : "",
    userAgent: oneLine(request.headers.get("user-agent") ?? "").slice(0, 400),
    submittedAt: new Date().toISOString(),
  });
  if (!result.sent) {
    // No durable copy exists, so the merchant must know the send failed.
    console.error("[contact] send failed", result.error);
    return jsonError(502, "send_failed", "We couldn't send your message. Please try again.");
  }
  return jsonOk({ ok: true });
}
