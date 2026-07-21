// Client-safe text helpers for the designer surfaces. The model works inside
// HTML documents all day, so its chat prose picks up escaped entities
// ("Maple &amp; Wick"); the dock renders replies as plain text, so entities
// must be decoded to characters — never rendered as markup.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode HTML character references in a plain-text string. Handles the named
 *  entities chat copy actually picks up plus numeric forms; anything
 *  unrecognized is left verbatim. One pass, no DOM, no markup interpretation. */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}
