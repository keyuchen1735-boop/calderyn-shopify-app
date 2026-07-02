import type { LoaderFunctionArgs } from "react-router";

/**
 * Standalone OAuth result page for the onboarding NEW-TAB connect flow.
 *
 * The provider callbacks (auth.google/meta/tiktok/quickbooks) redirect here with
 * `?provider=<label>&status=connected|error[&reason=...]` WHEN the connect was
 * started from the onboarding wizard's new tab (state carried popup=true). That
 * tab is a bare top-level browsing context — it has no App Bridge host/session,
 * so an embedded-admin deep link can't render. This is a resource route (loader
 * returns raw HTML; no React root, no App Bridge) that just tells the merchant
 * the connect finished and to return to their setup tab. The setup tab itself
 * detects the new pairing by polling the server (app.onboarding.status), so this
 * page does not need to message it directly — storage/postMessage signals are
 * unreliable across an embedded iframe + a first-party tab anyway (partitioning).
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const provider = esc((url.searchParams.get("provider") || "Your account").slice(0, 60));
  const ok = url.searchParams.get("status") !== "error";
  const reason = url.searchParams.get("reason");

  const accent = "#23556e";
  const ring = ok ? "#e7f5ec" : "#fdf3da";
  const mark = ok ? "#1a7f4f" : "#9a7400";
  const icon = ok
    ? '<path d="M5 12l5 5 9-11" fill="none" stroke="#1a7f4f" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'
    : '<path d="M12 8v5M12 16h.01" fill="none" stroke="#9a7400" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="12" r="9" fill="none" stroke="#9a7400" stroke-width="2"/>';
  const title = ok ? `${provider} is connected` : `Couldn’t connect ${provider}`;
  const body = ok
    ? "You can close this tab and return to your Calderyn setup — the connection will appear there automatically."
    : `${reason ? esc(reason.slice(0, 140)) + ". " : ""}Close this tab and try again from your Calderyn setup. Your setup isn’t blocked.`;

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;background:#f1f1f1;color:#1a1a1a;display:flex;align-items:center;justify-content:center;padding:24px;-webkit-font-smoothing:antialiased}
  .card{width:100%;max-width:420px;background:#fff;border:1px solid #e3e3e3;border-radius:16px;box-shadow:0 1px 3px rgba(26,26,26,.06);padding:36px 32px;text-align:center}
  .ring{width:64px;height:64px;border-radius:50%;background:${ring};display:inline-flex;align-items:center;justify-content:center;margin-bottom:18px}
  h1{margin:0;font-size:20px;font-weight:700;letter-spacing:-.01em}
  p{margin:10px 0 0;font-size:14px;line-height:1.55;color:#6a6a6a}
  button{margin-top:22px;height:44px;padding:0 22px;border:none;border-radius:11px;background:${accent};color:#fff;font-size:14.5px;font-weight:600;cursor:pointer;font-family:inherit}
  button:hover{opacity:.92}
  .hint{margin-top:14px;font-size:12px;color:#9a9a9a}
</style>
</head><body>
  <main class="card">
    <span class="ring"><svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></span>
    <h1>${title}</h1>
    <p>${body}</p>
    <button type="button" onclick="window.close()">Close this tab</button>
    <div class="hint">Marked <strong style="color:${mark}">${ok ? "connected" : "not connected"}</strong> · safe to close</div>
  </main>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};
