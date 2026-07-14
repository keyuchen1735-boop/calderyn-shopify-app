import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import type { Browser, HTTPRequest, Page } from "puppeteer-core";
import { launchChromium } from "../browser/chromium.server";
import type { BrowserProofReport, MaterializedAssetResult, MerchantStorefrontContext } from "../storefront-ai/contracts";
import type { StorefrontBundleV1, StorefrontRouteId } from "../storefront-bundle/types";
import { StorefrontPolicyPage } from "../storefront/policy-page";
import { resolveStorefrontPolicyPath, type StorefrontPolicy } from "../storefront/policies.server";
import { renderStorefrontSurface } from "../storefront-runtime/render.server";
import type { PublicPresentationData, PublicProduct } from "../storefront-runtime/public-data.server";
import { createStorefrontProofData, storefrontProofPolicies } from "./fixtures";
import { verifyStorefrontPolicyRoutes } from "./policy-routes";
import {
  createBrowserProofReport,
  type StorefrontBrowserDiagnostic,
  type StorefrontBrowserMetrics,
  type StorefrontBrowserProofReport,
  type StorefrontProofViewportName,
} from "./report";

export const STOREFRONT_PROOF_VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 1000 },
] as const;

export const STOREFRONT_PROOF_ROUTES = ["home", "collection", "product", "search", "cart", "checkout"] as const;

