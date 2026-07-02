// I8 interstitial (spec §9): muting a shipped no-brainer must never be a
// single accidental tap. The three no-brainer pairs are the safety net that
// stops ads from burning money on sold-out / loss-making products — so when
// the merchant picks "I handle this" for one of them, both surfaces show this
// warning and require an explicit second confirmation before the mute applies.
// Pure module (no I/O): imported by both reject endpoints so the contract is
// identical on the embedded admin and the dashboard.

import type { ActionKind } from "../types";
import { NO_BRAINER } from "./confidence";
import { DETECTOR_LABELS } from "../labels";

/** The plain-language warning to confirm, or null when no confirm is needed
 * (the pair is not a shipped no-brainer). */
export function muteConfirmationMessage(
  detectorId: string,
  actionKind: ActionKind,
): string | null {
  if (!NO_BRAINER.has(`${detectorId}:${actionKind}`)) return null;
  const label =
    DETECTOR_LABELS[detectorId as keyof typeof DETECTOR_LABELS] ?? detectorId;
  return (
    `This protection catches "${label}" before it costs you money. ` +
    `If you take it over, Calderyn will never act on it alone and will always ask you first. ` +
    `You can hand it back any time from Settings → Learned rules.`
  );
}
