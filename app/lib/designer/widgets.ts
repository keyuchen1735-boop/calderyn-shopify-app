// Runtime-owned conversion widgets for the designer. The model can never
// author behavior (the scrub strips scripts), so it DECLARES a widget with a
// data-designer-widget marker and the render layer expands it into real markup
// plus, on the live storefront, a nonce'd script. The preview shows the same
// markup inertly so the merchant sees the design.
//
// Marker shape (survives the scrub — plain data attributes):
//   <div data-designer-widget="coupon" data-code="WELCOME10"
//        data-headline="10% off your first order"
//        data-sub="Join the list for early access and member pricing."></div>

export interface DesignerWidgetSpec {
  code: string;
  headline: string;
  sub: string;
}

const MARKER_RE = /<div\b[^>]*\bdata-designer-widget\s*=\s*["']coupon["'][^>]*><\/div>/i;
const MARKER_RE_ALL = /<div\b[^>]*\bdata-designer-widget\s*=\s*["']coupon["'][^>]*><\/div>/gi;

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\bdata-${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  return m ? m[1] : "";
}

/** Baseline widget CSS, appended to the document so a store that never
 *  restyled the popup still looks intentional. Inherits the store's fonts and
 *  accent via the design-system CSS vars the base document defines. */
export const COUPON_WIDGET_CSS = `
.cd-coupon-backdrop{position:fixed;inset:0;background:rgba(15,15,15,.55);display:none;align-items:center;justify-content:center;padding:20px;z-index:9999}
.cd-coupon-backdrop[data-open="1"]{display:flex}
.cd-coupon{max-width:420px;width:100%;background:var(--paper,#fff);color:var(--forest,#1a1a1a);border-radius:14px;padding:32px 30px;position:relative;box-shadow:0 24px 60px rgba(0,0,0,.28);font-family:var(--font-body,inherit)}
.cd-coupon h3{font-family:var(--font-display,inherit);font-size:1.6rem;line-height:1.05;margin:0 0 8px}
.cd-coupon p{margin:0 0 18px;opacity:.8;font-size:.95rem;line-height:1.4}
.cd-coupon form{display:flex;flex-direction:column;gap:10px}
.cd-coupon input{padding:12px 14px;border:1px solid var(--line,#cfcfcf);border-radius:8px;font:inherit;background:transparent;color:inherit}
.cd-coupon button.cd-coupon-cta{padding:12px 16px;border:none;border-radius:8px;background:var(--signal,var(--acid,#c2551f));color:#fff;font:inherit;font-weight:600;cursor:pointer}
.cd-coupon-code{display:none;margin-top:14px;padding:12px;border:1px dashed var(--line,#cfcfcf);border-radius:8px;text-align:center;font-weight:700;letter-spacing:.08em}
.cd-coupon[data-revealed="1"] .cd-coupon-code{display:block}
.cd-coupon[data-revealed="1"] form{display:none}
.cd-coupon-close{position:absolute;top:12px;right:14px;background:none;border:none;font-size:22px;line-height:1;cursor:pointer;color:inherit;opacity:.6}
.cd-coupon-preview-note{position:absolute;top:-26px;left:0;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.6}
`;

function markup(spec: DesignerWidgetSpec, opts: { preview: boolean }): string {
  const note = opts.preview
    ? '<span class="cd-coupon-preview-note">Popup preview</span>'
    : "";
  // Preview shows the card inline (backdrop open, not fixed) so it doesn't
  // cover the design; live starts hidden and the script opens it.
  const backdropStyle = opts.preview
    ? 'style="position:static;background:none;display:flex;padding:40px 0" data-open="1"'
    : "";
  return `<div class="cd-coupon-backdrop" data-cd-coupon ${backdropStyle}>
  <div class="cd-coupon" data-revealed="0">
    ${note}
    <button class="cd-coupon-close" type="button" data-cd-coupon-close aria-label="Close">&times;</button>
    <h3>${escapeHtml(spec.headline)}</h3>
    <p>${escapeHtml(spec.sub)}</p>
    <form data-cd-coupon-form>
      <input type="email" placeholder="Email address" aria-label="Email address" required>
      <button class="cd-coupon-cta" type="submit">Reveal my code</button>
    </form>
    <div class="cd-coupon-code">Use code <b>${escapeHtml(spec.code)}</b> at checkout</div>
  </div>
</div>`;
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Nonce'd behavior for the live storefront: open once per session after a
 *  short delay, close, and reveal the code on submit (no data leaves the page —
 *  the email is a soft capture that just unlocks the code). */
export const COUPON_WIDGET_SCRIPT = `(function(){var b=document.querySelector("[data-cd-coupon]");if(!b)return;var KEY="cd_coupon_seen";function open(){b.setAttribute("data-open","1")}function close(){b.removeAttribute("data-open");try{sessionStorage.setItem(KEY,"1")}catch(e){}}if(!(function(){try{return sessionStorage.getItem(KEY)}catch(e){return null}})()){setTimeout(open,6000)}b.addEventListener("click",function(e){if(e.target===b||e.target.closest("[data-cd-coupon-close]"))close()});var f=b.querySelector("[data-cd-coupon-form]");if(f){f.addEventListener("submit",function(e){e.preventDefault();var c=b.querySelector(".cd-coupon");if(c)c.setAttribute("data-revealed","1")})}})();`;

/** Replaces a coupon-widget marker with real markup. Returns the expanded html,
 *  the baseline css to append, and (when not preview) the behavior script.
 *  No marker → unchanged html and empty extras. */
export function expandCouponWidget(html: string, opts: { preview: boolean }): { html: string; css: string; script: string } {
  const match = MARKER_RE.exec(html);
  if (!match) return { html, css: "", script: "" };
  const tag = match[0];
  const spec: DesignerWidgetSpec = {
    code: attr(tag, "code") || "WELCOME10",
    headline: attr(tag, "headline") || "10% off your first order",
    sub: attr(tag, "sub") || "Join the list for early access and member pricing.",
  };
  // Expand the first declaration; drop any duplicates so a second marker never
  // renders as a stray empty div. Only one popup per page.
  const expanded = html.replace(MARKER_RE, markup(spec, opts)).replace(MARKER_RE_ALL, "");
  return { html: expanded, css: COUPON_WIDGET_CSS, script: opts.preview ? "" : COUPON_WIDGET_SCRIPT };
}

export function hasCouponWidget(html: string): boolean {
  return MARKER_RE.test(html);
}
