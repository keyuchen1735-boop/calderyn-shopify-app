import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import { CDIcon } from "./icons";
import { reduced } from "./hero/hero-motion";
import { Btn, Card } from "./ui";
import type { ProductTourOutcome } from "~/lib/dashboard/product-tour";

gsap.registerPlugin(useGSAP);

type TourDemoKind =
  | "overview"
  | "home"
  | "assistant"
  | "autopilot"
  | "products"
  | "store"
  | "ready";

type TourDestination = "dashboard" | "autopilot" | "catalog" | "storefront";

interface TourStep {
  eyebrow: string;
  title: string;
  body: string;
  example: string;
  demo: TourDemoKind;
  destination?: TourDestination;
  anchor?: string;
  mobileAnchor?: string;
  icon: string;
}

const TOUR_STEPS: readonly TourStep[] = [
  {
    eyebrow: "Welcome",
    title: "Meet your command center.",
    body: "Watch a few quick actions.",
    example: "Open a section. See the real screen. Keep moving.",
    demo: "overview",
    icon: "sparkle",
  },
  {
    eyebrow: "Home",
    title: "Start here.",
    body: "See what changed and what to do next.",
    example: "Example: open Home and scan what needs you.",
    demo: "home",
    destination: "dashboard",
    anchor: "home",
    icon: "home",
  },
  {
    eyebrow: "Ask Calderyn",
    title: "Say what you need.",
    body: "Ask a question or hand off a task.",
    example: "Example: find what should be reordered this week.",
    demo: "assistant",
    anchor: "assistant",
    mobileAnchor: "more",
    icon: "assist",
  },
  {
    eyebrow: "Autopilot",
    title: "Grow with guardrails.",
    body: "Calderyn finds improvements. You stay in control.",
    example: "Example: open Autopilot and see its guardrails.",
    demo: "autopilot",
    destination: "autopilot",
    anchor: "autopilot",
    mobileAnchor: "more",
    icon: "bolt",
  },
  {
    eyebrow: "Products",
    title: "Run your catalog.",
    body: "Manage products, inventory, and purchasing.",
    example: "Example: open Products and scan your catalog.",
    demo: "products",
    destination: "catalog",
    anchor: "catalog",
    mobileAnchor: "more",
    icon: "tag",
  },
  {
    eyebrow: "Store",
    title: "Build your storefront.",
    body: "Design, publish, and improve how customers find you.",
    example: "Example: open the builder and see your live preview.",
    demo: "store",
    destination: "storefront",
    anchor: "storefront",
    mobileAnchor: "more",
    icon: "store",
  },
  {
    eyebrow: "Ready",
    title: "Start on Home.",
    body: "We’ll keep the next step clear.",
    example: "You can replay this tour from your account menu.",
    demo: "ready",
    destination: "dashboard",
    anchor: "home",
    mobileAnchor: "home",
    icon: "check",
  },
] as const;

interface HighlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
  radius: number;
}

function visibleAnchor(name: string): HTMLElement | null {
  const matches = document.querySelectorAll<HTMLElement>(
    `[data-tour-anchor="${name}"]`,
  );
  return (
    Array.from(matches).find((node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }) ?? null
  );
}

