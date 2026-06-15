// app/lib/pilot-invite/landing.server.ts
// Renders the hosted "view in browser" twin of the onboarding email. Ported from
// docs/superpowers/specs/handoff-pilot/calderyn-pilot-web.html.
import { escapeHtml, DEFAULT_FIRST_NAME, DEFAULT_STORE_NAME, markUrls } from "./content";

export interface RenderLandingOpts { firstName: string; storeName: string; baseUrl: string; }

export function renderPilotLanding(opts: RenderLandingOpts): string {
  const first = escapeHtml(opts.firstName.trim() || DEFAULT_FIRST_NAME);
  const store = escapeHtml(opts.storeName.trim() || DEFAULT_STORE_NAME);
  const marks = markUrls(opts.baseUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>You're in — Calderyn pilot</title>
  <style>
    *{box-sizing:border-box;}
    html,body{margin:0;padding:0;}
    body{font-family:-apple-system,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F4F5F8;color:#1D1D1F;-webkit-font-smoothing:antialiased;}
    @keyframes cdFloat{0%,100%{transform:translateY(0);}50%{transform:translateY(-10px);}}
    @keyframes cdPulse{0%{box-shadow:0 0 0 0 rgba(224,53,43,.5);}70%{box-shadow:0 0 0 9px rgba(224,53,43,0);}100%{box-shadow:0 0 0 0 rgba(224,53,43,0);}}
    .cta-primary{transition:transform .15s ease,box-shadow .15s ease;}
    .cta-primary:hover{transform:translateY(-2px);box-shadow:0 18px 40px -12px rgba(0,0,0,.5);}
    .cta-ghost{transition:background .15s ease,color .15s ease;}
    .cta-ghost:hover{background:#24556E;color:#fff;}
    .wrap{max-width:1120px;margin:0 auto;}
  </style>
</head>
<body>

  <!-- nav -->
  <div style="position:sticky;top:0;z-index:20;background:rgba(244,245,248,.82);backdrop-filter:blur(14px) saturate(1.4);border-bottom:.5px solid rgba(0,0,0,.08);">
    <div class="wrap" style="padding:16px 28px;display:flex;align-items:center;gap:12px;">
      <img src="${marks.teal}" width="24" height="24" alt="Calderyn" style="display:block;width:24px;height:24px;" />
      <span style="font-size:14px;font-weight:700;letter-spacing:.18em;color:#24556E;">CALDERYN</span>
      <span style="margin-left:auto;font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#9A9AA0;">Beta pilot</span>
    </div>
  </div>

  <!-- hero -->
  <div style="background:#24556E;background-image:radial-gradient(900px 420px at 78% -8%,rgba(127,168,190,.28),transparent 60%);overflow:hidden;">
    <div class="wrap" style="padding:84px 28px 96px;display:flex;flex-wrap:wrap;align-items:center;gap:56px;">
      <div style="flex:1 1 420px;min-width:300px;">
        <div style="display:inline-flex;align-items:center;gap:9px;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:7px 14px;">
          <span style="width:7px;height:7px;border-radius:50%;background:#9FE6B4;display:block;"></span>
          <span style="font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#C3D4DE;">Selected for the pilot</span>
        </div>
        <h1 style="font-family:-apple-system,'SF Pro Display','Segoe UI',sans-serif;font-size:clamp(44px,6vw,72px);line-height:1.02;font-weight:700;letter-spacing:-.035em;color:#fff;margin:22px 0 0;text-wrap:balance;">You're in, ${first}.</h1>
        <p style="font-size:clamp(17px,1.5vw,20px);line-height:1.5;color:#C3D4DE;letter-spacing:-.004em;margin:20px 0 0;max-width:30ch;">${store} has a free seat in the Calderyn beta — ad spend + inventory, watched together.</p>
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:16px;margin-top:34px;">
          <a class="cta-primary" href="https://apps.shopify.com/calderynextension" target="_blank" style="display:inline-flex;align-items:center;gap:10px;background:#fff;color:#24556E;font-size:16px;font-weight:650;letter-spacing:-.006em;text-decoration:none;padding:16px 26px;border-radius:999px;box-shadow:0 12px 30px -10px rgba(0,0,0,.4);">Install free on Shopify <span style="font-size:18px;">&rarr;</span></a>
          <span style="font-size:13px;color:#9FBACB;">One-click · uninstall anytime</span>
        </div>
      </div>
      <div style="flex:1 1 380px;min-width:300px;display:flex;justify-content:center;">
        <div style="width:100%;max-width:420px;animation:cdFloat 6s ease-in-out infinite;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;padding-left:4px;">
            <span style="font-size:12px;font-weight:600;color:#9FBACB;">&#8249; Alerts</span>
            <span style="margin-left:auto;font-size:11.5px;color:#7FA8BE;padding-right:4px;">1 open</span>
          </div>
          <div style="background:#fff;border-radius:18px;box-shadow:0 30px 70px -24px rgba(0,0,0,.5),0 2px 6px rgba(0,0,0,.06);padding:22px 24px 24px;">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;">
              <div style="display:inline-flex;align-items:center;gap:7px;">
                <span style="width:9px;height:9px;border-radius:50%;background:#E0352B;display:block;animation:cdPulse 2.4s ease infinite;"></span>
                <span style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#E0352B;">Critical</span>
              </div>
              <div style="font-size:26px;font-weight:700;letter-spacing:-.03em;color:#E0352B;">$3,150<span style="font-size:13px;font-weight:600;color:#AEAEB2;">/wk</span></div>
            </div>
            <div style="font-size:19px;font-weight:650;letter-spacing:-.015em;color:#1D1D1F;margin-top:14px;">Running ads for a sold-out product</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-top:18px;">
              <div style="background:#F4F5F7;border-radius:11px;padding:11px 12px;"><div style="font-size:11px;color:#9A9AA0;">ROAS · 7d</div><div style="font-size:16px;font-weight:650;letter-spacing:-.01em;margin-top:2px;">0.1&times;</div></div>
              <div style="background:#F4F5F7;border-radius:11px;padding:11px 12px;"><div style="font-size:11px;color:#9A9AA0;">Break-even</div><div style="font-size:16px;font-weight:650;letter-spacing:-.01em;margin-top:2px;">1.7&times;</div></div>
              <div style="background:#F4F5F7;border-radius:11px;padding:11px 12px;"><div style="font-size:11px;color:#9A9AA0;">On hand</div><div style="font-size:16px;font-weight:650;letter-spacing:-.01em;margin-top:2px;">0 units</div></div>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;background:#24556E;border-radius:12px;padding:14px 16px;margin-top:18px;">
              <span style="font-size:14.5px;font-weight:600;color:#fff;letter-spacing:-.006em;">Pause campaign</span>
              <span style="font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#9FBCCB;">Recommended</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- value + steps -->
  <div class="wrap" style="padding:84px 28px 0;">
    <h2 style="font-family:-apple-system,'SF Pro Display','Segoe UI',sans-serif;font-size:clamp(28px,3.4vw,40px);line-height:1.12;font-weight:650;letter-spacing:-.025em;margin:0;max-width:18ch;">Ad spend + inventory, watched <span style="color:#24556E;">together</span>.</h2>
    <div style="display:flex;flex-wrap:wrap;gap:20px;margin-top:48px;">
      <div style="flex:1 1 240px;min-width:220px;background:#fff;border:.5px solid rgba(0,0,0,.06);border-radius:18px;padding:26px;box-shadow:0 1px 2px rgba(0,0,0,.03);"><div style="width:34px;height:34px;border-radius:50%;background:#24556E;color:#fff;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center;">1</div><div style="font-size:17px;font-weight:650;letter-spacing:-.01em;margin-top:16px;">Install</div><div style="font-size:14px;line-height:1.5;color:#6E6E73;margin-top:6px;">One click — adds Calderyn to your Shopify admin.</div></div>
      <div style="flex:1 1 240px;min-width:220px;background:#fff;border:.5px solid rgba(0,0,0,.06);border-radius:18px;padding:26px;box-shadow:0 1px 2px rgba(0,0,0,.03);"><div style="width:34px;height:34px;border-radius:50%;background:#24556E;color:#fff;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center;">2</div><div style="font-size:17px;font-weight:650;letter-spacing:-.01em;margin-top:16px;">Connect</div><div style="font-size:14px;line-height:1.5;color:#6E6E73;margin-top:6px;">Link Meta, Google, TikTok &amp; QuickBooks — ~2 min.</div></div>
      <div style="flex:1 1 240px;min-width:220px;background:#fff;border:.5px solid rgba(0,0,0,.06);border-radius:18px;padding:26px;box-shadow:0 1px 2px rgba(0,0,0,.03);"><div style="width:34px;height:34px;border-radius:50%;background:#24556E;color:#fff;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center;">3</div><div style="font-size:17px;font-weight:650;letter-spacing:-.01em;margin-top:16px;">Get the text</div><div style="font-size:14px;line-height:1.5;color:#6E6E73;margin-top:6px;">Your first alert — usually within 24 hours.</div></div>
    </div>
  </div>

  <!-- feedback -->
  <div class="wrap" style="margin-top:64px;padding:0 28px;">
    <div style="background:#EEF1F4;border-radius:20px;padding:32px 36px;display:flex;flex-wrap:wrap;align-items:center;gap:20px;">
      <div style="flex:1 1 300px;"><div style="font-size:20px;font-weight:650;letter-spacing:-.015em;">You're shaping v1.</div><div style="font-size:14.5px;color:#6E6E73;margin-top:5px;">Tell us what's off — it goes straight to us.</div></div>
      <a class="cta-ghost" href="https://calderyncompany.com/pilot-feedback" target="_blank" style="display:inline-flex;align-items:center;gap:9px;background:#fff;border:1.5px solid #24556E;color:#24556E;font-size:15px;font-weight:650;text-decoration:none;padding:13px 22px;border-radius:999px;">Share feedback <span style="font-size:17px;">&rarr;</span></a>
    </div>
  </div>

  <!-- founders -->
  <div class="wrap" style="padding:64px 28px 28px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#9A9AA0;">Founders, Calderyn</div>
    <div style="display:flex;gap:16px;margin-top:18px;">
      <div style="flex:1;text-align:center;font-family:'Georgia','Times New Roman',serif;font-size:clamp(20px,2.4vw,28px);font-style:italic;color:#24556E;">Eric</div>
      <div style="flex:1;text-align:center;font-family:'Georgia','Times New Roman',serif;font-size:clamp(20px,2.4vw,28px);font-style:italic;color:#24556E;">Kenneth</div>
      <div style="flex:1;text-align:center;font-family:'Georgia','Times New Roman',serif;font-size:clamp(20px,2.4vw,28px);font-style:italic;color:#24556E;">John</div>
    </div>
  </div>

  <!-- footer -->
  <div style="border-top:.5px solid rgba(0,0,0,.08);margin-top:40px;">
    <div class="wrap" style="padding:28px;display:flex;flex-wrap:wrap;align-items:center;gap:12px;">
      <img src="${marks.teal}" width="18" height="18" alt="Calderyn" style="display:block;width:18px;height:18px;opacity:.8;" />
      <span style="font-size:12.5px;color:#9A9AA0;letter-spacing:.01em;">Commerce ops, on autopilot.</span>
      <span style="margin-left:auto;font-size:12px;color:#BFBFC6;">calderyncompany.com</span>
    </div>
  </div>

</body>
</html>`;
}