const PROOF_ORIGIN = "https://storefront-proof.local";
const PROOF_NONCE = "storefront-proof-nonce";
const ROUTE_BYTES_LIMIT = 250 * 1024;
const INTERACTION_BYTES_LIMIT = 40 * 1024;
const FULL_BUNDLE_BYTES_LIMIT = 1.5 * 1024 * 1024;
const STOREFRONT_PROOF_ROUTE_RE = /^\/storefront(?:\/(?:collections|products|search|cart|checkout|account)(?:[/?#].*)?|\/policies\/(?:privacy|terms|refund|shipping)\/?(?:[?#].*)?)?$/;
let proofRuntimeSource: Promise<string> | undefined;

export function isSupportedStorefrontProofLink(href: string): boolean {
  return STOREFRONT_PROOF_ROUTE_RE.test(href);
}

export interface StorefrontProofCase {
  routeId: StorefrontRouteId;
  viewport: (typeof STOREFRONT_PROOF_VIEWPORTS)[number];
}

export interface StorefrontProofArtifacts {
  baselineDirectory?: string;
  previewFile?: string;
  updateBaselines?: boolean;
}

export interface ProveStorefrontBundleInput {
  bundle: StorefrontBundleV1;
  context?: MerchantStorefrontContext;
  persistedAssets?: MaterializedAssetResult["proofAssets"];
  signal?: AbortSignal;
  timeoutMs?: number;
  browser?: Browser;
  artifacts?: StorefrontProofArtifacts;
  onProgress?: (event: { routeId: StorefrontRouteId; viewport: StorefrontProofViewportName; completed: number; total: number }) => void;
}

export interface ProveStorefrontBundleResult extends StorefrontBrowserProofReport {
  screenshotManifest: Array<{
    routeId: StorefrontRouteId;
    viewport: StorefrontProofViewportName;
    sha256: string;
    baseline?: string;
    pixelDiffRatio?: number;
  }>;
}

export function buildStorefrontProofCases(_bundle: StorefrontBundleV1): StorefrontProofCase[] {
  return STOREFRONT_PROOF_ROUTES.flatMap((routeId) =>
    STOREFRONT_PROOF_VIEWPORTS.map((viewport) => ({ routeId, viewport })),
  );
}

function routeBytes(bundle: StorefrontBundleV1, routeId: StorefrontRouteId): number {
  const artifact = bundle.routes[routeId];
  if (routeId === "checkout") {
    const checkout = artifact as StorefrontBundleV1["routes"]["checkout"];
    return Buffer.byteLength(checkout.decorativeHtml) + Buffer.byteLength(checkout.decorativeCss);
  }
  const route = artifact as StorefrontBundleV1["routes"][Exclude<StorefrontRouteId, "checkout">];
  return Buffer.byteLength(route.html) + Buffer.byteLength(route.css);
}

function interactionBytes(bundle: StorefrontBundleV1, routeId: StorefrontRouteId): number {
  if (routeId === "checkout") return 0;
  return Buffer.byteLength(JSON.stringify(bundle.routes[routeId].interactions));
}

export function measureStorefrontBundle(bundle: StorefrontBundleV1): StorefrontBrowserMetrics {
  return {
    routeHtmlCssBytes: Object.fromEntries(STOREFRONT_PROOF_ROUTES.map((routeId) => [routeId, routeBytes(bundle, routeId)])),
    interactionBytes: Object.fromEntries(STOREFRONT_PROOF_ROUTES.map((routeId) => [routeId, interactionBytes(bundle, routeId)])),
    fullBundleBytes: Buffer.byteLength(JSON.stringify(bundle)),
  };
}

export function validateStorefrontBundleBudgets(bundle: StorefrontBundleV1): StorefrontBrowserProofReport {
  const metrics = measureStorefrontBundle(bundle);
  const diagnostics: StorefrontBrowserDiagnostic[] = [];
  for (const routeId of STOREFRONT_PROOF_ROUTES) {
    const bytes = metrics.routeHtmlCssBytes[routeId] ?? 0;
    if (bytes > ROUTE_BYTES_LIMIT) diagnostics.push({
      routeId,
      code: "budget.route-bytes",
      message: `Compiled HTML and CSS is ${bytes} bytes; limit is ${ROUTE_BYTES_LIMIT}`,
      severity: "serious",
      detail: { actual: bytes, limit: ROUTE_BYTES_LIMIT },
    });
    const manifestBytes = metrics.interactionBytes[routeId] ?? 0;
    if (manifestBytes > INTERACTION_BYTES_LIMIT) diagnostics.push({
      routeId,
      code: "budget.interactions",
      message: `Interaction manifest is ${manifestBytes} bytes; limit is ${INTERACTION_BYTES_LIMIT}`,
      severity: "serious",
      detail: { actual: manifestBytes, limit: INTERACTION_BYTES_LIMIT },
    });
  }
  if (metrics.fullBundleBytes > FULL_BUNDLE_BYTES_LIMIT) diagnostics.push({
    routeId: "home",
    code: "budget.bundle-bytes",
    message: `Bundle is ${metrics.fullBundleBytes} bytes; limit is ${FULL_BUNDLE_BYTES_LIMIT}`,
    severity: "serious",
    detail: { actual: metrics.fullBundleBytes, limit: FULL_BUNDLE_BYTES_LIMIT },
  });
  return createBrowserProofReport({ diagnostics, screenshots: [], browserMs: 0, metrics });
}

function presentContextProduct(entry: MerchantStorefrontContext["products"][number], index: number): PublicProduct {
  const fixture = createStorefrontProofData("product").product!;
  const image = entry.images.length === 0 ? null : {
    url: `${PROOF_ORIGIN}/__proof__/catalog/context-${index + 1}.svg`,
    alt: `${entry.title} product photograph`,
  };
  const available = entry.availability !== "sold_out";
  return {
    ...fixture,
    id: entry.id,
    handle: entry.handle,
    title: entry.title,
    primaryImage: image,
    images: image ? [image] : [],
    options: entry.optionNames.map((name) => ({ name, values: ["Default"] })),
    variants: [{
      id: `${entry.id}-variant`,
      title: "Default",
      price: { cents: entry.priceMin, currency: entry.currency },
      compareAtPrice: entry.priceMax > entry.priceMin ? { cents: entry.priceMax, currency: entry.currency } : null,
      availability: available ? "In stock" : "Sold out",
      available,
    }],
    price: { cents: entry.priceMin, currency: entry.currency },
    compareAtPrice: entry.priceMax > entry.priceMin ? { cents: entry.priceMax, currency: entry.currency } : null,
    availability: available ? "In stock" : "Sold out",
  };
}

function dataForCase(routeId: StorefrontRouteId, context?: MerchantStorefrontContext): PublicPresentationData {
  const fixture = createStorefrontProofData(routeId);
  if (!context) return fixture;
  const products = context.products.map(presentContextProduct);
  const active = products[0] ?? fixture.product;
  return {
    ...fixture,
    store: { name: context.store.name, logo: null },
    product: routeId === "product" ? active : null,
    featuredProducts: products.length ? products.slice(0, 12) : fixture.featuredProducts,
    relatedProducts: products.length ? products.slice(1, 9) : fixture.relatedProducts,
    collection: routeId === "collection" ? {
      ...(fixture.collection!),
      id: context.collections[0]?.id ?? "proof-collection",
      handle: context.collections[0]?.handle ?? "proof-collection",
      title: context.collections[0]?.title ?? "Catalog",
      productCount: context.collections[0]?.productCount ?? products.length,
      products,
    } : null,
  };
}

function checkoutSimulation() {
  return createElement(Fragment, null,
    createElement("label", null, "Email", createElement("input", { type: "email", name: "email", autoComplete: "email" })),
    createElement("button", { type: "button", "data-cd-proof-checkout": "continue" }, "Continue to payment"),
  );
}

function routeMarkup(
  bundle: StorefrontBundleV1,
  routeId: StorefrontRouteId,
  data: PublicPresentationData,
  mode: "public" | "preview",
  customAssetUrls?: Readonly<Record<string, string>>,
): string {
  return renderToStaticMarkup(renderStorefrontSurface({
    bundle,
    routeId,
    data,
    nonce: PROOF_NONCE,
    mode,
    customAssetUrls,
    checkoutContent: routeId === "checkout" ? checkoutSimulation() : undefined,
  }));
}

function normalizeParityMarkup(html: string): string {
  return html.replace(/href="[^"]*"/g, 'href="__ROUTE__"');
}

function documentHtml(markup: string, title: string): string {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${PROOF_NONCE}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    `script-src 'nonce-${PROOF_NONCE}'`,
    "frame-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "form-action 'self'",
    "base-uri 'self'",
  ].join("; ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><base href="${PROOF_ORIGIN}/"><link rel="icon" href="data:,"><title>${title.replace(/[<>&]/g, "")}</title><style nonce="${PROOF_NONCE}">html{background:#fff;color:#111}body{margin:0;min-height:100vh}img{max-width:100%}:focus-visible{outline:3px solid #0b57d0!important;outline-offset:3px!important}[data-cd-trusted-slot]{display:block;min-width:44px;min-height:44px}</style></head><body>${markup}</body></html>`;
}

function browserRuntimeSource(): Promise<string> {
  proofRuntimeSource ??= build({
    entryPoints: [resolve(process.cwd(), "app/lib/storefront-validation/browser-runtime.client.ts")],
    absWorkingDir: process.cwd(),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome120"],
    write: false,
    alias: { "~": resolve(process.cwd(), "app") },
  }).then((result) => result.outputFiles[0]?.text ?? Promise.reject(new Error("Storefront proof runtime bundle is empty")));
  return proofRuntimeSource;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function proofSvg(pathname: string): string {
  const hue = Number.parseInt(createHash("sha256").update(pathname).digest("hex").slice(0, 4), 16) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900"><rect width="1200" height="900" fill="hsl(${hue} 35% 88%)"/><circle cx="860" cy="260" r="210" fill="hsl(${(hue + 55) % 360} 50% 58%)"/><path d="M120 710L430 240l270 470z" fill="hsl(${(hue + 180) % 360} 45% 38%)"/><text x="80" y="830" font-family="sans-serif" font-size="34" fill="#111">Northline proof catalog image</text></svg>`;
}

async function serveProofRequest(
  request: HTTPRequest,
  unexpected: string[],
  runtimeSource: string,
  ownedAssets: ReadonlyMap<string, { mediaType: string; bytes: Uint8Array }>,
  policies: ReadonlyMap<string, StorefrontPolicy>,
  storeName: string,
): Promise<void> {
  const url = request.url();
  if (url.startsWith("data:") || url === "about:blank") {
    await request.continue();
    return;
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch {
    unexpected.push(url);
    await request.abort("blockedbyclient");
    return;
  }
  if (parsed.origin !== PROOF_ORIGIN) {
    unexpected.push(url);
    await request.abort("blockedbyclient");
    return;
  }
  if (parsed.pathname === "/__proof__/runtime.js") {
    await request.respond({ status: 200, contentType: "text/javascript; charset=utf-8", body: runtimeSource });
    return;
  }
  const policyId = resolveStorefrontPolicyPath(parsed.pathname);
  const policy = policyId ? policies.get(policyId) : undefined;
  if (policy) {
    const markup = renderToStaticMarkup(createElement(StorefrontPolicyPage, {
      policy,
      store: { name: storeName, logo: null },
    }));
    await request.respond({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: documentHtml(markup, `${policy.title} — ${storeName}`),
    });
    return;
  }
  const ownedAsset = ownedAssets.get(parsed.pathname);
  if (ownedAsset) {
    await request.respond({ status: 200, contentType: ownedAsset.mediaType, body: Buffer.from(ownedAsset.bytes) });
    return;
  }
  if (parsed.pathname.startsWith("/__proof__/")) {
    await request.respond({ status: 200, contentType: "image/svg+xml", body: proofSvg(parsed.pathname) });
    return;
  }
  const publicRoot = resolve(process.cwd(), "public");
  const filePath = resolve(publicRoot, `.${decodeURIComponent(parsed.pathname)}`);
  if (!filePath.startsWith(`${publicRoot}${sep}`)) {
    unexpected.push(url);
    await request.respond({ status: 403, body: "Forbidden" });
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    await request.respond({ status: 200, contentType: MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream", body: await readFile(filePath) });
  } catch {
    await request.respond({ status: 404, body: "Not found" });
  }
}

async function axeSource(): Promise<string> {
  const require = createRequire(import.meta.url);
  return readFile(require.resolve("axe-core/axe.min.js"), "utf8");
}

interface PageAuditResult {
  axe: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: unknown; html: string; failureSummary?: string }> }>;
  imageFailures: string[];
  deadLinks: string[];
  unresolvedBindings: string[];
  inertControls: string[];
  protectedFailures: string[];
  commerceFailures: string[];
  checkoutFailures: string[];
  shellStyleFailures: string[];
  focusableCount: number;
  reducedMotion: boolean;
  cls: number;
  lcp: number;
  longTask: number;
}

async function auditPage(page: Page, bundle: StorefrontBundleV1, routeId: StorefrontRouteId, axe: string): Promise<PageAuditResult> {
  const route = routeId === "checkout" ? null : bundle.routes[routeId];
  await page.evaluate(axe);
  return page.evaluate(async ({ transitions, route, supportedRoutePattern }) => {
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const axeApi = (globalThis as unknown as { axe: { run(root: Document, options: unknown): Promise<{ violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: unknown; html: string; failureSummary?: string }> }> }> } }).axe;
    const axeResult = await axeApi.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      resultTypes: ["violations"],
    });
    const images = [...document.images];
    const imageFailures = images.filter((image) => Boolean(image.currentSrc || image.getAttribute("src")) && image.complete && image.naturalWidth === 0).map((image) => image.currentSrc || image.src);
    const allowed = new RegExp(supportedRoutePattern);
    const deadLinks = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
      .filter((link) => !link.closest("[data-cd-platform-content='policyLinks']"))
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => href !== "#" && href.startsWith("/") && !allowed.test(href));
    const unresolvedBindings = [...document.querySelectorAll<HTMLElement>("[data-cd-text],[data-cd-money],[data-cd-src],[data-cd-alt],[data-cd-repeat]")]
      .map((element) => element.id || element.tagName.toLowerCase());
    const sources = new Set((transitions as Array<{ sourceId: string }>).map((entry) => entry.sourceId));
    const inertControls = [...document.querySelectorAll<HTMLElement>("button,input,select,textarea")]
      .filter((element) => visible(element) && !element.closest("[data-cd-trusted-slot]") && !element.closest("[data-cd-checkout-platform-root]"))
      .filter((element) => !sources.has(element.id.replace(/-i-[a-z0-9]+$/, "")))
      .map((element) => element.id || element.outerHTML.slice(0, 120));
    const protectedFailures = [...document.querySelectorAll<HTMLElement>("[data-cd-trusted-slot]")].flatMap((host) => {
      host.scrollIntoView({ block: "center" });
      const rect = host.getBoundingClientRect();
      const x = Math.min(innerWidth - 1, Math.max(0, rect.left + Math.min(rect.width / 2, 20)));
      const y = Math.min(innerHeight - 1, Math.max(0, rect.top + Math.min(rect.height / 2, 20)));
      const hit = document.elementFromPoint(x, y);
      return visible(host) && hit && (hit === host || host.contains(hit)) ? [] : [host.id || host.dataset.cdTrustedSlot || "trusted-slot"];
    });
    const commerceFailures = [...document.querySelectorAll<HTMLElement>("[data-cd-trusted-slot]")].flatMap((host) => {
      const controls = [...(host.shadowRoot?.querySelectorAll<HTMLElement>("button,input,select") ?? [])];
      if (!host.shadowRoot) return [`${host.id || host.dataset.cdTrustedSlot}:closed-or-missing-root`];
      if (controls.length === 0) return [`${host.id || host.dataset.cdTrustedSlot}:missing-control`];
      return controls.flatMap((control) => {
        const style = getComputedStyle(control);
        const rect = control.getBoundingClientRect();
        return visible(control) && rect.width >= 44 && rect.height >= 44 && style.backgroundColor !== "rgba(0, 0, 0, 0)"
          ? []
          : [`${host.id || host.dataset.cdTrustedSlot}:${control.tagName.toLowerCase()}:unstyled`];
      });
    });
    const checkoutFailures = route === "checkout"
      ? [
          document.querySelectorAll("[data-cd-checkout-section]").length === 6 ? "" : "missing-six-sections",
          document.querySelector("[data-cd-checkout-platform-root] button") ? "" : "missing-platform-checkout-control",
        ].filter(Boolean)
      : [];
    const shell = document.querySelector<HTMLElement>("[data-cd-bundle='shell']");
    const shellHeader = shell?.querySelector<HTMLElement>("header");
    const shellNav = shellHeader?.querySelector<HTMLElement>("nav");
    const shellLink = shellNav?.querySelector<HTMLElement>("a[href]");
    const shellStyleFailures: string[] = [];
    if (!shell || !shellHeader || !shellNav || !shellLink) {
      shellStyleFailures.push("missing-shell-header-nav-link");
    } else {
      const navStyle = getComputedStyle(shellNav);
      const linkStyle = getComputedStyle(shellLink);
      const headerHeight = shellHeader.getBoundingClientRect().height;
      if (navStyle.display !== "flex" && navStyle.display !== "grid") {
        shellStyleFailures.push(`nav-display:${navStyle.display}`);
      }
      if (headerHeight < 44) shellStyleFailures.push(`header-height:${headerHeight.toFixed(1)}px`);
      if (linkStyle.color === "rgb(0, 0, 238)") shellStyleFailures.push("nav-link-default-blue");
      if (linkStyle.textDecorationLine !== "none") shellStyleFailures.push(`nav-link-decoration:${linkStyle.textDecorationLine}`);
    }
    for (const link of shell?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? []) {
      const style = getComputedStyle(link);
      const label = link.textContent?.trim().slice(0, 40) || link.id || "shell-link";
      if (style.color === "rgb(0, 0, 238)") shellStyleFailures.push(`link-default-blue:${label}`);
      if (style.textDecorationLine !== "none") shellStyleFailures.push(`link-decoration:${label}:${style.textDecorationLine}`);
    }
    const policyLinks = [...(shell?.querySelectorAll<HTMLAnchorElement>("[data-cd-platform-content='policyLinks'] a") ?? [])];
    const policyParents = new Set(policyLinks.map((link) => link.parentElement).filter((parent): parent is HTMLElement => Boolean(parent)));
    for (const parent of policyParents) {
      const display = getComputedStyle(parent).display;
      if (display !== "flex" && display !== "grid") shellStyleFailures.push(`policy-layout:${display}`);
    }
    const lightFocusable = [...document.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(visible).length;
    const shadowFocusable = [...document.querySelectorAll<HTMLElement>("[data-cd-trusted-slot]")]
      .flatMap((host) => [...(host.shadowRoot?.querySelectorAll<HTMLElement>("button,input,select,textarea") ?? [])])
      .filter(visible).length;
    const focusableCount = lightFocusable + shadowFocusable;
    const shifts = performance.getEntriesByType("layout-shift") as Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>;
    const paints = performance.getEntriesByType("largest-contentful-paint") as Array<PerformanceEntry & { startTime: number }>;
    const tasks = performance.getEntriesByType("longtask") as Array<PerformanceEntry & { duration: number }>;
    return {
      axe: axeResult.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious").map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.slice(0, 8).map((node) => ({ target: node.target, html: node.html, ...(node.failureSummary ? { failureSummary: node.failureSummary } : {}) })),
      })),
      imageFailures,
      deadLinks,
      unresolvedBindings,
      inertControls,
      protectedFailures,
      commerceFailures,
      checkoutFailures,
      shellStyleFailures,
      focusableCount,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      cls: shifts.filter((entry) => !entry.hadRecentInput).reduce((sum, entry) => sum + (entry.value ?? 0), 0),
      lcp: paints.at(-1)?.startTime ?? 0,
      longTask: Math.max(0, ...tasks.map((entry) => entry.duration)),
    };
  }, {
    transitions: route?.interactions.transitions ?? [],
    route: routeId,
    supportedRoutePattern: STOREFRONT_PROOF_ROUTE_RE.source,
  });
}