export function OnboardingTour({
  open,
  onOutcome,
  onDemoNavigate,
  onAssistantDemo,
}: {
  open: boolean;
  onOutcome: (outcome: ProductTourOutcome) => void;
  onDemoNavigate?: (destination: TourDestination) => void;
  onAssistantDemo?: (active: boolean) => void;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [highlight, setHighlight] = useState<HighlightRect | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const step = TOUR_STEPS[stepIndex];
  const finalStep = stepIndex === TOUR_STEPS.length - 1;

  const positionStep = useCallback(() => {
    const anchor =
      window.innerWidth <= 767
        ? (step.mobileAnchor ?? step.anchor)
        : step.anchor;
    if (!open || !anchor) {
      setHighlight(null);
      return;
    }
    const node = visibleAnchor(anchor);
    if (!node) {
      setHighlight(null);
      return;
    }
    node.scrollIntoView({ block: "nearest", inline: "nearest" });
    const rect = node.getBoundingClientRect();
    const pad = 6;
    setHighlight({
      top: Math.max(8, rect.top - pad),
      left: Math.max(8, rect.left - pad),
      width: Math.min(window.innerWidth - 16, rect.width + pad * 2),
      height: Math.min(window.innerHeight - 16, rect.height + pad * 2),
      radius: Math.max(
        10,
        Number.parseFloat(window.getComputedStyle(node).borderRadius) + pad,
      ),
    });
  }, [open, step.anchor, step.mobileAnchor]);

  useEffect(() => {
    if (!open) return;
    setStepIndex(0);
  }, [open]);

  useEffect(() => {
    positionStep();
  }, [positionStep, stepIndex]);

  useEffect(() => {
    if (!open) return;
    const refresh = () => positionStep();
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    return () => {
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
    };
  }, [open, positionStep]);

  useEffect(() => {
    if (!open) return;
    cardRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onOutcome("skip");
        return;
      }
      if (event.key === "ArrowLeft" && stepIndex > 0) {
        event.preventDefault();
        setStepIndex((value) => value - 1);
        return;
      }
      if (
        (event.key === "ArrowRight" || event.key === "Enter") &&
        event.target === cardRef.current
      ) {
        event.preventDefault();
        if (finalStep) onOutcome("complete");
        else setStepIndex((value) => value + 1);
      }
      if (event.key === "Tab" && cardRef.current) {
        const focusable = Array.from(
          cardRef.current.querySelectorAll<HTMLButtonElement>(
            "button:not([disabled])",
          ),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finalStep, onOutcome, open, stepIndex]);

  useGSAP(
    () => {
      if (!open || !rootRef.current) return;
      const cursor = cursorRef.current;
      const noMotion = reduced();
      const duration = noMotion ? 0 : 0.34;
      const tl = gsap.timeline({ defaults: { duration, ease: "power2.out" } });

      if (cursor) gsap.set(cursor, { autoAlpha: 0, scale: 1 });

      const anchorName =
        typeof window !== "undefined" && window.innerWidth <= 767
          ? (step.mobileAnchor ?? step.anchor)
          : step.anchor;
      const anchor = anchorName ? visibleAnchor(anchorName) : null;

      if (anchor && cursor && !noMotion) {
        const rect = anchor.getBoundingClientRect();
        tl.set(cursor, {
          x: rect.right + 42,
          y: rect.top + rect.height / 2 + 26,
        })
          .to(cursor, { autoAlpha: 1, duration: 0.12 })
          .to(cursor, {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            duration: 0.46,
            ease: "power2.inOut",
          })
          .to(cursor, { scale: 0.72, duration: 0.09 })
          .to(cursor, { scale: 1, duration: 0.12 });
      }

      if (step.destination) {
        tl.call(() => onDemoNavigate?.(step.destination!));
      }
      if (step.demo === "assistant") {
        tl.call(() => onAssistantDemo?.(true));
      }
      if (cursor)
        tl.to(cursor, { autoAlpha: 0, duration: noMotion ? 0 : 0.15 });

      return () => {
        tl.kill();
        if (step.demo === "assistant") onAssistantDemo?.(false);
      };
    },
    {
      dependencies: [open, stepIndex, onDemoNavigate, onAssistantDemo],
      scope: rootRef,
      revertOnUpdate: true,
    },
  );

  if (!open) return null;

  const viewportHeight =
    typeof window === "undefined" ? 800 : window.innerHeight;
  const viewportWidth =
    typeof window === "undefined" ? 1280 : window.innerWidth;
  const cardHeight = cardRef.current?.offsetHeight ?? 330;
  const cardStyle: CSSProperties = highlight
    ? {
        top: Math.min(
          Math.max(18, highlight.top + highlight.height / 2 - 150),
          Math.max(18, viewportHeight - cardHeight - 18),
        ),
        left: Math.min(
          highlight.left + highlight.width + 18,
          viewportWidth - 390,
        ),
      }
    : {};

  return (
    <div ref={rootRef} className="cd-tour" role="presentation">
      <div className="cd-tour-blocker" />
      {highlight ? (
        <div
          className="cd-tour-focus"
          aria-hidden="true"
          style={{
            top: highlight.top,
            left: highlight.left,
            width: highlight.width,
            height: highlight.height,
            borderRadius: highlight.radius,
          }}
        />
      ) : (
        <div className="cd-tour-backdrop" aria-hidden="true" />
      )}
      <div ref={cursorRef} className="cd-tour-cursor" aria-hidden="true">
        <CDIcon name="cursor" size={25} strokeWidth={2.1} />
      </div>
      <div
        ref={cardRef}
        className={`cd-tour-dialog${highlight ? " cd-tour-dialog--anchored" : ""}`}
        style={cardStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cd-tour-title"
        aria-describedby="cd-tour-body"
        tabIndex={-1}
      >
        <Card className="cd-tour-card" pad={false}>
        <div className="cd-tour-topline">
          <span className="cd-tour-kicker">Quick tour · 1 min</span>
          {!finalStep && (
            <Btn
              className="cd-tour-skip"
              small
              onClick={() => onOutcome("skip")}
            >
              Skip for now
            </Btn>
          )}
        </div>

        <div className="cd-tour-icon" aria-hidden="true">
          <CDIcon name={step.icon} size={21} strokeWidth={1.8} />
        </div>
        <div className="cd-tour-eyebrow">{step.eyebrow}</div>
        <h2 className="cd-tour-title" id="cd-tour-title">
          {step.title}
        </h2>
        <p className="cd-tour-body" id="cd-tour-body">
          {step.body}
        </p>
        <p className="cd-tour-example">{step.example}</p>

        <div
          className="cd-tour-progress"
          aria-label={`Step ${stepIndex + 1} of ${TOUR_STEPS.length}`}
        >
          {TOUR_STEPS.map((item, index) => (
            <span
              key={item.eyebrow + index}
              data-active={index === stepIndex ? "1" : "0"}
            />
          ))}
          <span className="cd-tour-count tabular-nums">
            {stepIndex + 1} / {TOUR_STEPS.length}
          </span>
        </div>

        <div className="cd-tour-actions">
          {stepIndex > 0 && (
            <Btn
              className="cd-tour-btn cd-tour-btn--secondary"
              onClick={() => setStepIndex((value) => value - 1)}
            >
              Back
            </Btn>
          )}
          <Btn
            kind="primary"
            className="cd-tour-btn cd-tour-btn--primary"
            onClick={() => {
              if (finalStep) onOutcome("complete");
              else setStepIndex((value) => value + 1);
            }}
          >
            {finalStep
              ? "Start exploring"
              : stepIndex === 0
                ? "Show me around"
                : "Next"}
            {!finalStep && (
              <CDIcon name="arrowRight" size={15} strokeWidth={2} />
            )}
          </Btn>
        </div>
        </Card>
      </div>
    </div>
  );
}
