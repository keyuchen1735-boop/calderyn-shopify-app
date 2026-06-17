// app/lib/social-digest/slides.server.ts
//
// Builds the LinkedIn + Instagram carousel HTML (4 slides each) from a SocialPack.
// Pure string building — no I/O, no deps — so it is trivially testable. The HTML
// is portable (logo + icons inlined as SVG, navy gradient instead of an external
// background image) and is rendered to PNG slides by render.server.ts.
//
// CSS/markup is the worked-out design from the social design pack (dark mode,
// navy gradient, cyan accent, faint hex motif, white monogram bottom-left).

export interface PackFeature {
  /** chart-title style headline for the slide */
  title: string;
  /** one short supporting line */
  support: string;
  /** the pill text (a number/proof or a short label) */
  metric: string;
}

export interface SocialPack {
  range: string; // e.g. "June 13–19, 2026"
  shippedCount: number; // merchant-facing things shipped this week
  waitlistDelta: number; // new waitlist signups this week
  linkedin: {
    coverA: string;
    coverB: string; // accented (cyan) second line
    features: [PackFeature, PackFeature];
    ctaHeadline: string;
  };
  instagram: {
    coverA: string;
    coverHi: string; // accented word inside the cover line
    coverB: string;
    bigNum: string; // e.g. "68th"
    bigLabel: string;
    feature: PackFeature;
    ctaHeadline: string;
  };
  linkedinCaption: string;
  instagramCaption: string;
}

const C = { navy: "#10293B", deep: "#081626", cyan: "#59C2D1", teal: "#2A7E87" };

const monogram = (id: string) =>
  `<svg viewBox="0 0 4096 4096" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Calderyn"><defs><mask id="${id}"><rect width="4096" height="4096" fill="#fff"/><path fill="#000" fill-rule="evenodd" d="M 2048,954.496 L 2995,1501.248 L 2995,2594.752 L 2048,3141.504 L 1101,2594.752 L 1101,1501.248 Z M 2048,1246.643 L 2742,1647.322 L 2742,2448.678 L 2048,2849.357 L 1354,2448.678 L 1354,1647.322 Z M 2742,1852 L 2995,1852 L 2995,2244 L 2742,2244 Z"/></mask></defs><polygon points="2048,535.337 3357.5,1291.668 3357.5,2804.332 2048,3560.663 738.5,2804.332 738.5,1291.668" fill="#FFFFFF" mask="url(#${id})"/></svg>`;

const ICONS: Record<string, string> = {
  bars: `<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="13" width="4" height="7" rx="1" fill="${C.cyan}"/><rect x="10" y="8" width="4" height="12" rx="1" fill="#fff"/><rect x="17" y="4" width="4" height="16" rx="1" fill="${C.teal}"/></svg>`,
  truck: `<svg viewBox="0 0 24 24" fill="none" stroke="${C.cyan}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h11v9H3z"/><path d="M14 9h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/></svg>`,
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const dots = (n: number, on: number) =>
  `<div class="dots">${Array.from({ length: n }, (_, i) => `<span class="dot${i === on ? " on" : ""}"></span>`).join("")}</div>`;

const hexfield = `<svg class="hex" viewBox="0 0 1080 1350" preserveAspectRatio="xMidYMid slice" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g stroke="${C.cyan}" stroke-width="2.2"><path d="M980,-140 L1300,40 L1300,420 L980,600 L660,420 L660,40 Z" stroke-opacity="0.16"/><path d="M980,-50 L1230,90 L1230,370 L980,510 L730,370 L730,90 Z" stroke-opacity="0.10"/><path d="M70,980 L250,1090 L250,1310 L70,1420 L-110,1310 L-110,1090 Z" stroke-opacity="0.09"/><path d="M1010,860 L1100,915 L1100,1025 L1010,1080 L920,1025 L920,915 Z" stroke-opacity="0.08"/></g></svg>`;

const css = `
  *{box-sizing:border-box;margin:0;padding:0;}
  body{margin:0;background:#000;font-family:"Inter","Avenir Next","Helvetica Neue",Arial,sans-serif;}
  .slide{position:relative;width:1080px;height:1350px;overflow:hidden;display:block;color:#fff;
    background:radial-gradient(120% 90% at 88% 8%, #1c4356 0%, ${C.navy} 46%, ${C.deep} 100%);}
  .hex{position:absolute;inset:0;z-index:0;pointer-events:none;}
  .inner{position:absolute;inset:0;z-index:1;padding:96px;display:flex;flex-direction:column;}
  .top{display:flex;align-items:center;gap:18px;}
  .eyebrow{font-size:25px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:${C.cyan};}
  .body{margin-top:auto;margin-bottom:auto;max-width:840px;}
  h1{font-size:92px;font-weight:800;line-height:1.06;letter-spacing:-.02em;}
  h2{font-size:64px;font-weight:800;line-height:1.12;letter-spacing:-.015em;max-width:820px;}
  .ig h1{font-size:104px;line-height:1.04;}
  p.support{margin-top:30px;font-size:33px;font-weight:400;line-height:1.5;color:#D7E2E6;max-width:740px;}
  .bignum{font-size:230px;font-weight:900;line-height:.9;letter-spacing:-.03em;color:${C.cyan};}
  .numlabel{font-size:33px;font-weight:500;color:#CFE0E4;margin-top:20px;max-width:680px;line-height:1.42;}
  .illus{display:inline-block;margin-top:26px;font-size:21px;font-weight:600;letter-spacing:.04em;color:#8FB6BE;text-transform:uppercase;}
  .chip{width:118px;height:118px;border-radius:26px;background:rgba(8,22,38,.6);
        border:1.5px solid rgba(89,194,209,.5);display:flex;align-items:center;justify-content:center;
        box-shadow:0 10px 30px rgba(0,0,0,.35);margin-bottom:40px;}
  .chip svg{width:66px;height:66px;display:block;}
  .pill{display:inline-flex;align-items:center;gap:14px;margin-top:34px;padding:16px 26px;border-radius:999px;
        background:rgba(89,194,209,.12);border:1px solid rgba(89,194,209,.4);font-size:27px;font-weight:600;color:#DCEef2;}
  .pill .led{width:14px;height:14px;border-radius:50%;background:${C.cyan};box-shadow:0 0 14px ${C.cyan};}
  .cta-line{font-size:42px;font-weight:600;color:#fff;margin-top:46px;}
  .cta-url{font-size:46px;font-weight:800;color:${C.cyan};}
  .foot{position:absolute;left:96px;right:96px;bottom:84px;z-index:1;display:flex;align-items:flex-end;justify-content:space-between;}
  .brand{display:flex;align-items:center;gap:16px;}
  .brand svg{height:60px;width:60px;display:block;}
  .wm{font-size:33px;font-weight:600;letter-spacing:.16em;color:#fff;}
  .swipe{font-size:26px;font-weight:600;color:#BFD3D8;}
  .dots{display:flex;gap:12px;}
  .dot{width:11px;height:11px;border-radius:50%;background:rgba(255,255,255,.35);}
  .dot.on{background:${C.cyan};}
`;

function slide(id: string, bodyHtml: string, footRight: string): string {
  return `<section class="slide">${hexfield}<div class="inner">${bodyHtml}</div><div class="foot"><span class="brand">${monogram(id)}<span class="wm">CALDERYN</span></span>${footRight}</div></section>`;
}

function page(cls: string, slides: string[]): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet"><style>${css}</style></head><body class="${cls}">${slides.join("")}</body></html>`;
}

