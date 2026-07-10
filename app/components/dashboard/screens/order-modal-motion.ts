// Shared entrance motion for every order modal (Refund/Fulfill/Cancel/Reduce line/Edit invoice
// lines) plus the order composer's inline send-confirm dialog: a quiet scrim fade and a soft
// scale+fade on the dialog itself, instead of an instant pop. Same useGSAP + reduced() idiom as
// the rest of the dashboard (see hero-motion.ts / TickGauge in ui.tsx) so this motion behaves
// identically to every other cd-* animation under prefers-reduced-motion. Modals aren't anchored
// to a trigger element, so the dialog keeps a centered transform-origin (the default) rather than
// the popover origin-awareness pattern.
import { useRef, type RefObject } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { reduced } from "../hero/hero-motion";

export function useModalEntrance(): {
  overlayRef: RefObject<HTMLDivElement>;
  dialogRef: RefObject<HTMLDivElement>;
} {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    if (reduced() || !overlayRef.current || !dialogRef.current) return;
    gsap.fromTo(
      overlayRef.current,
      { autoAlpha: 0 },
      { autoAlpha: 1, duration: 0.16, ease: "power1.out" },
    );
    gsap.fromTo(
      dialogRef.current,
      { autoAlpha: 0, scale: 0.96 },
      { autoAlpha: 1, scale: 1, duration: 0.2, ease: "power2.out", clearProps: "transform" },
    );
  }, []);

  return { overlayRef, dialogRef };
}
