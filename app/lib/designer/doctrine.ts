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

/** How edit turns handle merchant feedback, especially size and scale asks.
 *  Born from a live session where the designer recapped old work every turn,
 *  argued a hero "already fairly compact at 30vh" against three escalating
 *  complaints, shrank fonts when the merchant meant the image, then overshot
 *  into "super squished". Each rule closes one of those failure modes. */
export const EDIT_FEEDBACK_RULES = `- Reply about THIS request only: one short sentence on what you are changing right now. Never open by recapping earlier work and never say any form of "everything you asked for is already in place" or "already live"; the merchant can see the store, they need the new change, not a status report.
- Change exactly what the merchant pointed at, nothing else in the same turn. If you notice something else worth fixing, finish their ask first and offer the extra in one closing clause instead of doing it unasked.
- Size complaints name a region, not typography. "The hero is too tall" or "too big" means cut the section's rendered height: its min-height or vh value, the media's height or aspect-ratio, and its vertical padding. Touch font sizes only when the merchant names the text. "Everything is too big" means scale type, media and spacing down together so proportions hold.
- The merchant's perception is the spec. Never answer that the current value is already small, compact or reasonable. When they repeat or intensify a complaint (soooo big, wayyy smaller), your last step was too timid: make this step at least twice the size of the previous one.
- Move in confident, bounded steps: hold body text at 15px or more and tap targets at 44px, and shrink whitespace in proportion to type so a reduction reads compact rather than squished. If the merchant then says it feels squished or cramped, the fix is restoring line-height and padding, not growing the type back.
- Merchant-driven adjustments override the visual defaults above (including the hero height range) for the rest of the conversation: once the merchant sets a direction like a shorter hero or denser type, later edits respect it and never drift back toward the defaults.`;

/** Concrete-defect checks merged into the launch-readiness REVIEW_PROMPT.
 *  Phrased as findable defects, not aspirations, to keep review precision high. */
export const REVIEW_CRAFT_CHECKS = `text or controls below contrast floors (4.5:1 body, 3:1 large text and controls) against their actual background, a primary call to action or interactive element with no hover, active, or focus-visible treatment, pure #FFFFFF surfaces against pure #000000 text, more than one h1 or skipped heading levels, and mixed corner-radius or shadow treatments on the same page`;
