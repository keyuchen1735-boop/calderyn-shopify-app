// app/lib/storebuilder/fx/motion.ts
// Motion channel for the generator's rawHtml path. The AI emits a `data-fx-motion`
// JSON spec; parseMotionSpec is a strict boundary validator (reject, don't coerce —
// strictness keeps the emitted specs honest) and applyMotion is the only place that
// maps a validated spec onto GSAP. GLSL/JSON here can only move pixels, never touch
// the DOM API or network beyond what these two functions allow.
import gsap from "gsap";

export type MotionTrigger = "load" | "inview";

// The full property allowlist. Split below into animatable CSS/transform props and
// tween-config keys so a fromTo can route config into the "to" vars.
export interface MotionProps {
  x?: number;
  y?: number;
  xPercent?: number;
  yPercent?: number;
  opacity?: number;
  scale?: number;
  rotation?: number;
  clipPath?: string;
  filter?: string;
  transformOrigin?: string;
  duration?: number;
  delay?: number;
  ease?: string;
  stagger?: number;
  repeat?: number;
  yoyo?: boolean;
}

export interface MotionSpec {
  trigger?: MotionTrigger;
  targets?: string;
  from?: MotionProps;
  to?: MotionProps;
}

const RAW_CAP = 2000;
const STRING_CAP = 120;
const TARGETS_CAP = 100;
const MATCH_CAP = 40;

const ALLOWED_TOP = new Set(["trigger", "targets", "from", "to"]);
// Finite, otherwise-unbounded numeric transforms.
const FREE_NUMBER_KEYS = new Set(["x", "y", "xPercent", "yPercent", "opacity", "scale", "rotation"]);
// Numeric config keys with an inclusive [min, max] clamp — out of range rejects the spec.
const NUMBER_RANGES: Record<string, [number, number]> = {
  duration: [0, 20],
  delay: [0, 10],
  stagger: [0, 2],
};
// Free-form string props (still length-capped).
const STRING_KEYS = new Set(["clipPath", "filter", "transformOrigin"]);
// Matches gsap ease names: "power2.out", "back.out(1.7)", "sine.inOut", "expo.out", "none".
const EASE_RE = /^[a-z]+[0-9]*(\.(in|out|inOut))?(\([0-9., ]*\))?$/i;
// Selector characters that indicate an attribute selector or injected markup.
const FORBIDDEN_SELECTOR = /[<>{}[\]]/;

const ANIMATABLE_KEYS = [
  "x", "y", "xPercent", "yPercent", "opacity", "scale", "rotation",
  "clipPath", "filter", "transformOrigin",
] as const;
const CONFIG_KEYS = ["duration", "delay", "ease", "stagger", "repeat", "yoyo"] as const;

function validTargets(value: string): boolean {
  if (value.length === 0 || value.length > TARGETS_CAP) return false;
  if (value.trim().length === 0) return false;
  if (FORBIDDEN_SELECTOR.test(value)) return false;
  // 6, not 3: real hero reveals target every hero child (eyebrow, h1, p, cta…)
  // and models routinely list 4-5 — a tighter cap silently killed the page's
  // most visible animation. The 40-matched-node cap still bounds the work.
  return value.split(",").length <= 6;
}

function parseProps(raw: unknown): MotionProps | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (FREE_NUMBER_KEYS.has(key)) {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      out[key] = value;
    } else if (key in NUMBER_RANGES) {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      const [lo, hi] = NUMBER_RANGES[key];
      if (value < lo || value > hi) return null;
      out[key] = value;
    } else if (key === "repeat") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < -1 || value > 20) return null;
      out[key] = value;
    } else if (key === "yoyo") {
      if (typeof value !== "boolean") return null;
      out[key] = value;
    } else if (key === "ease") {
      if (typeof value !== "string" || value.length > STRING_CAP || !EASE_RE.test(value)) return null;
      out[key] = value;
    } else if (STRING_KEYS.has(key)) {
      if (typeof value !== "string" || value.length > STRING_CAP) return null;
      out[key] = value;
    } else {
      return null; // unknown key → reject the whole spec
    }
  }
  return out as MotionProps;
}

export function parseMotionSpec(raw: string): MotionSpec | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > RAW_CAP) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP.has(key)) return null;
  }

  const spec: MotionSpec = {};
  if ("trigger" in obj) {
    if (obj.trigger !== "load" && obj.trigger !== "inview") return null;
    spec.trigger = obj.trigger;
  }
  if ("targets" in obj) {
    if (typeof obj.targets !== "string" || !validTargets(obj.targets)) return null;
    spec.targets = obj.targets;
  }
  if ("from" in obj) {
    const from = parseProps(obj.from);
    if (!from) return null;
    spec.from = from;
  }
  if ("to" in obj) {
    const to = parseProps(obj.to);
    if (!to) return null;
    spec.to = to;
  }
  // A spec that animates nothing is a no-op — reject it so a malformed emission
  // surfaces as a null rather than a silent do-nothing tween.
  if (!spec.from && !spec.to) return null;
  return spec;
}

function pickVars(props: MotionProps, keys: readonly string[]): gsap.TweenVars {
  const src = props as Record<string, unknown>;
  const out: gsap.TweenVars = {};
  for (const key of keys) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function resolveTargets(host: HTMLElement, selector?: string): Element[] {
  if (!selector) return [host];
  let nodes: NodeListOf<Element>;
  try {
    nodes = host.querySelectorAll(selector);
  } catch {
    return [];
  }
  return Array.from(nodes).slice(0, MATCH_CAP);
}

function buildTween(targets: Element[], spec: MotionSpec): ReturnType<typeof gsap.to> | null {
  if (spec.from && spec.to) {
    const config = pickVars({ ...spec.from, ...spec.to }, CONFIG_KEYS);
    return gsap.fromTo(
      targets,
      pickVars(spec.from, ANIMATABLE_KEYS),
      { ...pickVars(spec.to, ANIMATABLE_KEYS), ...config },
    );
  }
  if (spec.from) return gsap.from(targets, { ...pickVars(spec.from, ANIMATABLE_KEYS), ...pickVars(spec.from, CONFIG_KEYS) });
  if (spec.to) return gsap.to(targets, { ...pickVars(spec.to, ANIMATABLE_KEYS), ...pickVars(spec.to, CONFIG_KEYS) });
  return null;
}

export function applyMotion(host: HTMLElement, spec: MotionSpec): () => void {
  const targets = resolveTargets(host, spec.targets);
  if (targets.length === 0) return () => {};

  if (prefersReducedMotion()) {
    // Skip animation entirely: land on the final ("to") state immediately. A
    // from-only spec has no explicit destination, so its natural layout is final.
    if (spec.to) gsap.set(targets, pickVars(spec.to, ANIMATABLE_KEYS));
    return () => {};
  }

  const tweens: ReturnType<typeof gsap.to>[] = [];
  let observer: IntersectionObserver | null = null;

  const run = () => {
    const tween = buildTween(targets, spec);
    if (tween) tweens.push(tween);
  };

  if (spec.trigger === "inview" && typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver(
      (entries, obs) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            run();
            obs.disconnect();
            observer = null;
            break;
          }
        }
      },
      { threshold: 0.2 },
    );
    observer.observe(host);
  } else {
    run();
  }

  return () => {
    if (observer) observer.disconnect();
    for (const tween of tweens) tween.kill();
  };
}
