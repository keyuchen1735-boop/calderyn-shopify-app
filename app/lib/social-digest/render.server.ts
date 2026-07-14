// app/lib/social-digest/render.server.ts
//
// Renders carousel HTML documents to one PNG per `.slide` element (1080×1350 CSS
// px, captured at 2× for crisp posting). In production (Vercel/Lambda, Node 24)
// it uses the headless @sparticuz/chromium binary via the canonical v149 launch;
// locally it drives an installed Chrome so the pipeline can be smoke-tested off
// the cloud. One browser is reused across all documents to keep cold-start cost
// and memory down. Never returns partial state: resolves all buffers or rejects.

import type { Browser } from "puppeteer-core";
import { launchChromium } from "../browser/chromium.server";

const VIEWPORT = { width: 1080, height: 1350, deviceScaleFactor: 2 };

async function shoot(browser: Browser, html: string): Promise<Buffer[]> {
  const page = await browser.newPage();
  try {
    await page.setViewport(VIEWPORT);
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    // Wait for the webfont so headlines render in Inter, not a fallback.
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
    });
    const els = await page.$$(".slide");
    if (els.length === 0) throw new Error("renderSlideSets: no .slide elements found");
    const shots: Buffer[] = [];
    for (const el of els) {
      // puppeteer-core v25 returns a Uint8Array; wrap so .toString("base64") works.
      shots.push(Buffer.from(await el.screenshot({ type: "png" })));
    }
    return shots;
  } finally {
    await page.close();
  }
}

/**
 * Render each HTML document to its array of slide PNGs (in DOM order), reusing a
 * single browser. Returns one Buffer[] per input document, in input order.
 */
export async function renderSlideSets(htmls: string[]): Promise<Buffer[][]> {
  const browser = await launchChromium(VIEWPORT);
  try {
    const out: Buffer[][] = [];
    for (const html of htmls) {
      out.push(await shoot(browser, html));
    }
    return out;
  } finally {
    await browser.close();
  }
}
