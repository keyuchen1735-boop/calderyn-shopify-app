// app/lib/pilot-invite/email.server.ts
// Renders the delivered pilot email (table + inline styles, Outlook VML kept) with
// fields filled server-side and absolute https asset URLs.
//
// Responsive by design: ONE email that "detects" width via a media query.
//   • Desktop (default, incl. Outlook): File 1's two-column hero — copy + CTA on the
//     left, the alert card on the right (docs/.../handoff-pilot/calderyn-pilot-web.html).
//   • Mobile (<=600px): File 2's stacked hero (calderyn-pilot-email.html).
// Email can't truly detect a device; the <=600px media query is the closest
// equivalent. Clients with no media-query support fall back to the desktop layout.
import {
  escapeHtml, INSTALL_URL, FEEDBACK_URL, DEFAULT_FIRST_NAME, DEFAULT_STORE_NAME,
  markUrls, viewInBrowserUrl,
} from "./content";

export interface RenderEmailOpts {
  firstName: string;
  storeName: string;
  baseUrl: string;       // absolute origin, no trailing slash
  unsubscribeUrl: string; // absolute, tokened (or a plain preview URL)
}
export interface RenderedEmail { subject: string; html: string; text: string; }

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function renderPilotEmail(opts: RenderEmailOpts): RenderedEmail {
  const hasFirst = opts.firstName.trim().length > 0;
  const firstRaw = hasFirst ? opts.firstName : DEFAULT_FIRST_NAME;
  const storeRaw = opts.storeName.trim().length > 0 ? opts.storeName : DEFAULT_STORE_NAME;
  const first = escapeHtml(firstRaw);
  const store = escapeHtml(storeRaw);
  const marks = markUrls(opts.baseUrl);
  const viewUrl = viewInBrowserUrl(opts.baseUrl, firstRaw, storeRaw);

  const subject = hasFirst
    ? `You're in, ${firstRaw} — your free Calderyn pilot`
    : "You're in — your free Calderyn pilot";

  // The product-hook alert card — reused in the desktop hero (right column) and the
  // mobile stack so the two layouts stay in sync.
  const alertCard = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF; border:1px solid #E6E7EB; border-radius:14px;">
    <tr>
      <td style="padding:18px 18px 18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="vertical-align:top; font-family:${FONT};">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                <td style="vertical-align:middle; padding-right:6px;"><div style="width:8px; height:8px; background:#E0352B; border-radius:50%; font-size:0; line-height:0;">&nbsp;</div></td>
                <td style="vertical-align:middle; font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#E0352B;">Critical</td>
              </tr></table>
            </td>
            <td align="right" style="vertical-align:top; font-family:${FONT};">
              <div style="font-size:22px; font-weight:700; letter-spacing:-0.03em; color:#E0352B;">$3,150<span style="font-size:12px; font-weight:600; color:#AEAEB2;">/wk</span></div>
            </td>
          </tr>
        </table>
        <div style="font-family:${FONT}; font-size:17px; font-weight:650; color:#1D1D1F; letter-spacing:-0.014em; padding-top:12px;">Running ads for a sold-out product</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding-top:14px;">
          <tr>
            <td width="33.33%" style="vertical-align:top; padding-right:4px;">
              <div style="background:#F4F5F7; border-radius:10px; padding:8px 9px; font-family:${FONT};">
                <div style="font-size:10.5px; color:#9A9AA0;">ROAS&middot;7d</div>
                <div style="font-size:15px; font-weight:650; color:#1D1D1F; letter-spacing:-0.01em; padding-top:2px;">0.1&times;</div>
              </div>
            </td>
            <td width="33.33%" style="vertical-align:top; padding:0 2px;">
              <div style="background:#F4F5F7; border-radius:10px; padding:8px 9px; font-family:${FONT};">
                <div style="font-size:10.5px; color:#9A9AA0;">Break-even</div>
                <div style="font-size:15px; font-weight:650; color:#1D1D1F; letter-spacing:-0.01em; padding-top:2px;">1.7&times;</div>
              </div>
            </td>
            <td width="33.33%" style="vertical-align:top; padding-left:4px;">
              <div style="background:#F4F5F7; border-radius:10px; padding:8px 9px; font-family:${FONT};">
                <div style="font-size:10.5px; color:#9A9AA0;">On hand</div>
                <div style="font-size:15px; font-weight:650; color:#1D1D1F; letter-spacing:-0.01em; padding-top:2px;">0 units</div>
              </div>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#24556E; border-radius:11px; margin-top:14px;">
          <tr>
            <td style="padding:12px 14px; vertical-align:middle; font-family:${FONT}; font-size:14px; font-weight:600; color:#FFFFFF; letter-spacing:-0.006em;">Pause campaign</td>
            <td align="right" style="padding:12px 14px; vertical-align:middle; font-family:${FONT}; font-size:10.5px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; color:#9FBCCB;">Recommended</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;

  // The three shared sections (identical in both designs) — rendered once.
  const sharedSteps = `<tr>
    <td style="background:#FFFFFF; padding:0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td class="px" style="padding:34px 44px 0;"><div style="height:1px; background:#ECECEF; font-size:0; line-height:0;">&nbsp;</div></td></tr>
        <tr>
          <td class="px" style="padding:28px 44px 4px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="33.33%" align="center" style="vertical-align:top; font-family:${FONT};">
                  <div style="width:30px; height:30px; background:#24556E; border-radius:50%; text-align:center; font-size:14px; line-height:30px; color:#FFFFFF; font-weight:700; margin:0 auto;">1</div>
                  <div style="font-size:14.5px; font-weight:650; color:#1D1D1F; letter-spacing:-0.008em; padding-top:11px; text-align:center;">Install</div>
                </td>
                <td width="33.33%" align="center" style="vertical-align:top; font-family:${FONT};">
                  <div style="width:30px; height:30px; background:#24556E; border-radius:50%; text-align:center; font-size:14px; line-height:30px; color:#FFFFFF; font-weight:700; margin:0 auto;">2</div>
                  <div style="font-size:14.5px; font-weight:650; color:#1D1D1F; letter-spacing:-0.008em; padding-top:11px; text-align:center;">Connect</div>
                </td>
                <td width="33.33%" align="center" style="vertical-align:top; font-family:${FONT};">
                  <div style="width:30px; height:30px; background:#24556E; border-radius:50%; text-align:center; font-size:14px; line-height:30px; color:#FFFFFF; font-weight:700; margin:0 auto;">3</div>
                  <div style="font-size:14.5px; font-weight:650; color:#1D1D1F; letter-spacing:-0.008em; padding-top:11px; text-align:center;">Get the text</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;

  const sharedFounders = `<tr>
    <td style="background:#FFFFFF; padding:0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td class="px" style="padding:32px 44px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F4F6; border-radius:14px;">
              <tr>
                <td style="padding:22px 24px; font-family:${FONT};">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
                    <td style="vertical-align:middle;">
                      <div style="font-size:16px; font-weight:650; color:#1D1D1F; letter-spacing:-0.01em;">You're shaping v1.</div>
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                        <td style="background:#FFFFFF; border:1.5px solid #24556E; border-radius:999px;">
                          <a class="hover-btn" href="${FEEDBACK_URL}" target="_blank" style="display:inline-block; color:#24556E; font-family:${FONT}; font-size:14px; font-weight:650; text-decoration:none; padding:11px 18px; white-space:nowrap;">Feedback &nbsp;&rarr;</a>
                        </td>
                      </tr></table>
                    </td>
                  </tr></table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="px" style="padding:34px 44px 6px; font-family:${FONT}; font-size:11px; font-weight:700; letter-spacing:0.16em; text-transform:uppercase; color:#9A9AA0;">Founders, Calderyn</td>
        </tr>
        <tr>
          <td class="px" style="padding:6px 44px 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="33.33%" align="center" style="font-family:'Georgia','Times New Roman',serif; font-size:19px; font-style:italic; color:#24556E;">Eric</td>
                <td width="33.33%" align="center" style="font-family:'Georgia','Times New Roman',serif; font-size:19px; font-style:italic; color:#24556E;">Kenneth</td>
                <td width="33.33%" align="center" style="font-family:'Georgia','Times New Roman',serif; font-size:19px; font-style:italic; color:#24556E;">John</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light only" />
  <title>You're in — your free Calderyn pilot</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <style>
    body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { -ms-interpolation-mode:bicubic; border:0; outline:none; text-decoration:none; display:block; }
    body { margin:0; padding:0; width:100% !important; background:#E7E8EC; }
    a { color:#24556E; }
    a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
    .hover-btn:hover { opacity:0.9 !important; }
    /* Desktop-first: the File-1 two-column hero shows by default (incl. Outlook).
       Under 600px we swap to the File-2 stacked hero. */
    .cd-mob { display:none; max-height:0; overflow:hidden; }
    @media only screen and (max-width:600px) {
      .cd-desk { display:none !important; max-height:0 !important; overflow:hidden !important; mso-hide:all; }
      .cd-mob  { display:block !important; max-height:none !important; overflow:visible !important; }
      .container { width:100% !important; }
      .px { padding-left:24px !important; padding-right:24px !important; }
      .h1 { font-size:38px !important; line-height:42px !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background:#E7E8EC;">
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#E7E8EC; opacity:0;">
    You're in. The free Calderyn pilot is yours — install in one click.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#E7E8EC;">
    <tr>
      <td align="center" style="padding:28px 12px 40px;">

        <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px;">

          <!-- Top bar (shared) -->
          <tr>
            <td class="px" style="padding:2px 8px 16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="left" style="vertical-align:middle;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                      <td style="vertical-align:middle; padding-right:9px;">
                        <img src="${marks.teal}" width="22" height="22" alt="Calderyn" style="display:block; width:22px; height:22px;" />
                      </td>
                      <td style="vertical-align:middle; font-family:${FONT}; font-size:13px; font-weight:700; letter-spacing:0.18em; color:#24556E;">CALDERYN</td>
                    </tr></table>
                  </td>
                  <td align="right" style="vertical-align:middle; font-family:${FONT}; font-size:11.5px; font-weight:600; letter-spacing:0.04em; color:#9A9AA0; text-transform:uppercase;">Beta pilot</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- View in browser (shared) -->
          <tr>
            <td>
              <div style="font-size:11px;line-height:16px;text-align:center;color:#9A9AA0;padding:0 0 6px;font-family:${FONT};">
                <a href="${escapeHtml(viewUrl)}" style="color:#9A9AA0;text-decoration:underline;">View in browser</a>
              </div>
            </td>
          </tr>

          <!-- ============ MIDDLE: desktop (File 1) | mobile (File 2) ============ -->
          <tr>
            <td style="padding:0;">

              <!-- ===== DESKTOP HERO (File 1 two-column) ===== -->
              <div class="cd-desk">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#24556E; border-radius:18px 18px 0 0;">
                  <tr>
                    <td class="px" style="padding:40px 36px 40px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <!-- left: copy + CTA -->
                          <td width="300" style="vertical-align:top; padding-right:20px;">
                            <div style="font-family:${FONT}; font-size:12px; font-weight:700; letter-spacing:0.16em; text-transform:uppercase; color:#7FA8BE;">Selected for the pilot</div>
                            <div class="h1" style="font-family:${FONT}; font-size:40px; line-height:44px; font-weight:700; letter-spacing:-0.034em; color:#FFFFFF; padding-top:14px;">You're in,<br />${first}.</div>
                            <div style="font-family:${FONT}; font-size:15px; line-height:23px; color:#C3D4DE; letter-spacing:-0.004em; padding-top:16px;">${store} has a free seat in the Calderyn beta — ad spend + inventory, watched together.</div>
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="padding-top:26px;"><tr><td>
                              <!--[if mso]>
                              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${INSTALL_URL}" style="height:48px;v-text-anchor:middle;width:230px;" arcsize="52%" stroke="f" fillcolor="#FFFFFF">
                              <w:anchorlock/>
                              <center style="color:#24556E;font-family:sans-serif;font-size:15px;font-weight:bold;">Install free on Shopify  &rarr;</center>
                              </v:roundrect>
                              <![endif]-->
                              <!--[if !mso]><!-->
                              <a class="hover-btn" href="${INSTALL_URL}" target="_blank" style="display:inline-block; background:#FFFFFF; color:#24556E; font-family:${FONT}; font-size:15px; font-weight:650; letter-spacing:-0.006em; text-decoration:none; text-align:center; padding:14px 22px; border-radius:999px;">Install free on Shopify &nbsp;&rarr;</a>
                              <!--<![endif]-->
                            </td></tr></table>
                            <div style="font-family:${FONT}; font-size:12px; color:#9FBACB; padding-top:12px;">One-click · uninstall anytime</div>
                          </td>
                          <!-- right: alert card -->
                          <td width="192" style="vertical-align:top;">
                            ${alertCard}
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;">
                  <tr>
                    <td class="px big" style="padding:36px 36px 0; font-family:${FONT}; font-size:26px; line-height:34px; font-weight:650; color:#1D1D1F; letter-spacing:-0.02em;">
                      Ad spend + inventory, watched <span style="color:#24556E;">together</span>.
                    </td>
                  </tr>
                </table>
              </div>

              <!-- ===== MOBILE HERO (File 2 stacked) ===== -->
              <div class="cd-mob">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#24556E; border-radius:18px 18px 0 0;">
                  <tr><td class="px" style="padding:44px 44px 0;"><img src="${marks.white}" width="48" height="48" alt="" style="display:block; width:48px; height:48px; opacity:0.96;" /></td></tr>
                  <tr><td class="px" style="padding:24px 44px 0; font-family:${FONT}; font-size:12px; font-weight:700; letter-spacing:0.16em; text-transform:uppercase; color:#7FA8BE;">Selected for the pilot</td></tr>
                  <tr><td class="px h1" style="padding:12px 44px 0; font-family:${FONT}; font-size:44px; line-height:46px; font-weight:700; letter-spacing:-0.034em; color:#FFFFFF;">You're in,<br />${first}.</td></tr>
                  <tr>
                    <td class="px" style="padding:28px 44px 44px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1C4459; border-radius:14px;">
                        <tr><td style="padding:17px 22px; font-family:${FONT};">
                          <div style="font-size:10.5px; font-weight:700; letter-spacing:0.18em; text-transform:uppercase; color:#6E97AD;">Pilot pass</div>
                          <div style="font-size:17px; font-weight:650; color:#FFFFFF; letter-spacing:-0.01em; padding-top:5px;">${store}</div>
                        </td></tr>
                      </table>
                    </td>
                  </tr>
                </table>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;">
                  <tr><td class="px big" style="padding:40px 44px 0; font-family:${FONT}; font-size:28px; line-height:36px; font-weight:650; color:#1D1D1F; letter-spacing:-0.02em;">Ad spend + inventory, watched <span style="color:#24556E;">together</span>.</td></tr>
                  <tr><td class="px" style="padding:24px 44px 0;">${alertCard}</td></tr>
                  <tr>
                    <td class="px" align="center" style="padding:28px 44px 6px;">
                      <!--[if mso]>
                      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${INSTALL_URL}" style="height:54px;v-text-anchor:middle;width:460px;" arcsize="52%" stroke="f" fillcolor="#24556E">
                      <w:anchorlock/>
                      <center style="color:#ffffff;font-family:sans-serif;font-size:16px;font-weight:bold;">Install free on Shopify  &rarr;</center>
                      </v:roundrect>
                      <![endif]-->
                      <!--[if !mso]><!-->
                      <a class="hover-btn" href="${INSTALL_URL}" target="_blank" style="display:block; background:#24556E; color:#FFFFFF; font-family:${FONT}; font-size:16px; font-weight:650; letter-spacing:-0.006em; text-decoration:none; text-align:center; padding:17px 24px; border-radius:999px;">Install free on Shopify &nbsp;&rarr;</a>
                      <!--<![endif]-->
                    </td>
                  </tr>
                  <tr><td class="px" align="center" style="padding:12px 44px 0; font-family:${FONT}; font-size:12.5px; color:#9A9AA0;">One-click · uninstall anytime</td></tr>
                </table>
              </div>

            </td>
          </tr>

          ${sharedSteps}

          ${sharedFounders}

          <!-- ===================== FOOTER (shared) ===================== -->
          <tr>
            <td style="background:#FFFFFF; border-radius:0 0 18px 18px; padding:0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td class="px" style="padding:0 44px;"><div style="height:1px; background:#ECECEF; font-size:0; line-height:0;">&nbsp;</div></td></tr>
                <tr>
                  <td class="px" align="center" style="padding:24px 44px 0; font-family:${FONT}; font-size:12px; color:#AEAEB2;">Commerce ops, on autopilot.</td>
                </tr>
                <tr>
                  <td class="px" align="center" style="padding:12px 44px 30px; font-family:${FONT}; font-size:11.5px; line-height:18px; color:#BFBFC6;">
                    You joined the Calderyn waitlist. &nbsp;
                    <a href="https://calderyncompany.com" style="color:#9A9AA0; text-decoration:underline;">calderyncompany.com</a>
                    &nbsp;·&nbsp;
                    <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#9A9AA0; text-decoration:underline;">Unsubscribe</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    `You're in${hasFirst ? `, ${firstRaw}` : ""}.`,
    `${storeRaw} has a free seat in the Calderyn beta — ad spend + inventory, watched together.`,
    ``,
    `Install free on Shopify: ${INSTALL_URL}`,
    `Share feedback: ${FEEDBACK_URL}`,
    ``,
    `View in browser: ${viewUrl}`,
    `Unsubscribe: ${opts.unsubscribeUrl}`,
    `— Eric, Kenneth & John, Calderyn`,
  ].join("\n");

  return { subject, html, text };
}