function featureSlide(id: string, icon: string, f: PackFeature, dotEl: string): string {
  return slide(
    id,
    `<div class="body"><div class="chip">${ICONS[icon] ?? ICONS.bars}</div><h2>${esc(f.title)}</h2><p class="support">${esc(f.support)}</p><div class="pill"><span class="led"></span>${esc(f.metric)}</div></div>`,
    dotEl,
  );
}

export function buildCarousels(pack: SocialPack): { linkedinHtml: string; instagramHtml: string } {
  const li = pack.linkedin;
  const linkedinHtml = page("li", [
    slide(
      "li0",
      `<div class="top"><span class="eyebrow">Build in public · ${esc(pack.range)}</span></div><div class="body"><h1>${esc(li.coverA)}</h1><h1 style="color:${C.cyan}">${esc(li.coverB)}</h1></div>`,
      `<div class="swipe">Swipe →</div>`,
    ),
    featureSlide("li1", "bars", li.features[0], dots(4, 1)),
    featureSlide("li2", "truck", li.features[1], dots(4, 2)),
    slide(
      "li3",
      `<div class="body"><span class="eyebrow">Building in the open</span><h2 style="margin-top:24px">${esc(li.ctaHeadline)}</h2><div class="cta-line">Join them →</div><div class="cta-url">calderyncompany.com</div></div>`,
      dots(4, 3),
    ),
  ]);

  const ig = pack.instagram;
  const instagramHtml = page("ig", [
    slide(
      "ig0",
      `<div class="top"><span class="eyebrow">Calderyn · for Shopify</span></div><div class="body"><h1>${esc(ig.coverA)} <span style="color:${C.cyan}">${esc(ig.coverHi)}</span> ${esc(ig.coverB)}</h1></div>`,
      `<div class="swipe">Swipe →</div>`,
    ),
    slide(
      "ig1",
      `<div class="body"><span class="eyebrow">The honest answer</span><div class="bignum" style="margin-top:26px">${esc(ig.bigNum)}</div><div class="numlabel">${esc(ig.bigLabel)}</div><span class="illus">Illustrative · demo store</span></div>`,
      dots(4, 1),
    ),
    featureSlide("ig2", "truck", ig.feature, dots(4, 2)),
    slide(
      "ig3",
      `<div class="body"><h2>${esc(ig.ctaHeadline)}</h2><div class="cta-line">Join the waitlist →</div><div class="cta-url">calderyncompany.com</div></div>`,
      dots(4, 3),
    ),
  ]);

  return { linkedinHtml, instagramHtml };
}
