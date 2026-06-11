// Client-safe: rotating status phrases shown while a chat turn is in flight,
// shared by the embedded slideout and the dashboard chat. The sequence walks
// forward one phrase per tick and holds on the last (a long turn reads as
// "Putting it together…", not a loop back to the start).
import { useEffect, useState } from "react";

export const THINKING_PHRASES = [
  "Calderyn is analyzing…",
  "Checking your alerts…",
  "Reading campaign performance…",
  "Scanning inventory levels…",
  "Crunching the numbers…",
  "Putting it together…",
] as const;

export const THINKING_PHRASE_INTERVAL_MS = 2400;

/** Phrase for the n-th tick; clamps to the ends rather than wrapping. */
export function thinkingPhraseAt(step: number): string {
  return THINKING_PHRASES[Math.min(Math.max(step, 0), THINKING_PHRASES.length - 1)];
}

/** Advances through THINKING_PHRASES while `active`; resets when it flips off. */
export function useThinkingPhrase(active: boolean): string {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!active) {
      setStep(0);
      return;
    }
    const id = setInterval(() => setStep((s) => s + 1), THINKING_PHRASE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active]);
  return thinkingPhraseAt(step);
}
