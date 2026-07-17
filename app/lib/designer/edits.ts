// The designer's edit protocol: the model replies with free prose plus
// FILE-scoped search/replace blocks — the same mechanism a coding agent uses
// to edit source. Exact-match application makes every edit verifiable, and a
// failed match is reported back for one retry instead of failing the turn.
//
//   FILE: home.html
//   <<<<<<< SEARCH
//   ...exact current text...
//   =======
//   ...replacement text...
//   >>>>>>> REPLACE

export interface DesignerEdit {
  file: string;
  search: string;
  replace: string;
}

export interface ParsedDesignerReply {
  prose: string;
  edits: DesignerEdit[];
  /** True when the reply ends inside an unterminated edit block — the model
   *  ran out of output tokens mid-edit. The partial block is excluded from
   *  both edits and prose so raw markup never reaches the merchant. */
  truncated: boolean;
}

// Marker matching is deliberately loose (leading indent, any run length of
// marker characters, trailing spaces): a marker line the parser fails to
// recognize doesn't just break that edit — its whole block leaks into the
// merchant's chat as raw diff text (observed live with CRLF-formatted
// replies, whose trailing \r defeated exact end-of-line anchors).
const FILE_LINE = /^[ \t]*FILE:[ \t]*([\w.-]+)[ \t]*$/;
const SEARCH_LINE = /^[ \t]*<{4,} ?SEARCH[ \t]*$/;
const DIVIDER_LINE = /^[ \t]*={4,}[ \t]*$/;
const REPLACE_LINE = /^[ \t]*>{4,} ?REPLACE[ \t]*$/;

/** Line-based block parser. A single regex cannot express empty SEARCH or
 *  empty REPLACE sections (deletions), and silently drops blocks cut off by
 *  a max_tokens truncation — both real merchant scenarios. */
export function parseDesignerReply(raw: string): ParsedDesignerReply {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const edits: DesignerEdit[] = [];
  const proseLines: string[] = [];
  let truncated = false;

  let i = 0;
  while (i < lines.length) {
    // A block starts at "FILE: name" with "<<<<<<< SEARCH" on the next
    // non-blank line (models sometimes pad a blank line between them).
    let searchAt = -1;
    if (FILE_LINE.test(lines[i])) {
      let probe = i + 1;
      while (probe < lines.length && lines[probe].trim() === "") probe += 1;
      if (probe < lines.length && SEARCH_LINE.test(lines[probe])) searchAt = probe;
    }
    if (searchAt !== -1) {
      const file = lines[i].match(FILE_LINE)![1];
      let j = searchAt + 1;
      const search: string[] = [];
      while (j < lines.length && !DIVIDER_LINE.test(lines[j])) search.push(lines[j++]);
      if (j >= lines.length) {
        // Cut off before the divider — drop the partial block from prose.
        truncated = true;
        break;
      }
      j += 1; // past the divider
      const replace: string[] = [];
      while (j < lines.length && !REPLACE_LINE.test(lines[j])) replace.push(lines[j++]);
      if (j >= lines.length) {
        truncated = true;
        break;
      }
      edits.push({ file, search: search.join("\n"), replace: replace.join("\n") });
      i = j + 1;
      continue;
    }
    // A stray block marker outside a well-formed block is model formatting
    // debris — keep it out of the merchant-facing prose.
    if (SEARCH_LINE.test(lines[i]) || DIVIDER_LINE.test(lines[i]) || REPLACE_LINE.test(lines[i]) || FILE_LINE.test(lines[i])) {
      i += 1;
      continue;
    }
    proseLines.push(lines[i]);
    i += 1;
  }

  const prose = proseLines.join("\n").replace(/```(?:\w+)?/g, "").trim();
  return { prose, edits, truncated };
}

export interface ApplyResult {
  files: Record<string, string>;
  applied: number;
  rejected: DesignerEdit[];
}

/** Applies edits with exact matching (first occurrence). Whitespace-tolerant
 *  fallback: when the exact search misses, retry with every line trimmed —
 *  models frequently drop or add indentation when quoting. `allowedFiles`
 *  (when given) scopes edits to the files the model was shown; edits to any
 *  other file are rejected rather than silently rewriting unseen pages. */
export function applyDesignerEdits(
  files: Record<string, string>,
  edits: DesignerEdit[],
  allowedFiles?: ReadonlySet<string>,
): ApplyResult {
  const next = { ...files };
  const rejected: DesignerEdit[] = [];
  let applied = 0;
  for (const edit of edits) {
    const current = next[edit.file];
    if (current === undefined || (allowedFiles && !allowedFiles.has(edit.file))) {
      rejected.push(edit);
      continue;
    }
    if (edit.search.trim() === "*" || edit.search.trim() === "") {
      // Whole-file rewrite (`*`), or an empty SEARCH which only makes sense
      // as "write this file" on an empty file — on non-empty files an empty
      // SEARCH is ambiguous, so reject it for the retry to re-quote.
      if (edit.search.trim() === "" && current.trim() !== "") {
        rejected.push(edit);
        continue;
      }
      next[edit.file] = edit.replace;
      applied += 1;
      continue;
    }
    if (current.includes(edit.search)) {
      // Function replacer: the replacement is model text, so $-patterns
      // ($&, $1, $') in it must land literally, never as match references.
      next[edit.file] = current.replace(edit.search, () => edit.replace);
      applied += 1;
      continue;
    }
    const relaxed = relaxedFind(current, edit.search);
    if (relaxed) {
      next[edit.file] = current.slice(0, relaxed.start) + edit.replace + current.slice(relaxed.end);
      applied += 1;
      continue;
    }
    rejected.push(edit);
  }
  return { files: next, applied, rejected };
}

/** Finds the search text ignoring per-line leading/trailing whitespace.
 *  Returns null when the loose match is ambiguous (more than one occurrence):
 *  generic closers like `</div>\n</section>` appear in every section, and
 *  splicing the first occurrence would edit the wrong part of the page — a
 *  rejection feeds the retry, which asks for a longer unambiguous quote. */
export function relaxedFind(haystack: string, needle: string): { start: number; end: number } | null {
  const needleLines = needle.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (needleLines.length === 0) return null;
  const hayLines = haystack.split("\n");
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of hayLines) {
    offsets.push(cursor);
    cursor += line.length + 1;
  }
  let found: { start: number; end: number } | null = null;
  for (let i = 0; i < hayLines.length; i += 1) {
    let matched = 0;
    let j = i;
    while (j < hayLines.length && matched < needleLines.length) {
      const hay = hayLines[j].trim();
      if (hay.length === 0 && matched > 0) {
        j += 1;
        continue;
      }
      if (hay !== needleLines[matched]) break;
      matched += 1;
      j += 1;
    }
    if (matched === needleLines.length) {
      if (found) return null; // ambiguous — two loose matches, wrong-splice risk
      const lastLine = j - 1;
      found = { start: offsets[i], end: offsets[lastLine] + hayLines[lastLine].length };
      i = lastLine;
    }
  }
  return found;
}
