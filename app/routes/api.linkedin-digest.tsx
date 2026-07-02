// app/routes/api.linkedin-digest.tsx
//
// POST-only, bearer-protected. The Claude cloud routine "Daily LinkedIn Post
// Writer" reads the day's commits, writes the LinkedIn posts, then POSTs them
// here. This endpoint sends each one via Resend so the RESEND_API_KEY stays
// server-side (it lives only in Vercel env, never in the routine config).
//
// Auth: constant-time bearer against LINKEDIN_DIGEST_SECRET. Recipients are
// restricted to @calderyncompany.com (see validate.ts) so a leaked secret can't
// turn this into an open relay. Never throws; returns a per-email result array
// so a partial delivery failure is visible rather than swallowed (rule 12).
import type { ActionFunctionArgs } from "react-router";
import { isAuthorizedBearer } from "~/lib/cron-auth.server";
import { parseDigestInput } from "~/lib/linkedin-digest/validate";
import { sendEmail } from "~/lib/email/send.server";

function j(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface SendResult {
  to: string;
  sent: boolean;
  id?: string;
  error?: string;
}

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  if (request.method !== "POST") return j({ sent: false, error: "method not allowed" }, 405);
  if (!isAuthorizedBearer(request.headers.get("Authorization"), process.env.LINKEDIN_DIGEST_SECRET)) {
    return j({ sent: false, error: "unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return j({ sent: false, error: "body: invalid JSON" }, 400);
  }
  const parsed = parseDigestInput(body);
  if (!parsed.ok) return j({ sent: false, error: parsed.error }, 400);

  const apiKey = process.env.RESEND_API_KEY;
  // `||` not `??`: a blank ("") env var (common Vercel misconfig) should also fall
  // through to PILOT_FROM rather than being treated as a configured value.
  const from = process.env.DIGEST_FROM || process.env.PILOT_FROM;
  if (!apiKey || !from) return j({ sent: false, error: `missing ${!apiKey ? "RESEND_API_KEY" : "DIGEST_FROM/PILOT_FROM"}` }, 500);

  const results: SendResult[] = [];
  for (const e of parsed.value.emails) {
    const delivery = await sendEmail({ apiKey, from, to: e.to, subject: e.subject, text: e.text });
    results.push({ to: e.to, sent: delivery.sent, id: delivery.id, error: delivery.error });
  }

  const sentCount = results.filter((r) => r.sent).length;
  // 502 only when nothing got through; a partial success still returns 200 with
  // the per-email breakdown so the caller can see which address failed.
  const status = sentCount === 0 ? 502 : 200;
  return j({ sent: sentCount === results.length, sentCount, total: results.length, results }, status);
}
