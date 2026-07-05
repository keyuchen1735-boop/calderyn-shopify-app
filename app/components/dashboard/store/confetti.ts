// A short one-off confetti burst for the first publish. Reduced-motion-guarded
// (hero-motion's shared predicate); every spawned node cleans itself up on its
// own timeline.
import gsap from "gsap";
import { reduced } from "../hero/hero-motion";

const COLORS = ["#2D7FF9", "#1F9D57", "#C2791B", "#7C5CFC", "#DB4B41"];

export function confettiFrom(el: Element | null): void {
  if (!el || reduced()) return;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  for (let i = 0; i < 16; i++) {
    const p = document.createElement("span");
    p.style.cssText =
      "position:fixed;z-index:99;width:7px;height:7px;border-radius:2px;pointer-events:none;" +
      `left:${cx}px;top:${cy}px;background:${COLORS[i % COLORS.length]};`;
    document.body.appendChild(p);
    gsap
      .timeline({ onComplete: () => p.remove() })
      .to(p, {
        x: (Math.random() - 0.5) * 190,
        y: -30 - Math.random() * 90,
        rotation: Math.random() * 260,
        duration: 0.45,
        ease: "power2.out",
      })
      .to(p, { y: "+=150", autoAlpha: 0, duration: 0.65, ease: "power1.in" }, ">-0.05");
  }
}