async function pixelDiffRatio(page: Page, current: Buffer, baseline: Buffer): Promise<number> {
  return page.evaluate(async ({ currentUrl, baselineUrl }) => {
    const pixels = async (url: string) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(image, 0, 0);
      return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const [left, right] = await Promise.all([pixels(currentUrl), pixels(baselineUrl)]);
    if (left.width !== right.width || left.height !== right.height) return 1;
    let changed = 0;
    for (let index = 0; index < left.data.length; index += 4) {
      if (Math.abs(left.data[index] - right.data[index]) > 8 ||
          Math.abs(left.data[index + 1] - right.data[index + 1]) > 8 ||
          Math.abs(left.data[index + 2] - right.data[index + 2]) > 8 ||
          Math.abs(left.data[index + 3] - right.data[index + 3]) > 8) changed += 1;
    }
    return changed / (left.width * left.height);
  }, {
    currentUrl: `data:image/webp;base64,${current.toString("base64")}`,
    baselineUrl: `data:image/webp;base64,${baseline.toString("base64")}`,
  });
}

function addDiagnostic(
  list: StorefrontBrowserDiagnostic[],
  routeId: StorefrontRouteId,
  viewport: StorefrontProofViewportName,
  code: string,
  message: string,
  detail?: Record<string, unknown>,
): void {
  list.push({ routeId, viewport, code, message, severity: "serious", ...(detail ? { detail } : {}) });
}

