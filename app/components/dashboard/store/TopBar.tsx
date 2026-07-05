// The stage's top bar: one row of uniform 32px pills (design D6). Every pill
// is presentational; Store.tsx owns the underlying state and network calls.
import { forwardRef, useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { CDIcon } from "../icons";
import { Btn } from "../ui";
import { reduced } from "../hero/hero-motion";
import type { StudioExperiment } from "~/lib/dashboard/store-client";
import type { PageKey } from "~/lib/storebuilder/types";

export type Device = "desktop" | "mobile";

const PAGE_OPTIONS: { key: PageKey; label: string; icon: string }[] = [
  { key: "home", label: "Home page", icon: "home" },
  { key: "pdp", label: "Product page", icon: "tag" },
  { key: "collection", label: "Collection", icon: "grid" },
];

function rate(conversions: number, sessions: number): string {
  return `${((conversions / Math.max(1, sessions)) * 100).toFixed(1)}% · ${sessions.toLocaleString()}`;
}

function ExperimentPopover({
  experiment,
  onDecide,
  deciding,
}: {
  experiment: StudioExperiment;
  onDecide: (decision: "ship" | "keep" | "stop") => void;
  deciding: boolean;
}) {
  const report = experiment.report;
  const aRate = report ? report.aConversions / Math.max(1, report.aSessions) : 0;
  const bRate = report ? report.bConversions / Math.max(1, report.bSessions) : 0;
  const maxRate = Math.max(aRate, bRate, 0.001);
  const canDecideNow = report?.confidence != null && report.confidence >= 95;
  return (
    <div className="cd-exp-pop" role="dialog" aria-label={`${experiment.name} test`}>
      <div className="cd-exp-name">Testing your {experiment.name}</div>
      <div className="cd-exp-sub">{experiment.why}</div>
      {report && (
        <>
          <div className="cd-exp-bars">
            <div className="cd-exp-bar-row" data-lead={bRate <= aRate ? "1" : "0"}>
              <b>A</b>
              <span className="cd-exp-bar">
                <i style={{ width: `${Math.round((aRate / maxRate) * 100)}%` }} />
              </span>
              <span className="cd-exp-num">{rate(report.aConversions, report.aSessions)}</span>
            </div>
            <div className="cd-exp-bar-row" data-lead={bRate > aRate ? "1" : "0"}>
              <b>B</b>
              <span className="cd-exp-bar">
                <i style={{ width: `${Math.round((bRate / maxRate) * 100)}%` }} />
              </span>
              <span className="cd-exp-num">{rate(report.bConversions, report.bSessions)}</span>
            </div>
          </div>
          <div className="cd-exp-meta">
            <span className="cd-conf-track">
              <i style={{ width: `${report.confidence ?? 0}%` }} />
            </span>
            <span>{report.confidence == null ? "warming up" : `${report.confidence}% sure`}</span>
          </div>
        </>
      )}
      <div className="cd-exp-actions">
        {canDecideNow ? (
          <>
            <Btn kind="primary" small onClick={() => onDecide("ship")} disabled={deciding}>
              Ship
            </Btn>
            <Btn small onClick={() => onDecide("keep")} disabled={deciding}>
              Keep
            </Btn>
          </>
        ) : (
          <Btn small onClick={() => onDecide("stop")} disabled={deciding}>
            Stop early
          </Btn>
        )}
      </div>
    </div>
  );
}

const TopBar = forwardRef<
  HTMLSpanElement,
  {
    storefrontUrl: string;
    onOpenStorefront: () => void;
    hasPublished: boolean;
    building: boolean;
    experiment: StudioExperiment | null;
    onDecideExperiment: (decision: "ship" | "keep" | "stop") => void;
    decidingExperiment: boolean;
    page: PageKey;
    onPageChange: (page: PageKey) => void;
    device: Device;
    onDeviceChange: (device: Device) => void;
    markupOn: boolean;
    onToggleMarkup: () => void;
    onPublish: () => void;
    publishing: boolean;
  }
>(function TopBar(
  {
    storefrontUrl,
    onOpenStorefront,
    hasPublished,
    building,
    experiment,
    onDecideExperiment,
    decidingExperiment,
    page,
    onPageChange,
    device,
    onDeviceChange,
    markupOn,
    onToggleMarkup,
    onPublish,
    publishing,
  },
  badgeRef,
) {
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [expPopOpen, setExpPopOpen] = useState(false);
  const pageWrapRef = useRef<HTMLDivElement>(null);
  const expWrapRef = useRef<HTMLDivElement>(null);
  const pageMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (pageMenuOpen && pageWrapRef.current && !pageWrapRef.current.contains(t)) setPageMenuOpen(false);
      if (expPopOpen && expWrapRef.current && !expWrapRef.current.contains(t)) setExpPopOpen(false);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [pageMenuOpen, expPopOpen]);

  // Close the running experiment's popover if the experiment itself goes away
  // (decided elsewhere, e.g. a second tab) — never leave a stale popover open.
  useEffect(() => {
    if (!experiment || experiment.state !== "running") setExpPopOpen(false);
  }, [experiment]);

  useGSAP(
    () => {
      if (!pageMenuOpen || reduced() || !pageMenuRef.current) return;
      gsap.fromTo(
        pageMenuRef.current,
        { autoAlpha: 0, y: -6, scale: 0.96 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.22, ease: "power3.out", transformOrigin: "top right" },
      );
      gsap.from(pageMenuRef.current.children, { autoAlpha: 0, y: 5, duration: 0.2, stagger: 0.03, delay: 0.04 });
    },
    { dependencies: [pageMenuOpen], scope: pageWrapRef },
  );

  const activePage = PAGE_OPTIONS.find((p) => p.key === page) ?? PAGE_OPTIONS[0];
  const running = experiment && experiment.state === "running" ? experiment : null;

  return (
    <div className="cd-studio-bar">
      <button type="button" className="cd-pill-url" onClick={onOpenStorefront} title="Open your storefront in a new tab">
        <span>{storefrontUrl.replace(/^https?:\/\//, "")}</span>
        <CDIcon name="external" size={12} strokeWidth={1.9} />
      </button>

      <span ref={badgeRef} className="cd-store-badge" data-state={building ? "building" : hasPublished ? "live" : "draft"}>
        {building ? "Building" : hasPublished ? "Live" : "Draft"}
      </span>

      {running && (
        <div className="cd-exp-wrap" ref={expWrapRef}>
          <button
            type="button"
            className="cd-exp-pill"
            onClick={() => setExpPopOpen((v) => !v)}
            aria-expanded={expPopOpen}
          >
            <i aria-hidden="true" />
            Testing {running.name}
            {running.report?.confidence != null ? ` · ${running.report.confidence}%` : ""}
          </button>
          {expPopOpen && (
            <ExperimentPopover experiment={running} onDecide={onDecideExperiment} deciding={decidingExperiment} />
          )}
        </div>
      )}

      <div className="cd-page-pick" ref={pageWrapRef}>
        <button
          type="button"
          className="cd-btn cd-btn-secondary cd-btn-sm"
          onClick={() => setPageMenuOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={pageMenuOpen}
        >
          <CDIcon name={activePage.icon} size={13} strokeWidth={1.9} />
          {activePage.label}
          <CDIcon name="chevronDown" size={13} strokeWidth={2} />
        </button>
        {pageMenuOpen && (
          <div className="cd-page-menu" ref={pageMenuRef} role="listbox" aria-label="Store page to preview">
            {PAGE_OPTIONS.map((p) => {
              const active = p.key === page;
              return (
                <button
                  key={p.key}
                  type="button"
                  className="cd-page-item"
                  data-active={active ? "1" : "0"}
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onPageChange(p.key);
                    setPageMenuOpen(false);
                  }}
                >
                  <CDIcon name={p.icon} size={14} strokeWidth={1.9} />
                  <span>{p.label}</span>
                  {active && <CDIcon name="check" size={13} strokeWidth={2.4} className="cd-page-check" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="cd-dev-seg">
        <button type="button" data-active={device === "desktop" ? "1" : "0"} onClick={() => onDeviceChange("desktop")}>
          <CDIcon name="monitor" size={13} strokeWidth={1.9} />
          Desktop
        </button>
        <button type="button" data-active={device === "mobile" ? "1" : "0"} onClick={() => onDeviceChange("mobile")}>
          <CDIcon name="phone" size={13} strokeWidth={1.9} />
          Mobile
        </button>
      </div>

      <Btn kind={markupOn ? "primary" : "secondary"} icon="pencil" onClick={onToggleMarkup}>
        {markupOn ? "Cancel" : "Mark up"}
      </Btn>
      <Btn kind="primary" onClick={onPublish} disabled={publishing || building}>
        {publishing ? "Publishing…" : "Publish"}
      </Btn>
    </div>
  );
});

export default TopBar;
