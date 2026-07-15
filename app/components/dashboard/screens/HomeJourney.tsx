import { useMemo, useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { Card, Btn } from "../ui";
import { CDIcon } from "../icons";
import { reduced } from "../hero/hero-motion";
import { journeyView, JOURNEY_STEPS, PHASE_TITLES, type MilestoneKey } from "~/lib/dashboard/journey-model";
import type { DashboardCtx, Screen } from "../context";

// Mirrors the server's JourneyProgress shape (app/lib/onboarding/journey.server.ts)
// without importing that .server module into client code.
export interface JourneyProgress {
  completed: Partial<Record<MilestoneKey, string>>;
  liveCardDismissed: boolean;
  recapDismissed: boolean;
  activeStep: MilestoneKey | null;
  storefrontUrl: string | null;
}

// The 3-phase guided journey card that replaces the old static "Set up your
// store" checklist. One phase in focus at a time, one primary CTA on the
// step that's actually next — everything else in the phase reads as context,
// not competing asks. Retires permanently once the first real order lands
// (journeyView.retired), replaced by a one-shot recap.
export function HomeJourney({
  app,
  data,
  onDismiss,
  onSelectStep,
  onStartTestOrder,
}: {
  app: DashboardCtx;
  data: JourneyProgress;
  onDismiss: (key: "dismiss_live_card" | "dismiss_recap") => void;
  onSelectStep: (step: MilestoneKey) => void;
  onStartTestOrder: () => void;
}) {
  const view = useMemo(() => journeyView(data), [data]);
  const rootRef = useRef<HTMLDivElement>(null);
  const doneCount = view.steps.filter((s) => s.done).length;

  useGSAP(
    () => {
      if (reduced()) return;
      // Pop the most recently completed check into place; phase transitions
      // re-run this as the visible row set changes underneath it.
      gsap.from(".cd-jr-row.done .cd-jr-check", {
        scale: 0.5,
        opacity: 0,
        duration: 0.3,
        ease: "back.out(2)",
      });
    },
    { scope: rootRef, dependencies: [doneCount, view.phase] },
  );

  const go = (key: MilestoneKey, screen: string) => {
    if (screen === "__assistant") app.openAssistant("What should I fix first?");
    else if (screen === "__test_order") onStartTestOrder();
    else if (screen === "product-editor") app.navigate("product-editor", "new");
    else if (screen) app.navigate(screen as Screen);
  };

  if (view.retired) {
    if (!view.showRecap) return null;
    const started = data.completed.account ? new Date(data.completed.account) : null;
    const finished = data.completed.first_order ? new Date(data.completed.first_order) : null;
    const days =
      started && finished
        ? Math.max(1, Math.round((finished.getTime() - started.getTime()) / 86_400_000))
        : null;
    return (
      <Card className="cd-jr-recap" pad={false}>
        <div className="cd-jr-live-t">Setup complete.</div>
        <p className="cd-caption">
          {days ? `From zero to first order in ${days} day${days === 1 ? "" : "s"}.` : "Store live and selling."}
          {data.storefrontUrl ? (
            <>
              {" "}
              Live at{" "}
              <a href={data.storefrontUrl} target="_blank" rel="noreferrer">
                {data.storefrontUrl}
              </a>
              .
            </>
          ) : null}
        </p>
        <Btn small onClick={() => onDismiss("dismiss_recap")}>
          Done
        </Btn>
      </Card>
    );
  }

  const phaseSteps = view.steps.filter((s) => s.def.phase === view.phase);
  const activeIndex = view.active
    ? JOURNEY_STEPS.findIndex((step) => step.key === view.active)
    : -1;
  // Account creation happens before this card is available, so it is context,
  // not a destination for the Back button.
  const previousStep = activeIndex > 1 ? JOURNEY_STEPS[activeIndex - 1] : null;
  const followingStep = activeIndex >= 0 ? JOURNEY_STEPS[activeIndex + 1] ?? null : null;
  const activeState = view.steps.find((step) => step.def.key === view.active) ?? null;
  return (
    <div ref={rootRef}>
      {view.showLiveCard && (
        <Card className="cd-jr-live" pad={false}>
          <div className="cd-jr-live-t">Your store is live.</div>
          {data.storefrontUrl && (
            <div className="cd-jr-live-url">
              <a href={data.storefrontUrl} target="_blank" rel="noreferrer">
                {data.storefrontUrl}
              </a>
              <Btn
                small
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(data.storefrontUrl!);
                    app.toast("Link copied", "check");
                  } catch {
                    app.toast("Couldn't copy — select the link manually.", "x", "critical");
                  }
                }}
              >
                Copy link
              </Btn>
            </div>
          )}
          <button
            type="button"
            className="cd-jr-x"
            aria-label="Dismiss"
            onClick={() => onDismiss("dismiss_live_card")}
          >
            <CDIcon name="x" size={14} />
          </button>
        </Card>
      )}
      <Card className="cd-jr-card" pad={false}>
        <div className="cd-jr-head">
          <span className="cd-jr-title">{PHASE_TITLES[view.phase]}</span>
          {view.phasesComplete.map((p) => (
            <span key={p} className="cd-jr-chip">
              <CDIcon name="check" size={12} /> {PHASE_TITLES[p]}
            </span>
          ))}
          <span className="cd-caption tabular-nums">
            {phaseSteps.filter((s) => s.done).length} of {phaseSteps.length}
          </span>
        </div>
        {phaseSteps.map((s) => {
          const spotlight = s.def.key === view.active;
          return (
            <div
              key={s.def.key}
              className={`cd-jr-row${s.done ? " done" : ""}${spotlight ? " spot" : ""}`}
            >
              <span className="cd-jr-check">
                <CDIcon name={s.done ? "check" : "circle"} size={16} strokeWidth={2} />
              </span>
              <div className="cd-jr-body">
                <div className="cd-jr-t">{s.def.label}</div>
                {spotlight && s.def.pitch && <div className="cd-jr-s">{s.def.pitch}</div>}
              </div>
              {spotlight && !s.done && s.def.cta && (
                <Btn kind="primary" small onClick={() => go(s.def.key, s.def.screen)}>
                  {s.def.cta}
                </Btn>
              )}
            </div>
          );
        })}
        {(previousStep || followingStep) && (
          <div className="cd-jr-nav">
            {previousStep && (
              <Btn small onClick={() => onSelectStep(previousStep.key)}>
                Back
              </Btn>
            )}
            {followingStep && (
              <Btn small onClick={() => onSelectStep(followingStep.key)}>
                {activeState?.done ? "Next" : "Skip for now"}
              </Btn>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