export async function proveStorefrontBundle(input: ProveStorefrontBundleInput): Promise<ProveStorefrontBundleResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1, input.timeoutMs ?? 60_000);
  const deadlineAt = startedAt + timeoutMs;
  const assertActive = (): void => {
    if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Browser proof cancelled", "AbortError");
    if (Date.now() >= deadlineAt) throw new DOMException(`Browser proof exceeded its ${timeoutMs}ms deadline`, "TimeoutError");
  };
  const diagnostics = [...validateStorefrontBundleBudgets(input.bundle).diagnostics];
  const ownedAssets = new Map<string, { mediaType: string; bytes: Uint8Array }>();
  const customAssetUrls: Record<string, string> = {};
  if (input.bundle.source.kind === "custom") {
    const provided = new Map((input.persistedAssets ?? []).map((asset) => [asset.logicalKey, asset]));
    for (const entry of input.bundle.assets.entries) {
      const asset = provided.get(entry.key);
      if (!asset) {
        const derivedTemplateId = input.bundle.source.derivedFromTemplateId;
        if (derivedTemplateId && entry.mediaType === "image/webp") {
          try {
            const publicBytes = await readFile(resolve(process.cwd(), `public/storefront-recipes/${derivedTemplateId}/${entry.key}.webp`));
            if (publicBytes.byteLength === entry.byteSize && createHash("sha256").update(publicBytes).digest("hex") === entry.contentHash) {
              customAssetUrls[entry.key] = `/storefront-recipes/${derivedTemplateId}/${entry.key}.webp`;
              continue;
            }
          } catch {
            // Fall through to the fail-closed persisted-asset diagnostic.
          }
        }
        addDiagnostic(diagnostics, "home", "desktop", "asset.persisted-missing", `Custom asset ${entry.key} has no verified persisted proof bytes`);
        continue;
      }
      const bytes = asset.bytes instanceof Uint8Array ? asset.bytes : new Uint8Array();
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      if (asset.key !== entry.key || asset.mediaType !== entry.mediaType || asset.byteSize !== bytes.byteLength ||
          asset.contentHash !== entry.contentHash || contentHash !== entry.contentHash) {
        addDiagnostic(diagnostics, "home", "desktop", "asset.persisted-mismatch", `Custom asset ${entry.key} failed immutable manifest verification`);
        continue;
      }
      const pathname = `/__proof__/owned-assets/${encodeURIComponent(entry.key)}`;
      ownedAssets.set(pathname, { mediaType: entry.mediaType, bytes });
      customAssetUrls[entry.key] = `${PROOF_ORIGIN}${pathname}`;
    }
  }
  const screenshots: string[] = [];
  const screenshotManifest: ProveStorefrontBundleResult["screenshotManifest"] = [];
  const metrics = measureStorefrontBundle(input.bundle);
  const ownBrowser = !input.browser;
  const browser = input.browser ?? await launchChromium();
  const page = await browser.newPage();
  page.setDefaultTimeout(Math.min(30_000, timeoutMs));
  page.setDefaultNavigationTimeout(Math.min(30_000, timeoutMs));
  const unexpectedRequests: string[] = [];
  const consoleErrors: string[] = [];
  const requestFailures: string[] = [];
  const axe = await axeSource();
  const runtimeSource = await browserRuntimeSource();
  const proofPolicies = new Map(storefrontProofPolicies().map((policy) => [policy.id, policy]));
  const proofStoreName = input.context?.store.name ?? createStorefrontProofData("home").store.name;
  let currentUnexpected: string[] = [];
  let currentConsole: string[] = [];
  let currentFailures: string[] = [];
  let currentDocument = "";
  page.on("request", (request) => {
    const parsed = new URL(request.url());
    if (parsed.origin === PROOF_ORIGIN && parsed.pathname === "/__proof__/document") {
      void request.respond({ status: 200, contentType: "text/html; charset=utf-8", body: currentDocument });
      return;
    }
    void serveProofRequest(request, currentUnexpected, runtimeSource, ownedAssets, proofPolicies, proofStoreName);
  });
  page.on("console", (message) => {
    if (message.type() === "error") currentConsole.push(message.text());
  });
  page.on("pageerror", (error) => currentConsole.push(error instanceof Error ? error.message : String(error)));
  page.on("requestfailed", (request) => currentFailures.push(`${request.url()}: ${request.failure()?.errorText ?? "failed"}`));
  await page.setRequestInterception(true);
  try {
    const proofCases = buildStorefrontProofCases(input.bundle);
    for (const [caseIndex, proofCase] of proofCases.entries()) {
      assertActive();
      const { routeId, viewport } = proofCase;
      currentUnexpected = [];
      currentConsole = [];
      currentFailures = [];
      const data = dataForCase(routeId, input.context);
      let publicMarkup: string;
      let previewMarkup: string;
      try {
        publicMarkup = routeMarkup(input.bundle, routeId, data, "public", customAssetUrls);
        previewMarkup = routeMarkup(input.bundle, routeId, data, "preview", customAssetUrls);
      } catch (error) {
        addDiagnostic(diagnostics, routeId, viewport.name, "render.exception", error instanceof Error ? error.message : String(error));
        continue;
      }
      if (normalizeParityMarkup(publicMarkup) !== normalizeParityMarkup(previewMarkup)) {
        addDiagnostic(diagnostics, routeId, viewport.name, "preview-public.parity", "Preview and public render trees differ outside platform-owned route destinations");
      }
      await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      currentDocument = documentHtml(publicMarkup, `${input.bundle.concept.name} — ${routeId}`);
      await page.goto(`${PROOF_ORIGIN}/__proof__/document?route=${routeId}&viewport=${viewport.name}`, {
        waitUntil: "networkidle0",
        timeout: Math.max(1, Math.min(30_000, deadlineAt - Date.now())),
      });
      await page.evaluate(async () => {
        if (document.fonts?.ready) await document.fonts.ready;
        scrollTo(0, document.body.scrollHeight);
        await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
        scrollTo(0, 0);
      });
      await page.evaluate(async ({ proofNonce, proofOrigin, proofBundle, proofRouteId, proofData }) => {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function proofOpenShadow(init: ShadowRootInit): ShadowRoot {
          return originalAttachShadow.call(this, { ...init, mode: "open" });
        };
        const script = document.createElement("script");
        script.nonce = proofNonce;
        script.src = `${proofOrigin}/__proof__/runtime.js`;
        const loaded = new Promise<void>((resolveLoaded, rejectLoaded) => {
          script.addEventListener("load", () => resolveLoaded(), { once: true });
          script.addEventListener("error", () => rejectLoaded(new Error("Storefront proof runtime failed to load")), { once: true });
        });
        document.head.append(script);
        await loaded;
        const hydrate = (window as typeof window & {
          __CD_HYDRATE_STOREFRONT_PROOF__?: (input: {
            bundle: StorefrontBundleV1;
            routeId: StorefrontRouteId;
            data: PublicPresentationData;
          }) => { shellHydrated: boolean; routeHydrated: boolean };
        }).__CD_HYDRATE_STOREFRONT_PROOF__;
        if (!hydrate) throw new Error("Storefront proof hydrator is unavailable");
        const result = hydrate({ bundle: proofBundle, routeId: proofRouteId, data: proofData });
        if (!result.shellHydrated || !result.routeHydrated) throw new Error("Storefront proof hydration did not complete");
        await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      }, {
        proofNonce: PROOF_NONCE,
        proofOrigin: PROOF_ORIGIN,
        proofBundle: input.bundle,
        proofRouteId: routeId,
        proofData: data,
      });
      assertActive();
      const commerceExerciseFailures = await page.evaluate(() => {
        const failures: string[] = [];
        for (const host of document.querySelectorAll<HTMLElement>("[data-cd-trusted-slot]")) {
          const control = host.shadowRoot?.querySelector<HTMLElement>("button,select,input");
          if (!control) {
            failures.push(`${host.id || host.dataset.cdTrustedSlot}:missing-control`);
            continue;
          }
          if (control.matches(":disabled")) continue;
          if (control instanceof HTMLSelectElement || control instanceof HTMLInputElement) {
            control.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          } else {
            control.click();
          }
        }
        return failures;
      });
      const consoleBeforeAxe = [...currentConsole];
      const audit = await auditPage(page, input.bundle, routeId, axe);
      assertActive();
      const policyRouteFailures = await verifyStorefrontPolicyRoutes(
        await page.$$eval("[data-cd-platform-content='policyLinks'] a[href]", (links) => links.map((link) => {
          const anchor = link as HTMLAnchorElement;
          return {
            id: new URL(anchor.href).pathname.split("/").at(-1) ?? "",
            href: anchor.getAttribute("href") ?? "",
          };
        })),
        (href) => page.evaluate(async (policyHref) => {
          const response = await fetch(policyHref, { credentials: "omit", redirect: "manual" });
          const contentType = response.headers.get("content-type") ?? "";
          const html = await response.text();
          const policyDocument = new DOMParser().parseFromString(html, "text/html");
          return {
            status: response.status,
            contentType,
            policyId: policyDocument.querySelector<HTMLElement>("[data-cd-storefront-policy]")?.dataset.cdStorefrontPolicy ?? null,
          };
        }, href),
      );
      assertActive();
      // axe temporarily applies inline styles while computing contrast. Those
      // sandbox mutations are not storefront CSP violations and are discarded;
      // navigation/resource/runtime console errors captured before axe remain.
      currentConsole = consoleBeforeAxe;
      if (audit.axe.length) addDiagnostic(diagnostics, routeId, viewport.name, "axe.serious", `${audit.axe.length} serious or critical axe violation groups`, { violations: audit.axe });
      if (audit.imageFailures.length) addDiagnostic(diagnostics, routeId, viewport.name, "asset.failed", "Required images failed to load", { assets: audit.imageFailures });
      if (audit.deadLinks.length) addDiagnostic(diagnostics, routeId, viewport.name, "link.dead", "Internal links escaped the supported storefront route matrix", { links: audit.deadLinks });
      if (audit.unresolvedBindings.length) addDiagnostic(diagnostics, routeId, viewport.name, "binding.unresolved", "Compiler binding attributes survived into the rendered DOM", { nodes: audit.unresolvedBindings });
      if (audit.inertControls.length) addDiagnostic(diagnostics, routeId, viewport.name, "control.inert", "Visible controls lack a compiled action", { controls: audit.inertControls });
      if (audit.protectedFailures.length) addDiagnostic(diagnostics, routeId, viewport.name, "hit-test.protected", "Protected commerce hosts are not visible and hit-testable", { hosts: audit.protectedFailures });
      if (commerceExerciseFailures.length || audit.commerceFailures.length) addDiagnostic(diagnostics, routeId, viewport.name, "commerce.runtime", "Trusted commerce controls did not hydrate, style, or execute", { failures: [...commerceExerciseFailures, ...audit.commerceFailures] });
      if (audit.checkoutFailures.length) addDiagnostic(diagnostics, routeId, viewport.name, "checkout.boundary", "Checkout platform boundary is incomplete", { failures: audit.checkoutFailures });
      if (audit.shellStyleFailures.length) addDiagnostic(diagnostics, routeId, viewport.name, "shell.unstyled", "Storefront shell retains raw browser navigation styling", { failures: audit.shellStyleFailures });
      if (policyRouteFailures.length) addDiagnostic(diagnostics, routeId, viewport.name, "policy.route", "Merchant policy links do not resolve to matching same-origin storefront policy pages", { failures: policyRouteFailures });
      if (audit.focusableCount === 0) addDiagnostic(diagnostics, routeId, viewport.name, "keyboard.empty", "Route has no keyboard-focusable navigation or commerce control");
      if (!audit.reducedMotion) addDiagnostic(diagnostics, routeId, viewport.name, "motion.preference", "Reduced-motion media preference was not active");
      if (audit.cls >= 0.1) addDiagnostic(diagnostics, routeId, viewport.name, "performance.cls", `CLS ${audit.cls.toFixed(3)} exceeds 0.10`);
      if (audit.lcp >= 2_500) addDiagnostic(diagnostics, routeId, viewport.name, "performance.lcp", `LCP ${Math.round(audit.lcp)}ms exceeds 2500ms`);
      if (audit.longTask > 50) addDiagnostic(diagnostics, routeId, viewport.name, "performance.long-task", `Long task ${Math.round(audit.longTask)}ms exceeds 50ms`);
      metrics.maxCumulativeLayoutShift = Math.max(metrics.maxCumulativeLayoutShift ?? 0, audit.cls);
      metrics.maxLargestContentfulPaintMs = Math.max(metrics.maxLargestContentfulPaintMs ?? 0, audit.lcp);
      metrics.maxLongTaskMs = Math.max(metrics.maxLongTaskMs ?? 0, audit.longTask);
      if (currentUnexpected.length) addDiagnostic(diagnostics, routeId, viewport.name, "network.unexpected", "Unexpected external requests were blocked", { requests: currentUnexpected });
      if (currentFailures.length) addDiagnostic(diagnostics, routeId, viewport.name, "network.failed", "Required storefront requests failed", { requests: currentFailures });
      if (currentConsole.length) addDiagnostic(diagnostics, routeId, viewport.name, "console.error", "Browser emitted uncaught errors", { errors: currentConsole });
      unexpectedRequests.push(...currentUnexpected);
      requestFailures.push(...currentFailures);
      consoleErrors.push(...currentConsole);

      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => {
        let active = document.activeElement as HTMLElement | null;
        if (active?.shadowRoot?.activeElement instanceof HTMLElement) active = active.shadowRoot.activeElement;
        if (!active || active === document.body) return { ok: false, outline: false };
        const style = getComputedStyle(active);
        return { ok: true, outline: style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0 };
      });
      if (!focus.ok) addDiagnostic(diagnostics, routeId, viewport.name, "keyboard.focus", "Tab did not move focus to an interactive control");
      else if (!focus.outline) addDiagnostic(diagnostics, routeId, viewport.name, "focus.visible", "Keyboard focus has no visible outline");

      await page.evaluate(() => scrollTo(0, 0));
      const image = Buffer.from(await page.screenshot({ type: "webp", quality: 90, fullPage: false }));
      assertActive();
      const sha256 = createHash("sha256").update(image).digest("hex");
      const screenshotRef = `sha256:${sha256}`;
      screenshots.push(screenshotRef);
      const manifestEntry: ProveStorefrontBundleResult["screenshotManifest"][number] = { routeId, viewport: viewport.name, sha256 };
      if (routeId === "home" && input.artifacts?.baselineDirectory) {
        const baseline = resolve(input.artifacts.baselineDirectory, `v1-${viewport.name}.webp`);
        manifestEntry.baseline = baseline;
        await mkdir(input.artifacts.baselineDirectory, { recursive: true });
        if (input.artifacts.updateBaselines) await writeFile(baseline, image);
        else {
          try {
            const diff = await pixelDiffRatio(page, image, await readFile(baseline));
            manifestEntry.pixelDiffRatio = diff;
            if (diff > 0.005) addDiagnostic(diagnostics, routeId, viewport.name, "visual.regression", `Pixel difference ${(diff * 100).toFixed(3)}% exceeds 0.5%`, { baseline, ratio: diff });
          } catch (error) {
            addDiagnostic(diagnostics, routeId, viewport.name, "visual.baseline-missing", error instanceof Error ? error.message : String(error), { baseline });
          }
        }
      }
      screenshotManifest.push(manifestEntry);

      if (routeId === "home" && viewport.name === "desktop" && input.artifacts?.previewFile) {
        await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
        await mkdir(resolve(input.artifacts.previewFile, ".."), { recursive: true });
        await writeFile(input.artifacts.previewFile, Buffer.from(await page.screenshot({ type: "webp", quality: 90, fullPage: false })));
      }
      input.onProgress?.({ routeId, viewport: viewport.name, completed: caseIndex + 1, total: proofCases.length });
    }
  } finally {
    await page.close();
    if (ownBrowser) await browser.close();
  }
  const report = createBrowserProofReport({
    diagnostics,
    screenshots,
    browserMs: Date.now() - startedAt,
    metrics,
    cases: buildStorefrontProofCases(input.bundle).length,
  });
  return { ...report, screenshotManifest };
}

/** Production adapter shape consumed by the AI storefront compiler. */
export async function storefrontAiBrowserProof(input: {
  bundle: StorefrontBundleV1;
  context?: MerchantStorefrontContext;
  persistedAssets?: MaterializedAssetResult["proofAssets"];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<BrowserProofReport> {
  return proveStorefrontBundle(input);
}
