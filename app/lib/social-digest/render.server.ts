// app/lib/social-digest/render.server.ts
//
// Renders carousel HTML documents to one PNG per `.slide` element (1080×1350 CSS
// px, captured at 2× for crisp posting). In production (Vercel/Lambda, Node 24)
// it uses the headless @sparticuz/chromium binary via the canonical v149 launch;
// locally it drives an installed Chrome so the pipeline can be smoke-tested off
// the cloud. One browser is reused across all documents to keep cold-start cost
// and memory down. Never returns partial state: resolves all buffers or rejects.

import puppeteer, { type Browser } from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const VIEWPORT = { width: 1080, height: 1350, deviceScaleFactor: 2 };

// Static slide screenshots need no WebGL/ANGLE — skip the swiftshader extract.
chromium.setGraphicsMode = false;

// Common local Chrome locations; overridable with PUPPETEER_EXECUTABLE_PATH.
const LOCAL_CHROME = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
].filter(Boolean) as string[];

async function launch(): Promise<Browser> {
  const onCloud = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  if (onCloud) {
    // Canonical @sparticuz/chromium v149 + puppeteer-core v25 launch.
    return puppeteer.launch({
      args: await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
      defaultViewport: VIEWPORT,
      executablePath: await chromium.executablePath(),
      headless: "shell",
    });
  }
  const fs = await import("node:fs");
  const exe = LOCAL_CHROME.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (!exe) {
    throw new Error(
      "No local Chrome found for rendering. Set PUPPETEER_EXECUTABLE_PATH, or run on Vercel where @sparticuz/chromium is used.",
    );
  }
  return puppeteer.launch({ executablePath: exe, headless: true, defaultViewport: VIEWPORT });
}

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
  const browser = await launch();
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
