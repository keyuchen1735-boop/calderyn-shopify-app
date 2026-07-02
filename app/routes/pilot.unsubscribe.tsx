// app/routes/pilot.unsubscribe.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { escapeHtml } from "~/lib/pilot-invite/content";
import { recordOptOut, verifyUnsubToken } from "~/lib/pilot-invite/unsubscribe.server";

function page(title: string, bodyHtml: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>${title}</title></head>
<body style="margin:0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F4F5F8;color:#1D1D1F;">
<div style="max-width:480px;margin:80px auto;padding:32px;background:#fff;border-radius:18px;border:.5px solid rgba(0,0,0,.06);text-align:center;">
${bodyHtml}</div></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function tokenFrom(request: Request): string {
  return new URL(request.url).searchParams.get("token") ?? "";
}

export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  const email = await verifyUnsubToken(tokenFrom(request));
  if (!email) return page("Invalid link", "<p>This unsubscribe link is invalid or expired.</p>", 400);
  return page(
    "Unsubscribe",
    `<h1 style="font-size:20px;">Unsubscribe</h1>
     <p style="color:#6E6E73;">Stop pilot onboarding emails to ${escapeHtml(email)}?</p>
     <form method="post">
       <button type="submit" style="background:#24556E;color:#fff;border:0;border-radius:999px;padding:13px 22px;font-size:15px;font-weight:650;cursor:pointer;">Unsubscribe</button>
     </form>`,
  );
}

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  const email = await verifyUnsubToken(tokenFrom(request));
  if (!email) return page("Invalid link", "<p>This unsubscribe link is invalid or expired.</p>", 400);
  const res = await recordOptOut(email, "one-click");
  if (!res.ok) return page("Try again", `<p>Could not process right now. Please retry.</p>`, 502);
  return page("Unsubscribed", `<h1 style="font-size:20px;">You're unsubscribed</h1><p style="color:#6E6E73;">${escapeHtml(email)} won't receive further pilot emails.</p>`);
}
