// app/lib/designer/doctrine.ts
// Distilled craft doctrine for the designer engine's prompts: dense, checkable
// rules that complement (never repeat) the taste and conversion rules already
// in engine.server.ts. The edit-block format, placeholder contract, and
// sanitizer rules there always win on conflict.

/** Write-time craft rules appended to the designer SYSTEM_PROMPT. */
export const CRAFT_RULES = `- Commit to ONE system store-wide: one corner-radius scale (sharp 0-2px, soft 4-8px, or pill), one shadow regime (hairline borders, or one soft tinted elevation, never both on the same surface kind), one motion mode. Mixing regimes across sections or pages reads as accidental, not designed.
- Hierarchy: every screen has an unmistakable first, second and third read; the primary element wins on several signals at once (size, weight, color, position, surrounding space). A first-time shopper must know what the store sells and what to do within 5 seconds.
- Rhythm: repeat one section pattern, then break it once deliberately for emphasis. Identical stacked sections are monotony; every section different is noise. All spacing stays on the 8px scale, no one-off values like 7px, 13px or 18px.
- Interaction states: style default, hover, active and focus for every link, button and clickable card. Hover shifts color or lifts slightly (never an opacity fade, it reads as disabled); active presses down (scale 0.98 or a darker fill); :focus-visible gets a 2px outline with 2px offset in a contrasting color, and no outline is ever removed without a replacement. Transition state changes over 0.15-0.3s ease; wrap decorative animation in @media (prefers-reduced-motion: reduce) so motion-sensitive shoppers get the resting layout.
- Accessibility floors: 3:1 contrast for large text and controls on top of the 4.5:1 body floor, held over gradients and imagery too. Exactly one h1 per page and headings descend without skipping levels. Meaningful images get specific alt text describing what the shopper sees; purely decorative ones get alt="". Interactive targets are at least 44px tall. Never communicate state or meaning by color alone.`;

/** Concrete-defect checks merged into the launch-readiness REVIEW_PROMPT.
 *  Phrased as findable defects, not aspirations, to keep review precision high. */
export const REVIEW_CRAFT_CHECKS = `text or controls below contrast floors (4.5:1 body, 3:1 large text and controls) against their actual background, a primary call to action or interactive element with no hover, active, or focus-visible treatment, pure #FFFFFF surfaces against pure #000000 text, more than one h1 or skipped heading levels, and mixed corner-radius or shadow treatments on the same page`;
