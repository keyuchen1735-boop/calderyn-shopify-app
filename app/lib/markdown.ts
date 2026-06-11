// app/lib/markdown.ts
// Minimal markdown subset for assistant replies, shared by the embedded
// slideout and the web dashboard chat. Parses to a token tree the <Markdown>
// component renders as React elements — no raw HTML ever passes through, so
// the output is XSS-safe by construction (spec: 2026-06-11 assistant chat).
//
// Supported on purpose (and nothing more): paragraphs, #–### headings,
// ordered/unordered lists, fenced code blocks, **bold**, *italic*, `code`,
// and [text](http(s)://…) links. Unknown syntax renders as literal text.

export type MdInline =
  | { type: "text"; text: string }
  | { type: "strong"; children: MdInline[] }
  | { type: "em"; children: MdInline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: MdInline[] };

export type MdBlock =
  | { type: "paragraph"; children: MdInline[] }
  | { type: "heading"; level: 1 | 2 | 3; children: MdInline[] }
  | { type: "list"; ordered: boolean; items: MdInline[][] }
  | { type: "code"; text: string };

const HEADING_RE = /^(#{1,3})\s+(.+)$/;
const UL_ITEM_RE = /^\s*[-*]\s+(.+)$/;
const OL_ITEM_RE = /^\s*\d+[.)]\s+(.+)$/;
const FENCE_RE = /^```/;

export function parseMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = src.replaceAll("\r\n", "\n").split("\n");
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE_RE.test(line)) {
      flushParagraph();
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      // An unclosed fence still renders as code — fail visible, not dropped.
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3,
        children: parseInline(heading[2].trim()),
      });
      continue;
    }

    const listKind = UL_ITEM_RE.test(line) ? "ul" : OL_ITEM_RE.test(line) ? "ol" : null;
    if (listKind) {
      flushParagraph();
      const re = listKind === "ul" ? UL_ITEM_RE : OL_ITEM_RE;
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (!m) break;
        items.push(parseInline(m[1].trim()));
        i++;
      }
      i--; // outer loop advances past the last consumed line
      blocks.push({ type: "list", ordered: listKind === "ol", items });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  return blocks;
}

// Inline patterns, tried at every scan position; earliest match wins, ties
// break by list order (code first so `**x**` inside backticks stays literal).
const INLINE_PATTERNS: {
  re: RegExp;
  build: (m: RegExpExecArray) => MdInline;
}[] = [
  { re: /`([^`]+)`/, build: (m) => ({ type: "code", text: m[1] }) },
  {
    // Content may contain single stars (nested *em*) but never a closing **.
    re: /\*\*((?:[^*]|\*(?!\*))+)\*\*/,
    build: (m) => ({ type: "strong", children: parseInline(m[1]) }),
  },
  { re: /\*([^*]+)\*/, build: (m) => ({ type: "em", children: parseInline(m[1]) }) },
  {
    // http(s) only — anything else (javascript:, data:) stays literal text.
    re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/,
    build: (m) => ({ type: "link", href: m[2], children: parseInline(m[1]) }),
  },
];

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let rest = text;

  while (rest.length > 0) {
    let earliest: { index: number; match: RegExpExecArray; build: (m: RegExpExecArray) => MdInline } | null = null;
    for (const { re, build } of INLINE_PATTERNS) {
      const match = re.exec(rest);
      if (match && (earliest === null || match.index < earliest.index)) {
        earliest = { index: match.index, match, build };
      }
    }
    if (!earliest) {
      out.push({ type: "text", text: rest });
      break;
    }
    if (earliest.index > 0) {
      out.push({ type: "text", text: rest.slice(0, earliest.index) });
    }
    out.push(earliest.build(earliest.match));
    rest = rest.slice(earliest.index + earliest.match[0].length);
  }

  return out;
}
