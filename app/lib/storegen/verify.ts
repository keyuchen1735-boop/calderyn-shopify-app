// app/lib/storegen/verify.ts
// Pre-present verification of generated docs — the last gate before drafts are
// saved and the merchant is shown anything. Re-checks every link against the real
// catalog (a dead deep-link is rewritten to the shop home and counted, never
// shipped), strips motion specs the runtime would silently reject (no dead
// attributes in stored docs), and flags a hollow home. Pure: returns new docs +
// a report the generator records and the chat can surface honestly (rule 12).
import { parseMotionSpec } from "~/lib/storebuilder/fx/motion";
import type { Block, BlockDocument } from "~/lib/storebuilder/types";
import type { StorefrontLinkSet } from "~/lib/storefront/links";

export interface VerificationReport {
  checkedLinks: number;
  fixedLinks: number;
  externalLinks: number;
  strippedMotion: number;
  warnings: string[];
}

const HREF_RE = /href="([^"]*)"/g;
const MOTION_ATTR_RE = /\s*data-fx-motion=(?:'([^']*)'|"([^"]*)")/g;
const HOME_MIN_TEXT = 40;

type HrefKind = "ok" | "external" | "fix";
function classifyHref(href: string, links: StorefrontLinkSet): HrefKind {
  if (/^(https?:|mailto:|tel:)/i.test(href)) return "external";
  if (href === "/storefront") return "ok";
  const coll = /^\/storefront\/collections\/([^/?#]+)$/.exec(href);
  if (coll) return links.collectionHandles.has(coll[1]) ? "ok" : "fix";
  const prod = /^\/storefront\/products\/([^/?#]+)$/.exec(href);
  if (prod) return links.productHandles.has(prod[1]) ? "ok" : "fix";
  return "fix";
}

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export function verifyGeneratedDocs(
  docs: Record<string, BlockDocument>,
  links: StorefrontLinkSet,
): { docs: Record<string, BlockDocument>; report: VerificationReport } {
  const report: VerificationReport = { checkedLinks: 0, fixedLinks: 0, externalLinks: 0, strippedMotion: 0, warnings: [] };

  const fixHtml = (html: string): string => {
    let out = html.replace(HREF_RE, (_m, href: string) => {
      const kind = classifyHref(href, links);
      if (kind === "external") {
        report.externalLinks += 1;
        return `href="${href}"`;
      }
      report.checkedLinks += 1;
      if (kind === "ok") return `href="${href}"`;
      report.fixedLinks += 1;
      return 'href="/storefront"';
    });
    out = out.replace(MOTION_ATTR_RE, (m, single: string | undefined, dbl: string | undefined) => {
      const spec = decode(single ?? dbl ?? "");
      if (parseMotionSpec(spec) !== null) return m;
      report.strippedMotion += 1;
      return "";
    });
    return out;
  };

  const fixBlock = (b: Block): Block => {
    if (b.type === "rawHtml") {
      const html = (b.props as { html?: unknown }).html;
      if (typeof html !== "string") return b;
      const fixed = fixHtml(html);
      return fixed === html ? b : { ...b, props: { ...b.props, html: fixed } };
    }
    const href = (b.props as { href?: unknown }).href;
    if (typeof href === "string") {
      const kind = classifyHref(href, links);
      if (kind === "external") {
        report.externalLinks += 1;
        return b;
      }
      report.checkedLinks += 1;
      if (kind === "fix") {
        report.fixedLinks += 1;
        return { ...b, props: { ...b.props, href: "/storefront" } };
      }
    }
    return b;
  };

  const out: Record<string, BlockDocument> = {};
  for (const [key, doc] of Object.entries(docs)) {
    const blocks = doc.blocks.map(fixBlock);
    out[key] = blocks.some((b, i) => b !== doc.blocks[i]) ? { ...doc, blocks } : doc;
  }

  const home = out.home;
  if (home) {
    const text = home.blocks
      .filter((b) => b.type === "rawHtml")
      .map((b) => String((b.props as { html?: unknown }).html ?? "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " "))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 0 && text.length < HOME_MIN_TEXT) {
      report.warnings.push("home page copy reads sparse (very short text content)");
    }
  }
  return { docs: out, report };
}
