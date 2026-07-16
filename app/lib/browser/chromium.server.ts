import { existsSync } from "node:fs";
import chromium from "@sparticuz/chromium";
import puppeteer, { type Browser, type Viewport } from "puppeteer-core";

chromium.setGraphicsMode = false;

export const LOCAL_CHROME_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
].filter(Boolean) as string[];

export function resolveLocalChromeExecutable(paths: readonly string[] = LOCAL_CHROME_PATHS): string | null {
  return paths.find((candidate) => {
    try { return existsSync(candidate); } catch { return false; }
  }) ?? null;
}

export async function launchChromium(defaultViewport?: Viewport): Promise<Browser> {
  const onCloud = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  if (onCloud) {
    return puppeteer.launch({
      args: await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
      ...(defaultViewport ? { defaultViewport } : {}),
      executablePath: await chromium.executablePath(),
      headless: "shell",
    });
  }
  const executablePath = resolveLocalChromeExecutable();
  if (!executablePath) {
    throw new Error("No local Chrome found. Set PUPPETEER_EXECUTABLE_PATH, or run on Vercel/AWS with @sparticuz/chromium.");
  }
  return puppeteer.launch({ executablePath, headless: true, ...(defaultViewport ? { defaultViewport } : {}) });
}
