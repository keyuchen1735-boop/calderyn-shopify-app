const MOTIONS = new Set(["reveal", "parallax", "count-up", "pinned", "scroll-progress"]);
export type DeclarativeMotion = "reveal" | "parallax" | "count-up" | "pinned" | "scroll-progress";

export function motionAttributes(motion: DeclarativeMotion): string {
  if (!MOTIONS.has(motion)) throw new Error("Unsupported declarative motion");
  return `data-cd-motion="${motion}"`;
}
