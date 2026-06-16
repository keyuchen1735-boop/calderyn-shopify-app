// app/lib/pilot-invite/email.server.ts
// Renders the delivered pilot onboarding email (table + inline styles, Outlook VML
// kept) with fields filled server-side.
//
// Single fluid column at the standard 600px email width — no desktop/mobile pair
// toggled by a media query. The earlier desktop-first build relied on @media to swap
// in a stacked layout; clients that strip <style>/media queries (Gmail on non-Google
// accounts, several Android clients) fell back to the WIDE two-column hero crushed
// into the phone — the "compacted on mobile" bug. One column can't be crushed, so it
// renders the same everywhere, query or no query.
//
// It is also deliberately text-first (no images, one primary CTA, founder voice). Auth
// is correct (DKIM/SPF/DMARC all pass), so Promotions placement is a content signal:
// a big branded hero + product "feature" card + multiple buttons reads as a marketing
// blast to Gmail's classifier. Trimming those signals nudges it toward Primary. (List-
// Unsubscribe stays in the send path — it does NOT force Promotions.)
import {
  escapeHtml, INSTALL_URL, FEEDBACK_URL, DEFAULT_FIRST_NAME, DEFAULT_STORE_NAME,
  viewInBrowserUrl,
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
  const viewUrl = viewInBrowserUrl(opts.baseUrl, firstRaw, storeRaw);

  const subject = hasFirst
    ? `You're in, ${firstRaw} — your free Calderyn pilot`
    : "You're in — your free Calderyn pilot";

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
    body { margin:0; padding:0; width:100% !important; background:#E7E8EC; }
    a { color:#24556E; }
    a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
    .hover-btn:hover { opacity:0.9 !important; }
    /* Single column already fits any width — the query only trims side padding and
       eases the headline on small phones. Layout never depends on it. */
    @media only screen and (max-width:600px) {
      .container { width:100% !important; }
      .px { padding-left:26px !important; padding-right:26px !important; }
      .h1 { font-size:31px !important; line-height:36px !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background:#E7E8EC;">
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#E7E8EC; opacity:0;">
    You're in — ${store} has a free seat in the Calderyn beta. Install in one click.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#E7E8EC;">
    <tr>
      <td align="center" style="padding:32px 12px 40px;">

        <table role="presentation" class="container" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:0 auto;">

          <!-- ===== HERO (teal, single column) ===== -->
          <tr>
            <td style="background:#24556E; border-radius:18px 18px 0 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="px h1" style="padding:46px 40px 0; font-family:${FONT}; font-size:36px; line-height:40px; font-weight:700; letter-spacing:-0.032em; color:#FFFFFF;">You're in,<br />${first}.</td>
                </tr>
                <tr>
                  <td class="px" style="padding:18px 40px 0; font-family:${FONT}; font-size:16px; line-height:25px; color:#C3D4DE; letter-spacing:-0.004em;">${store} has a free seat in the Calderyn beta — ad spend + inventory, watched together.</td>
                </tr>
                <tr>
                  <td class="px" style="padding:28px 40px 0;">
                    <!--[if mso]>
                    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${INSTALL_URL}" style="height:48px;v-text-anchor:middle;width:236px;" arcsize="52%" stroke="f" fillcolor="#FFFFFF">
                    <w:anchorlock/>
                    <center style="color:#24556E;font-family:sans-serif;font-size:15px;font-weight:bold;">Install free on Shopify  &rarr;</center>
                    </v:roundrect>
                    <![endif]-->
                    <!--[if !mso]><!-->
                    <a class="hover-btn" href="${INSTALL_URL}" target="_blank" style="display:inline-block; background:#FFFFFF; color:#24556E; font-family:${FONT}; font-size:15px; font-weight:650; letter-spacing:-0.006em; text-decoration:none; text-align:center; padding:14px 24px; border-radius:999px;">Install free on Shopify &nbsp;&rarr;</a>
                    <!--<![endif]-->
                  </td>
                </tr>
                <tr>
                  <td class="px" style="padding:13px 40px 46px; font-family:${FONT}; font-size:12.5px; color:#9FBACB;">One-click · uninstall anytime</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ===== BODY: steps (white) ===== -->
          <tr>
            <td style="background:#FFFFFF;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="px" style="padding:34px 40px 0; font-family:${FONT}; font-size:13px; font-weight:600; letter-spacing:0.01em; color:#9A9AA0;">Three steps, about a minute:</td>
                </tr>
                <tr>
                  <td class="px" style="padding:22px 40px 4px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td width="30%" align="center" style="vertical-align:top; font-family:${FONT};">
                          <div style="width:30px; height:30px; background:#24556E; border-radius:50%; text-align:center; font-size:14px; line-height:30px; color:#FFFFFF; font-weight:700; margin:0 auto;">1</div>
                          <div style="font-size:14.5px; font-weight:650; color:#1D1D1F; letter-spacing:-0.008em; padding-top:11px; text-align:center;">Install</div>
                        </td>
                        <td width="5%" align="center" style="vertical-align:top; font-family:${FONT};">
                          <div style="line-height:30px; font-size:16px; color:#C2C7CF;">&rarr;</div>
                        </td>
                        <td width="30%" align="center" style="vertical-align:top; font-family:${FONT};">
                          <div style="width:30px; height:30px; background:#24556E; border-radius:50%; text-align:center; font-size:14px; line-height:30px; color:#FFFFFF; font-weight:700; margin:0 auto;">2</div>
                          <div style="font-size:14.5px; font-weight:650; color:#1D1D1F; letter-spacing:-0.008em; padding-top:11px; text-align:center;">Connect</div>
                        </td>
                        <td width="5%" align="center" style="vertical-align:top; font-family:${FONT};">
                          <div style="line-height:30px; font-size:16px; color:#C2C7CF;">&rarr;</div>
                        </td>
                        <td width="30%" align="center" style="vertical-align:top; font-family:${FONT};">
                          <div style="width:30px; height:30px; background:#24556E; border-radius:50%; text-align:center; font-size:14px; line-height:30px; color:#FFFFFF; font-weight:700; margin:0 auto;">3</div>
                          <div style="font-size:14.5px; font-weight:650; color:#1D1D1F; letter-spacing:-0.008em; padding-top:11px; text-align:center;">Save</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ===== FOUNDERS (white) ===== -->
          <tr>
            <td style="background:#FFFFFF;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="px" style="padding:34px 40px 0; font-family:${FONT}; font-size:15px; line-height:23px; color:#3A3A3E; letter-spacing:-0.006em;">
                    You're shaping v1 — if anything feels off, <a href="${FEEDBACK_URL}" target="_blank" style="color:#24556E; text-decoration:underline;">tell us</a>. We read every note.
                  </td>
                </tr>
                <tr>
                  <td class="px" style="padding:26px 40px 6px; font-family:${FONT}; font-size:11px; font-weight:700; letter-spacing:0.16em; text-transform:uppercase; color:#9A9AA0;">Founders, Calderyn</td>
                </tr>
                <tr>
                  <td class="px" style="padding:6px 40px 38px;">
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
          </tr>

          <!-- ===== FOOTER (white, rounded bottom) ===== -->
          <tr>
            <td style="background:#FFFFFF; border-radius:0 0 18px 18px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td class="px" style="padding:0 40px;"><div style="height:1px; background:#ECECEF; font-size:0; line-height:0;">&nbsp;</div></td></tr>
                <tr>
                  <td class="px" align="center" style="padding:22px 40px 0; font-family:${FONT}; font-size:12px; color:#AEAEB2;">Commerce ops, on autopilot.</td>
                </tr>
                <tr>
                  <td class="px" align="center" style="padding:11px 40px 28px; font-family:${FONT}; font-size:11.5px; line-height:18px; color:#BFBFC6;">
                    You joined the Calderyn waitlist. &nbsp;
                    <a href="https://calderyncompany.com" style="color:#9A9AA0; text-decoration:underline;">calderyncompany.com</a>
                    &nbsp;·&nbsp;
                    <a href="${escapeHtml(viewUrl)}" style="color:#9A9AA0; text-decoration:underline;">View in browser</a>
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
    `Three steps, about a minute: Install → Connect → Save.`,
    ``,
    `You're shaping v1 — if anything feels off, tell us: ${FEEDBACK_URL}`,
    ``,
    `View in browser: ${viewUrl}`,
    `Unsubscribe: ${opts.unsubscribeUrl}`,
    `— Eric, Kenneth & John, Calderyn`,
  ].join("\n");

  return { subject, html, text };
}
