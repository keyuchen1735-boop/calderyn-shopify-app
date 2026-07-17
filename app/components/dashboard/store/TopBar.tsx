import { forwardRef, useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { CDIcon } from "../icons";
import { Btn } from "../ui";
import { reduced } from "../hero/hero-motion";
import type { PageKey } from "~/lib/storebuilder/types";

export type Device = "desktop" | "mobile";

const PAGE_OPTIONS: { key: PageKey; label: string; icon: string }[] = [
  { key: "home", label: "Home page", icon: "home" },
  { key: "pdp", label: "Product page", icon: "tag" },
  { key: "collection", label: "Collection", icon: "grid" },
];

const TopBar = forwardRef<
  HTMLSpanElement,
  {
    storefrontUrl: string;
    onOpenStorefront: () => void;
    hasPublished: boolean;
    building: boolean;
    page: PageKey;
    onPageChange: (page: PageKey) => void;
    device: Device;
    onDeviceChange: (device: Device) => void;
    onPublish: () => void;
    publishing: boolean;
    canPublish: boolean;
  }
>(function TopBar(
  {
    storefrontUrl,
    onOpenStorefront,
    hasPublished,
    building,
    page,
    onPageChange,
    device,
    onDeviceChange,
    onPublish,
    publishing,
    canPublish,
  },
  badgeRef,
) {
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const pageWrapRef = useRef<HTMLDivElement>(null);
  const pageMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      if (pageMenuOpen && pageWrapRef.current && !pageWrapRef.current.contains(event.target as Node)) {
        setPageMenuOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [pageMenuOpen]);

  useGSAP(() => {
    if (!pageMenuOpen || reduced() || !pageMenuRef.current) return;
    gsap.fromTo(
      pageMenuRef.current,
      { autoAlpha: 0, y: -6, scale: 0.96 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.22, ease: "power3.out", transformOrigin: "top right" },
    );
    gsap.from(pageMenuRef.current.children, { autoAlpha: 0, y: 5, duration: 0.2, stagger: 0.03, delay: 0.04 });
  }, { dependencies: [pageMenuOpen], scope: pageWrapRef });

  const activePage = PAGE_OPTIONS.find(({ key }) => key === page) ?? PAGE_OPTIONS[0];
  return (
    <div className="cd-studio-bar">
      <button type="button" className="cd-pill-url" onClick={onOpenStorefront} title="Open your storefront in a new tab">
        <span>{storefrontUrl.replace(/^https?:\/\//, "")}</span>
        <CDIcon name="external" size={12} strokeWidth={1.9} />
      </button>
      <span ref={badgeRef} className="cd-store-badge" data-state={building ? "building" : hasPublished ? "live" : "draft"}>
        {building ? "Building" : hasPublished ? "Live" : "Draft"}
      </span>
      <div className="cd-page-pick" ref={pageWrapRef}>
        <button
          type="button"
          className="cd-btn cd-btn-secondary cd-btn-sm"
          onClick={() => setPageMenuOpen((open) => !open)}
          aria-haspopup="listbox"
          aria-expanded={pageMenuOpen}
        >
          <CDIcon name={activePage.icon} size={13} strokeWidth={1.9} />
          {activePage.label}
          <CDIcon name="chevronDown" size={13} strokeWidth={2} />
        </button>
        {pageMenuOpen ? (
          <div className="cd-page-menu" ref={pageMenuRef} role="listbox" aria-label="Store page to preview">
            {PAGE_OPTIONS.map((option) => {
              const active = option.key === page;
              return (
                <button
                  key={option.key}
                  type="button"
                  className="cd-page-item"
                  data-active={active ? "1" : "0"}
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onPageChange(option.key);
                    setPageMenuOpen(false);
                  }}
                >
                  <CDIcon name={option.icon} size={14} strokeWidth={1.9} />
                  <span>{option.label}</span>
                  {active ? <CDIcon name="check" size={13} strokeWidth={2.4} className="cd-page-check" /> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <div className="cd-dev-seg">
        <button type="button" data-active={device === "desktop" ? "1" : "0"} onClick={() => onDeviceChange("desktop")}>
          <CDIcon name="monitor" size={13} strokeWidth={1.9} /> Desktop
        </button>
        <button type="button" data-active={device === "mobile" ? "1" : "0"} onClick={() => onDeviceChange("mobile")}>
          <CDIcon name="phone" size={13} strokeWidth={1.9} /> Mobile
        </button>
      </div>
      <Btn kind="primary" onClick={onPublish} disabled={!canPublish || publishing || building}>
        {publishing ? "Publishing…" : "Publish"}
      </Btn>
    </div>
  );
});

export default TopBar;
