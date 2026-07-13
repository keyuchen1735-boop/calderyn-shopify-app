// Shared dialog chrome for the dashboard's overlay surfaces: Escape-to-close,
// autofocus of the first control on open, and a Tab cycle that stays inside
// the dialog. One implementation so the focusable-element selector can't
// drift between modals.
//
// `escape: "capture"` registers the Escape listener in the capture phase and
// stops propagation — the layering rule for modals that can sit ON TOP of a
// drawer (their Escape must not also close the drawer underneath).
// `escape: "bubble"` (default) is for the bottom layer (drawers): a stacked
// capture-phase modal swallows Escape before it bubbles down here.

import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

const FOCUSABLE = "button, input, select, textarea, [tabindex]";

export function useModalChrome<T extends HTMLElement>({
  onClose,
  enabled = true,
  escape = "bubble",
}: {
  onClose: () => void;
  /** For conditionally-shown surfaces owned by an always-mounted parent
   *  (e.g. a drawer): the listeners/autofocus only run while true. */
  enabled?: boolean;
  escape?: "capture" | "bubble";
}): { ref: RefObject<T>; onKeyDown: (e: ReactKeyboardEvent<T>) => void } {
  const ref = useRef<T>(null);
  const capture = escape === "capture";

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (capture) e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture });
    return () => window.removeEventListener("keydown", onKey, { capture });
  }, [enabled, capture, onClose]);

  useEffect(() => {
    if (!enabled) return;
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [enabled]);

  const onKeyDown = (e: ReactKeyboardEvent<T>) => {
    if (e.key !== "Tab") return;
    const nodes = ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!nodes) return;
    const focusable = Array.from(nodes).filter(
      (n) => !n.hasAttribute("disabled") && n.getAttribute("tabindex") !== "-1",
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && ref.current?.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return { ref, onKeyDown };
}
