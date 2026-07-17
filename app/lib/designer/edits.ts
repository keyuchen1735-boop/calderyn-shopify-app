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
}

const BLOCK_RE = /FILE:[ \t]*([\w.-]+)\s*\n<{5,9} ?SEARCH\s*\n([\s\S]*?)\n={5,9}\s*\n([\s\S]*?)\n>{5,9} ?REPLACE/g;

export function parseDesignerReply(raw: string): ParsedDesignerReply {
  const edits: DesignerEdit[] = [];
  let prose = raw;
  for (const match of raw.matchAll(BLOCK_RE)) {
    edits.push({ file: match[1], search: match[2], replace: match[3] });
    prose = prose.replace(match[0], "");
  }
  // A whole-file rewrite ships as a block with an empty SEARCH on an empty
  // file, or the sentinel `*` meaning "replace the entire file".
  return { prose: prose.replace(/```(?:\w+)?/g, "").trim(), edits };
}

export interface ApplyResult {
  files: Record<string, string>;
  applied: number;
  rejected: DesignerEdit[];
}

/** Applies edits with exact matching (first occurrence). Whitespace-tolerant
 *  fallback: when the exact search misses, retry with every line trimmed —
 *  models frequently drop or add indentation when quoting. */
export function applyDesignerEdits(files: Record<string, string>, edits: DesignerEdit[]): ApplyResult {
  const next = { ...files };
  const rejected: DesignerEdit[] = [];
  let applied = 0;
  for (const edit of edits) {
    const current = next[edit.file];
    if (current === undefined) {
      rejected.push(edit);
      continue;
    }
    // A whole-file rewrite is the sentinel `*` or an empty SEARCH. Fold the
    // empty case in here: `current.replace("", fn)` inserts at offset 0, which
    // would silently prepend the replacement to a non-empty file instead of
    // replacing it.
    if (edit.search.trim() === "*" || edit.search.trim() === "") {
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

/** Finds the search text ignoring per-line leading/trailing whitespace. */
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
      const start = offsets[i];
      const lastLine = j - 1;
      const end = offsets[lastLine] + hayLines[lastLine].length;
      return { start, end };
    }
  }
  return null;
}
