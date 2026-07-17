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

// ── Cart drawer (live pages only) ────────────────────────────────────────────
// Runtime chrome, not model-authored design: every published designer page
// gets a slide-in cart with line items, subtotal, an optional free-shipping
// progress meter, and a checkout button. The model can power the meter by
// declaring data-designer-free-shipping="120" (whole dollars) on its
// announcement bar; without it the meter simply doesn't render.

export const CART_DRAWER_CSS = `
.cd-drawer-backdrop{position:fixed;inset:0;background:rgba(15,15,15,.45);display:none;z-index:9998}
.cd-drawer-backdrop[data-open="1"]{display:block}
.cd-drawer{position:fixed;top:0;right:0;bottom:0;width:min(400px,92vw);background:var(--paper,#fff);color:var(--forest,#1a1a1a);z-index:9999;transform:translateX(105%);transition:transform .28s ease;display:flex;flex-direction:column;box-shadow:-18px 0 48px rgba(0,0,0,.22);font-family:var(--font-body,inherit)}
.cd-drawer[data-open="1"]{transform:none}
.cd-drawer-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid var(--line,#e2e2e2)}
.cd-drawer-head b{font-family:var(--font-display,inherit);font-size:1.05rem}
.cd-drawer-close{background:none;border:none;font-size:22px;cursor:pointer;color:inherit;opacity:.6}
.cd-drawer-meter{padding:12px 20px;border-bottom:1px solid var(--line,#e2e2e2);font-size:.85rem}
.cd-drawer-meter-track{height:5px;background:var(--line,#e6e6e6);border-radius:3px;margin-top:8px;overflow:hidden}
.cd-drawer-meter-track i{display:block;height:100%;width:0;background:var(--signal,var(--acid,#c2551f));transition:width .3s ease}
.cd-drawer-lines{flex:1;overflow:auto;padding:8px 20px}
.cd-drawer-line{display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--line,#eee);font-size:.92rem}
.cd-drawer-line span:last-child{font-weight:600;white-space:nowrap}
.cd-drawer-empty{padding:28px 0;text-align:center;opacity:.65;font-size:.92rem}
.cd-drawer-foot{padding:16px 20px;border-top:1px solid var(--line,#e2e2e2)}
.cd-drawer-sub{display:flex;justify-content:space-between;font-weight:600;margin-bottom:12px}
.cd-drawer-checkout{display:block;width:100%;text-align:center;padding:14px;border:none;border-radius:8px;background:var(--signal,var(--acid,#1a1a1a));color:#fff;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.cd-drawer-view{display:block;text-align:center;margin-top:10px;font-size:.85rem;color:inherit;opacity:.75}
`;

export const CART_DRAWER_MARKUP = `<div class="cd-drawer-backdrop" data-cd-drawer-backdrop></div>
<aside class="cd-drawer" data-cd-drawer aria-label="Cart">
  <div class="cd-drawer-head"><b>Your cart</b><button class="cd-drawer-close" type="button" data-cd-drawer-close aria-label="Close">&times;</button></div>
  <div class="cd-drawer-meter" data-cd-drawer-meter hidden><span data-cd-meter-text></span><span class="cd-drawer-meter-track"><i data-cd-meter-bar></i></span></div>
  <div class="cd-drawer-lines" data-cd-drawer-lines><div class="cd-drawer-empty">Your cart is empty.</div></div>
  <div class="cd-drawer-foot">
    <div class="cd-drawer-sub"><span>Subtotal</span><span data-cd-drawer-subtotal>$0.00</span></div>
    <a class="cd-drawer-checkout" href="/storefront/checkout">Checkout</a>
    <a class="cd-drawer-view" href="/storefront/cart">View full cart</a>
  </div>
</aside>`;

/** Live behavior: add-to-cart opens the drawer instead of navigating; the
 *  drawer reads /storefront/api/cart and renders lines + subtotal + meter. */
export const CART_DRAWER_SCRIPT = `(function(){var drawer=document.querySelector("[data-cd-drawer]");var backdrop=document.querySelector("[data-cd-drawer-backdrop]");if(!drawer||!backdrop)return;
var thresholdEl=document.querySelector("[data-designer-free-shipping]");var threshold=thresholdEl?parseFloat(thresholdEl.getAttribute("data-designer-free-shipping"))*100:0;
function money(c){return "$"+(c/100).toFixed(2)}
function render(cart){var lines=drawer.querySelector("[data-cd-drawer-lines]");var sub=drawer.querySelector("[data-cd-drawer-subtotal]");var meter=drawer.querySelector("[data-cd-drawer-meter]");
if(!cart||!cart.lines||cart.lines.length===0){lines.innerHTML='<div class="cd-drawer-empty">Your cart is empty.</div>';sub.textContent="$0.00";if(meter)meter.hidden=true;return}
lines.innerHTML=cart.lines.map(function(l){return '<div class="cd-drawer-line"><span>'+String(l.titleSnapshot||"Item").replace(/[<>&]/g,"")+" × "+l.quantity+'</span><span>'+money(l.unitPriceCents*l.quantity)+"</span></div>"}).join("");
sub.textContent=money(cart.subtotalCents||0);
if(meter&&threshold>0){meter.hidden=false;var left=Math.max(0,threshold-(cart.subtotalCents||0));var text=meter.querySelector("[data-cd-meter-text]");var bar=meter.querySelector("[data-cd-meter-bar]");if(text)text.textContent=left>0?("You're "+money(left)+" away from free shipping"):"You've unlocked free shipping";if(bar)bar.style.width=Math.min(100,Math.round(((cart.subtotalCents||0)/threshold)*100))+"%"}}
function refresh(){return fetch("/storefront/api/cart",{credentials:"same-origin"}).then(function(r){return r.ok?r.json():null}).then(function(d){render(d&&d.cart)}).catch(function(){})}
function open(){drawer.setAttribute("data-open","1");backdrop.setAttribute("data-open","1");refresh()}
function close(){drawer.removeAttribute("data-open");backdrop.removeAttribute("data-open")}
backdrop.addEventListener("click",close);var x=drawer.querySelector("[data-cd-drawer-close]");if(x)x.addEventListener("click",close);
document.addEventListener("click",function(e){var b=e.target&&e.target.closest?e.target.closest(".designer-add-to-cart"):null;if(!b)return;e.preventDefault();var v=b.getAttribute("data-variant-id");if(!v){open();return}
b.disabled=true;fetch("/storefront/api/cart/add",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({variantId:v,quantity:1})}).then(function(r){if(r.ok)open();else location.href="/storefront/cart"}).finally(function(){b.disabled=false})});
})();`;
