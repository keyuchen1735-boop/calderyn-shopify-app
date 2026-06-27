// Imperative GSAP motion for the Live Engine hero: the feature-meter draw, the
// calibration ring, the watching scan, and the full approve sequence (fold ->
// fly to the matching group -> Queued/Running/Done -> fly to the Acting card ->
// execute), using a lifted quadratic-bezier chip arc. Flags and actions come
// from real data and real approvals (see CalderynLog.tsx); this module only
// animates and never drives a synthetic timer loop.
import gsap from "gsap";
import { CustomEase } from "gsap/CustomEase";
import type { WatchGroup, LeDockDetail } from "../engine-events";
import { scanLineFor } from "../../../lib/calibration/watch-scan";

let easesReady = false;
function ensureEases(): void {
  if (easesReady) return;
  gsap.registerPlugin(CustomEase);
  CustomEase.create("m3emph", "M0,0 C0.05,0.7 0.1,1 1,1");
  CustomEase.create("m3std", "M0,0 C0.2,0 0,1 1,1");
  easesReady = true;
}
const EMPH = "m3emph";

function reduced(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function q<T extends Element>(root: ParentNode, sel: string): T | null {
  return root.querySelector<T>(sel);
}

/** Group → restore icon (stroke SVG, matching the Watching row glyphs). */
const GROUP_ICO: Record<WatchGroup, string> = {
  inv: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 9.4 7.5 4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  ads: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>',
  price: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.4" fill="currentColor" stroke="none"/></svg>',
  ret: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
};
/** Neutral, truthful activity lines shown when a group has no names to roll. */
const SCAN_ASPECTS: Record<WatchGroup, string[]> = {
  inv: ["Checking stock levels", "Stock vs forecast"],
  ads: ["Checking ROAS", "Budget pacing"],
  price: ["Checking margins", "Price vs market"],
  ret: ["Checking repeat orders", "Churn signals"],
};
const CHECK_ICO =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const HEX_MARK =
  '<svg viewBox="0 0 32 32" width="14" height="14" fill="none" stroke="var(--ha-on-accent)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"><path d="M16 2 L28.12 9 L28.12 23 L16 30 L3.88 23 L3.88 9 Z"/><path d="M24.4 11.15 L16 6.3 L7.6 11.15 L7.6 20.85 L16 25.7 L24.4 20.85"/></svg>';

const CAL_C = 122.52; // circumference of the r=19.5 calibration arc

/**
 * Owns the hero's imperative animations. One instance per mounted hero, created
 * inside useGSAP and torn down via destroy(). All transient nodes clean
 * themselves up; destroy() kills tweens/timers and removes any stragglers.
 */
export class HeroEngine {
  private root: HTMLElement;
  private live: HTMLElement | null;
  private speed: number;
  private timers: gsap.core.Tween[] = [];
  private flights: gsap.core.Timeline[] = [];
  private dockQueue: LeDockDetail[] = [];
  private docking = false;
  private hexOff: number | null = null;
  private calVal = 0;
  private reasonOpen = false;
  private reasonAnimating = false;
  private busy = false;
  private destroyed = false;
  private watchI = -1;
  private scan: Record<WatchGroup, string[]> = { inv: [], ads: [], price: [], ret: [] };
  private scanTick = 0;
  private strays: HTMLElement[] = [];

  constructor(root: HTMLElement, opts?: { speed?: number }) {
    ensureEases();
    this.root = root;
    this.live = q<HTMLElement>(root, '[data-role="live"]');
    this.speed = opts?.speed ?? 1;
  }

  private wait(t: number, fn: () => void): void {
    const c = gsap.delayedCall(t, () => {
      if (!this.destroyed) fn();
    });
    this.timers.push(c as unknown as gsap.core.Tween);
  }

  private track<T extends HTMLElement>(el: T): T {
    this.strays.push(el);
    return el;
  }

  destroy(): void {
    this.destroyed = true;
    this.timers.forEach((t) => t.kill());
    this.timers = [];
    this.flights.forEach((tl) => tl.kill());
    this.flights = [];
    this.dockQueue = [];
    gsap.killTweensOf(this.root.querySelectorAll("*"));
    this.strays.forEach((el) => el.remove());
    this.strays = [];
  }

  // ---- ambient: feature meter (hex), calibration ring, title state ----

  updateMeter(onCount: number, total: number, animate = true): void {
    const hex = q<SVGPathElement>(this.root, ".ha-hexprog");
    if (!hex) return;
    const target = 1 - onCount / Math.max(1, total);
    const cur = this.hexOff == null ? 1 : this.hexOff;
    this.hexOff = target;
    if (reduced() || !animate) {
      hex.setAttribute("stroke-dashoffset", String(target));
      return;
    }
    const o = { v: cur };
    gsap.to(o, {
      v: target,
      duration: 0.75,
      ease: EMPH,
      onUpdate: () => hex.setAttribute("stroke-dashoffset", String(o.v)),
    });
  }

  updateCalibration(pct: number, note: string, animate = true): void {
    const arc = q<SVGCircleElement>(this.root, "[data-cal-arc]");
    const num = q<HTMLElement>(this.root, "[data-cal-pct]");
    const noteEl = q<HTMLElement>(this.root, "[data-cal-note]");
    const v = Math.max(0, Math.min(100, pct));
    const from = this.calVal;
    this.calVal = v;
    if (noteEl) noteEl.innerHTML = note;
    const setArc = (p: number) => arc && arc.setAttribute("stroke-dashoffset", (CAL_C * (1 - p / 100)).toFixed(2));
    const setNum = (p: number) => num && (num.textContent = String(Math.round(p)));
    if (reduced() || !animate) {
      setArc(v);
      setNum(v);
      return;
    }
    const o = { v: from };
    gsap.to(o, {
      v,
      duration: 0.7,
      ease: EMPH,
      onUpdate: () => {
        setArc(o.v);
        setNum(o.v);
      },
    });
  }

  /** Optimistic ring nudge on an approve/deny before real data reconciles. */
  bumpCalibration(kind: "approve" | "deny", note: string): void {
    const inc = kind === "deny" ? 3 : 6;
    const next = Math.min(100, this.calVal + inc);
    const num = q<HTMLElement>(this.root, "[data-cal-pct]");
    if (num && !reduced()) gsap.fromTo(num, { scale: 1.18 }, { scale: 1, duration: 0.5, ease: "back.out(2.4)" });
    this.updateCalibration(next, note);
  }

  setTitle(running: boolean): void {
    const word = q<HTMLElement>(this.root, "[data-state-word]");
    if (!word) return;
    const text = running ? "running" : "watching";
    if (word.textContent === text) return;
    if (reduced()) {
      word.textContent = text;
      return;
    }
    gsap
      .timeline()
      .to(word, { autoAlpha: 0, duration: 0.22, ease: "power1.in", onComplete: () => (word.textContent = text) })
      .to(word, { autoAlpha: 1, duration: 0.28, ease: "power1.out" });
  }

  // ---- reasoning panel ----

  toggleReason(force?: boolean): void {
    const body = q<HTMLElement>(this.root, "[data-reason-body]");
    const chev = q<HTMLElement>(this.root, "[data-reason-chev]");
    const label = q<HTMLElement>(this.root, "[data-reason-label]");
    if (!body || this.reasonAnimating) return;
    const open = force == null ? !this.reasonOpen : force;
    if (open === this.reasonOpen) return;
    this.reasonOpen = open;
    if (label) label.textContent = open ? "Hide reasoning" : "Watch Calderyn reason";
    if (chev && !reduced()) gsap.to(chev, { rotate: open ? 180 : 0, duration: 0.26, ease: EMPH });
    else if (chev) chev.style.transform = `rotate(${open ? 180 : 0}deg)`;
    if (reduced()) {
      body.style.height = open ? "auto" : "0";
      return;
    }
    this.reasonAnimating = true;
    const inner = body.firstElementChild as HTMLElement | null;
    const full = inner ? inner.offsetHeight : body.scrollHeight;
    if (open) {
      gsap.fromTo(
        body,
        { height: 0 },
        { height: full, duration: 0.42, ease: EMPH, onComplete: () => { body.style.height = "auto"; this.reasonAnimating = false; } },
      );
      if (inner) {
        const items = Array.from(inner.querySelectorAll<HTMLElement>("[data-watch-row], [data-act-col]"));
        gsap.fromTo(items, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.4, stagger: 0.05, ease: EMPH, delay: 0.08 });
      }
    } else {
      gsap.to(body, { height: 0, duration: 0.34, ease: "power2.inOut", onComplete: () => (this.reasonAnimating = false) });
    }
  }

  openReason(): void {
    if (!this.reasonOpen) this.toggleReason(true);
  }

  /** Mark the panel open WITHOUT animating (the Overview renders it open). */
  setReasonInitial(open: boolean): void {
    this.reasonOpen = open;
    const body = q<HTMLElement>(this.root, "[data-reason-body]");
    if (body) body.style.height = open ? "auto" : "0";
  }

  isReasonOpen(): boolean {
    return this.reasonOpen;
  }

  // ---- watching scan (ambient shimmer, real flags) ----

  startWatch(): void {
    const rows = this.watchRows();
    if (!rows.length || reduced()) return;
    const step = () => {
      if (this.destroyed || this.busy) return;
      this.watchI = (this.watchI + 1) % rows.length;
      rows.forEach((r, k) => this.setRowScan(r, k === this.watchI));
      this.wait(2.6, step);
    };
    this.wait(0.5, step);
    this.startScan();
  }

  stopWatch(): void {
    this.busy = true;
    this.timers.forEach((t) => t.kill());
    this.timers = [];
    this.watchRows().forEach((r) => this.setRowScan(r, false));
  }

  private resumeWatch(): void {
    this.busy = false;
    this.startWatch();
  }

  private watchRows(): HTMLElement[] {
    return this.live ? Array.from(this.live.querySelectorAll<HTMLElement>("[data-watch-row]")) : [];
  }

  private setRowScan(row: HTMLElement, active: boolean): void {
    const sweep = q<HTMLElement>(row, "[data-watch-sweep]");
    if (!sweep) return;
    if (active && !reduced()) {
      sweep.style.opacity = "1";
      sweep.classList.add("ha-rowscan");
    } else {
      sweep.style.opacity = "0";
      sweep.classList.remove("ha-rowscan");
    }
  }

  // ---- per-row scan ticker (real names rolling up/in, one line) ----

  /** Provide the real per-group names. Renders the current line on each row
   *  immediately (no animation) so a data refresh never blanks the ticker. */
  setScan(lists: Record<WatchGroup, string[]>): void {
    this.scan = lists;
    this.watchRows().forEach((row) => this.renderScan(row, false));
  }

  private scanTextFor(g: WatchGroup): string {
    return scanLineFor(this.scan[g] ?? [], SCAN_ASPECTS[g] ?? [], this.scanTick);
  }

  private renderScan(row: HTMLElement, animate: boolean): void {
    const el = q<HTMLElement>(row, "[data-watch-scan]");
    const g = row.getAttribute("data-group") as WatchGroup | null;
    if (!el || !g) return;
    const next = this.scanTextFor(g);
    if (!animate || reduced()) {
      el.textContent = next;
      gsap.set(el, { y: 0, autoAlpha: 1 });
      return;
    }
    const tl = gsap.timeline();
    tl.to(el, { y: -10, autoAlpha: 0, duration: 0.22, ease: "power1.in" })
      .add(() => { el.textContent = next; })
      .fromTo(el, { y: 10, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.3, ease: EMPH });
  }

  private startScan(): void {
    if (reduced()) return;
    const step = () => {
      if (this.destroyed || this.busy) return;
      this.scanTick += 1;
      // Small per-row stagger for a cascade; only idle (non-flagged) rows roll.
      this.watchRows().forEach((row, k) => {
        const g = row.getAttribute("data-group") as WatchGroup | null;
        const sub = q<HTMLElement>(row, "[data-watch-sub]");
        const subShown = !!sub && sub.style.display !== "none";
        if (g && !subShown) this.wait(0.08 * k, () => this.renderScan(row, true));
      });
      this.wait(2.4, step);
    };
    this.wait(2.4, step);
  }

  /** Mark which groups currently hold a pending (flagged) item — amber row.
   *  Skipped while a sequence is running so a concurrent data refresh can't
   *  fight the dock sequence for control of a row's styling. */
  setFlags(groups: Set<WatchGroup>): void {
    if (this.busy) return;
    this.watchRows().forEach((row) => {
      const g = row.getAttribute("data-group") as WatchGroup | null;
      const flagged = !!g && groups.has(g);
      const dot = q<HTMLElement>(row, "[data-watch-dot]");
      const txt = q<HTMLElement>(row, "[data-watch-txt]");
      const stat = q<HTMLElement>(row, "[data-watch-stat]");
      row.style.borderColor = flagged ? "var(--ha-flag-line)" : "var(--ha-line-2)";
      row.style.background = flagged ? "var(--ha-flag-bg)" : "var(--ha-surface)";
      if (dot) dot.style.background = flagged ? "var(--ha-flag)" : "var(--ha-ink-3)";
      if (stat) stat.style.color = flagged ? "var(--ha-flag)" : "var(--ha-ink-3)";
      if (txt) txt.textContent = flagged ? "Needs you" : "All good";
      const scanEl = q<HTMLElement>(row, "[data-watch-scan]");
      if (scanEl) {
        scanEl.style.visibility = flagged ? "hidden" : "visible";
        if (!flagged) this.renderScan(row, false);
      }
    });
  }

  // ---- the approve sequence (le-dock): dock in group → chip → execute ----

  dock(detail: LeDockDetail): void {
    // Serialize: a second approve while one sequence is running is queued and
    // played after it, so neither sequence's timers are killed out from under it.
    if (this.docking) {
      this.dockQueue.push(detail);
      return;
    }
    this.docking = true;
    const begin = () => {
      if (this.destroyed || !this.live) return;
      const row = this.live.querySelector<HTMLElement>(`[data-watch-row][data-group="${detail.group}"]`);
      if (!row || row.getBoundingClientRect().width < 12) {
        requestAnimationFrame(begin);
        return;
      }
      this.stopWatch();
      this.runDockSequence(row, detail, () => {
        const rect = row.getBoundingClientRect();
        const flag = {
          icon: detail.icon,
          label: detail.label,
          money: detail.money,
          moneyShort: detail.moneyShort,
          steps: detail.steps && detail.steps.length ? detail.steps : ["Preparing", "Submitting to engine", "Confirming"],
        };
        this.chipFlyToAct({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }, flag.label, () => {
          this.actExecute(flag, () => this.afterDock());
        });
      });
    };
    if (!this.reasonOpen) {
      this.openReason();
      if (!reduced()) this.wait(0.5, begin);
      else begin();
    } else begin();
  }

  private afterDock(): void {
    this.docking = false;
    this.flights = this.flights.filter((tl) => tl.isActive());
    if (this.destroyed) return;
    const next = this.dockQueue.shift();
    if (next) this.dock(next);
    else this.resumeWatch();
  }

  private setSub(row: HTMLElement, text: string): void {
    const sub = q<HTMLElement>(row, "[data-watch-sub]");
    const scanEl = q<HTMLElement>(row, "[data-watch-scan]");
    if (!sub) return;
    sub.textContent = text;
    sub.style.display = "flex";
    sub.style.color = "var(--ha-accent)";
    if (scanEl) scanEl.style.visibility = "hidden";
    if (!reduced()) gsap.fromTo(sub, { autoAlpha: 0, y: 4 }, { autoAlpha: 1, y: 0, duration: 0.32, ease: EMPH });
  }

  private runDockSequence(row: HTMLElement, d: LeDockDetail, done: () => void): void {
    const stat = q<HTMLElement>(row, "[data-watch-stat]");
    const dot = q<HTMLElement>(row, "[data-watch-dot]");
    const txt = q<HTMLElement>(row, "[data-watch-txt]");
    const ico = q<HTMLElement>(row, "[data-watch-ico]");
    const label = d.label || "Approved action";
    if (dot) dot.style.animation = "none";
    // 1 — intake: accent border + pop, status Queued
    row.style.opacity = "1";
    row.style.borderStyle = "solid";
    row.style.borderColor = "var(--ha-accent)";
    row.style.background = "color-mix(in srgb, var(--ha-accent) 7%, var(--ha-surface))";
    if (!reduced()) gsap.fromTo(row, { scale: 0.96 }, { scale: 1, duration: 0.55, ease: "back.out(2.2)", transformOrigin: "50% 50%" });
    if (dot) dot.style.background = "var(--ha-accent)";
    if (txt) txt.textContent = "Queued";
    if (stat) stat.style.color = "var(--ha-accent)";
    if (ico) {
      ico.style.background = "color-mix(in srgb, var(--ha-accent) 14%, transparent)";
      ico.style.color = "var(--ha-accent)";
    }
    this.setSub(row, label);
    // 2 — running, thin progress sweep inside the row
    this.wait(1.45, () => {
      if (txt) txt.textContent = "Running";
      this.setSub(row, label);
      let bar = q<HTMLElement>(row, "[data-dock-bar]");
      if (!bar) {
        bar = document.createElement("span");
        bar.setAttribute("data-dock-bar", "");
        bar.style.cssText = "position:absolute;left:0;bottom:0;height:2px;width:0%;background:var(--ha-accent);border-radius:2px;z-index:2;";
        row.appendChild(bar);
      }
      const barEl = bar;
      if (!reduced()) gsap.fromTo(barEl, { width: "0%" }, { width: "100%", duration: 1.9, ease: "power1.inOut" });
      // 3 — done, then settle back to watching
      this.wait(2.0, () => {
        if (txt) txt.textContent = "Done";
        this.setSub(row, label + " · done");
        if (ico) {
          ico.innerHTML = CHECK_ICO;
          if (!reduced()) gsap.fromTo(ico, { scale: 0.5 }, { scale: 1, duration: 0.5, ease: "back.out(2.6)" });
        }
        this.wait(1.4, () => {
          barEl.remove();
          const g = row.getAttribute("data-group") as WatchGroup | null;
          if (ico && g) ico.innerHTML = GROUP_ICO[g] ?? GROUP_ICO.inv;
          if (ico) {
            ico.style.background = "var(--ha-fill)";
            ico.style.color = "var(--ha-ink-2)";
          }
          row.style.borderColor = "var(--ha-line-2)";
          row.style.background = "var(--ha-surface)";
          if (dot) dot.style.background = "var(--ha-ink-3)";
          if (stat) stat.style.color = "var(--ha-ink-3)";
          if (txt) txt.textContent = "All good";
          const sub = q<HTMLElement>(row, "[data-watch-sub]");
          if (sub) sub.style.display = "none";
          const scanEl = q<HTMLElement>(row, "[data-watch-scan]");
          if (scanEl) { scanEl.style.visibility = "visible"; gsap.set(scanEl, { y: 0, autoAlpha: 1 }); }
          done();
        });
      });
    });
  }

  /** Chip flies from a source rect along a lifted bezier into the Acting card. */
  private chipFlyToAct(srcRect: { left: number; top: number; width: number; height: number }, label: string, onArrive: () => void): void {
    const live = this.live;
    const card = live && q<HTMLElement>(live, "[data-act-card]");
    const stateEl = live && q<HTMLElement>(live, "[data-act-state]");
    if (reduced() || !live || !card || !srcRect.width) {
      if (stateEl) this.armReceiving(stateEl);
      onArrive();
      return;
    }
    const cr = card.getBoundingClientRect();
    const chip = this.track(document.createElement("div"));
    const h0 = Math.max(26, Math.min(srcRect.height, 32));
    chip.style.cssText =
      "position:fixed;z-index:99999;left:0;top:0;display:flex;align-items:center;gap:9px;box-sizing:border-box;padding:0 12px;height:" +
      h0 +
      "px;border-radius:12px;background:var(--ha-surface);border:1.5px solid var(--ha-accent);box-shadow:0 18px 42px -12px rgba(0,0,0,.45);pointer-events:none;overflow:hidden;color:var(--ha-ink);font-family:inherit;will-change:transform,width,height;";
    chip.innerHTML =
      '<span style="width:22px;height:22px;border-radius:7px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;background:var(--ha-accent);">' +
      HEX_MARK +
      '</span><span style="font-size:12px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
      label +
      "</span>";
    document.body.appendChild(chip);
    const w0 = Math.min(Math.max(srcRect.width, 120), 200);
    const x0 = srcRect.left + 4,
      y0 = srcRect.top + (srcRect.height - h0) / 2;
    gsap.set(chip, { x: x0, y: y0, width: w0, autoAlpha: 0 });
    const hL = 30,
      wL = Math.min(cr.width - 24, 150);
    const x1 = cr.left + 14,
      y1 = cr.top + 16;
    const cx = (x0 + x1) / 2,
      cy = Math.min(y0, y1) - 84; // control point lifted ~84px
    const proxy = { t: 0 };
    const bez = (t: number) => {
      const u = 1 - t;
      return { x: u * u * x0 + 2 * u * t * cx + t * t * x1, y: u * u * y0 + 2 * u * t * cy + t * t * y1 };
    };
    if (stateEl) {
      this.armReceiving(stateEl);
      gsap.fromTo(stateEl, { scale: 0.86 }, { scale: 1, duration: 0.45, ease: "back.out(2.4)", transformOrigin: "0% 50%" });
    }
    const marker = this.makeIntakeOutline(card);
    const sp = this.speed;
    const arrive = () => {
      chip.remove();
      if (this.destroyed) {
        marker.remove();
        return;
      }
      this.impact(card, marker, 18, 18);
      onArrive();
    };
    const flight = gsap
      .timeline({ onComplete: arrive })
      .to(chip, { autoAlpha: 1, duration: 0.26 * sp, ease: "power2.out" })
      .to(chip, { width: wL, height: hL, duration: 0.6 * sp, ease: "power2.inOut" }, 0.08)
      .to(proxy, { t: 1, duration: 1.1 * sp, ease: "power2.inOut", onUpdate: () => { const p = bez(proxy.t); gsap.set(chip, { x: p.x, y: p.y }); } }, 0.12)
      .to(chip, { autoAlpha: 0, duration: 0.18 * sp, ease: "power2.in" }, "-=0.12");
    this.flights.push(flight);
  }

  private armReceiving(stateEl: HTMLElement): void {
    stateEl.textContent = "RECEIVING";
    stateEl.style.background = "var(--ha-fill)";
    stateEl.style.color = "var(--ha-ink-2)";
  }

  /**
   * Intake outline that traces the card's TRUE outer edge. Implemented as a
   * fixed-position overlay at the card's real bounding rect (+2px), NOT a child
   * with inset:-2px: the card's rounded clip would otherwise push a child border
   * onto the inner edge.
   */
  private makeIntakeOutline(card: HTMLElement): HTMLElement {
    const r = card.getBoundingClientRect();
    const marker = this.track(document.createElement("div"));
    marker.style.cssText =
      "position:fixed;left:0;top:0;z-index:99998;border-radius:14px;border:1.5px solid var(--ha-accent);opacity:0;pointer-events:none;box-sizing:border-box;";
    gsap.set(marker, { x: r.left - 2, y: r.top - 2, width: r.width + 4, height: r.height + 4 });
    document.body.appendChild(marker);
    gsap.to(marker, { opacity: 0.5, duration: 0.5, ease: "sine.out" });
    return marker;
  }

  private impact(card: HTMLElement, marker: HTMLElement, ringX: number, ringY: number): void {
    const ring = document.createElement("div");
    ring.style.cssText =
      "position:absolute;left:" + ringX + "px;top:" + ringY + "px;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;border:2px solid var(--ha-accent);pointer-events:none;box-sizing:border-box;";
    card.appendChild(ring);
    const sweepWrap = document.createElement("div");
    sweepWrap.style.cssText = "position:absolute;inset:0;border-radius:12px;overflow:hidden;pointer-events:none;";
    const sweep = document.createElement("div");
    sweep.style.cssText =
      "position:absolute;top:0;bottom:0;width:46%;left:-55%;background:linear-gradient(100deg,transparent,color-mix(in srgb,var(--ha-accent) 26%,transparent),transparent);transform:skewX(-14deg);";
    sweepWrap.appendChild(sweep);
    card.appendChild(sweepWrap);
    const ico = this.live && q<HTMLElement>(this.live, "[data-act-ico]");
    const tl = gsap
      .timeline({ onComplete: () => { ring.remove(); sweepWrap.remove(); marker.remove(); } })
      .to(card, { scale: 0.965, duration: 0.1, ease: "power2.in", transformOrigin: "12% 24%" }, 0)
      .to(card, { scale: 1, duration: 0.62, ease: "elastic.out(1,0.55)" }, 0.1)
      .fromTo(ring, { scale: 1, opacity: 0.95 }, { scale: 7, opacity: 0, duration: 0.6, ease: "power2.out" }, 0)
      .fromTo(sweep, { x: 0 }, { x: "360%", duration: 0.62, ease: "power2.inOut" }, 0.04)
      .to(marker, { opacity: 0, duration: 0.4, ease: "sine.out" }, 0.15);
    this.flights.push(tl);
    if (ico) gsap.fromTo(ico, { scale: 0.55, rotate: -12 }, { scale: 1, rotate: 0, duration: 0.55, delay: 0.02, ease: "back.out(2.6)" });
  }

  // ---- Acting card execution ----

  private actExecute(flag: { icon?: string; label: string; money?: string; moneyShort?: string; steps: string[] }, done: () => void): void {
    const live = this.live;
    if (!live) {
      done();
      return;
    }
    const stateEl = q<HTMLElement>(live, "[data-act-state]");
    const ico = q<HTMLElement>(live, "[data-act-ico]");
    const name = q<HTMLElement>(live, "[data-act-name]");
    const why = q<HTMLElement>(live, "[data-act-why]");
    const stepsWrap = q<HTMLElement>(live, "[data-act-steps]");
    const money = q<HTMLElement>(live, "[data-act-money]");
    const prog = q<HTMLElement>(live, "[data-act-prog]");
    const fill = q<HTMLElement>(live, "[data-act-fill]");
    if (stateEl) {
      stateEl.textContent = "RUNNING";
      stateEl.style.background = "var(--ha-accent)";
      stateEl.style.color = "var(--ha-on-accent)";
    }
    if (ico) {
      ico.style.background = "var(--ha-accent)";
      ico.style.color = "var(--ha-on-accent)";
    }
    if (name) name.textContent = flag.label;
    if (why) {
      why.textContent = "Approved by you";
      why.style.display = "block";
    }
    if (money) money.style.display = "none";
    if (prog) prog.style.display = "block";
    const rows = this.buildSteps(stepsWrap, flag.steps);
    if (!reduced()) {
      if (name) gsap.fromTo(name, { autoAlpha: 0, x: 8 }, { autoAlpha: 1, x: 0, duration: 0.4, ease: EMPH });
      if (ico) gsap.fromTo(ico, { scale: 0.7 }, { scale: 1, duration: 0.45, ease: "back.out(2.2)" });
    }
    const dur = 11.5 * this.speed;
    const finish = () => {
      if (stateEl) stateEl.textContent = "DONE";
      if (money && flag.money) {
        money.style.display = "inline-flex";
        money.innerHTML =
          '<b style="font-weight:720;color:var(--ha-ink);font-variant-numeric:tabular-nums;">' + flag.money + "</b>&nbsp;" + (flag.moneyShort || "");
        if (!reduced()) gsap.fromTo(money, { autoAlpha: 0, y: 4 }, { autoAlpha: 1, y: 0, duration: 0.35, ease: EMPH });
      }
      this.wait(2.8, () => {
        this.actStandby();
        done();
      });
    };
    this.runSteps(rows, fill, dur, finish);
  }

  private actStandby(): void {
    const live = this.live;
    if (!live) return;
    const stateEl = q<HTMLElement>(live, "[data-act-state]");
    const ico = q<HTMLElement>(live, "[data-act-ico]");
    const name = q<HTMLElement>(live, "[data-act-name]");
    const why = q<HTMLElement>(live, "[data-act-why]");
    const stepsWrap = q<HTMLElement>(live, "[data-act-steps]");
    const money = q<HTMLElement>(live, "[data-act-money]");
    const prog = q<HTMLElement>(live, "[data-act-prog]");
    if (stateEl) {
      stateEl.textContent = "STANDING BY";
      stateEl.style.background = "var(--ha-fill)";
      stateEl.style.color = "var(--ha-ink-3)";
    }
    if (ico) {
      ico.style.background = "var(--ha-fill)";
      ico.style.color = "var(--ha-ink-2)";
    }
    if (name) name.textContent = "Standing by";
    if (why) why.style.display = "none";
    if (stepsWrap) stepsWrap.innerHTML = "";
    if (money) money.style.display = "none";
    if (prog) prog.style.display = "none";
  }

  private buildSteps(container: HTMLElement | null, labels: string[]): HTMLElement[] {
    if (!container) return [];
    container.innerHTML = "";
    return labels.map((label) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;line-height:1.3;color:var(--ha-ink-3);";
      row.innerHTML =
        '<span data-step-dot style="width:16px;height:16px;flex:0 0 auto;border-radius:50%;border:1.5px solid var(--ha-line-2);display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;"></span><span data-step-label style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
        label +
        "</span>";
      container.appendChild(row);
      return row;
    });
  }

  private setStepState(row: HTMLElement, state: "active" | "done"): void {
    const dot = q<HTMLElement>(row, "[data-step-dot]");
    const label = q<HTMLElement>(row, "[data-step-label]");
    if (state === "active") {
      if (label) {
        label.style.color = "var(--ha-ink)";
        label.style.fontWeight = "560";
      }
      if (dot) {
        dot.style.border = "1.5px solid var(--ha-accent)";
        dot.style.background = "transparent";
        dot.innerHTML = '<span data-spin style="width:8px;height:8px;border-radius:50%;border:1.6px solid var(--ha-accent);border-top-color:transparent;display:block;box-sizing:border-box;"></span>';
        const sp = q<HTMLElement>(dot, "[data-spin]");
        if (sp && !reduced()) gsap.to(sp, { rotation: 360, duration: 0.62, repeat: -1, ease: "none" });
      }
    } else {
      if (label) {
        label.style.color = "var(--ha-ink-2)";
        label.style.fontWeight = "500";
      }
      if (dot) {
        dot.style.border = "1.5px solid var(--ha-accent)";
        dot.style.background = "var(--ha-accent)";
        dot.style.color = "var(--ha-on-accent)";
        dot.innerHTML = '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        if (!reduced()) gsap.fromTo(dot, { scale: 0.5 }, { scale: 1, duration: 0.3, ease: "back.out(2.6)" });
      }
    }
  }

  private runSteps(rows: HTMLElement[], fill: HTMLElement | null, totalDur: number, onDone: () => void): void {
    const n = rows.length;
    if (reduced() || !n) {
      rows.forEach((r) => this.setStepState(r, "done"));
      if (fill) fill.style.width = "100%";
      this.wait(totalDur, onDone);
      return;
    }
    if (fill) fill.style.width = "0%";
    const seg = totalDur / n;
    const run = (i: number) => {
      if (i >= n) {
        onDone();
        return;
      }
      this.setStepState(rows[i], "active");
      gsap.fromTo(rows[i], { autoAlpha: 0.35, x: -5 }, { autoAlpha: 1, x: 0, duration: 0.32, ease: EMPH });
      const from = (i / n) * 100,
        to = ((i + 1) / n) * 100;
      const adv = () => {
        this.setStepState(rows[i], "done");
        this.wait(seg * 0.2, () => run(i + 1));
      };
      if (fill) gsap.fromTo(fill, { width: from + "%" }, { width: to + "%", duration: seg * 0.66, ease: "power1.inOut", onComplete: adv });
      else this.wait(seg * 0.66, adv);
    };
    run(0);
  }
}

/** Map an action kind to its Watching group. */
export function groupForActionKind(actionKind: string): WatchGroup {
  if (/inventory|restock|po|reorder|sku|discontinue/.test(actionKind)) return "inv";
  if (/price|markdown|free_ship|shipping/.test(actionKind)) return "price";
  if (/retention|winback|cart|abandon|loyal/.test(actionKind)) return "ret";
  return "ads"; // campaign/budget/geo and the rest
}

/**
 * Page-side fold-and-dock: collapse the approved Calderyn Log row and fly a chip
 * along the lifted bezier into the matching hero Watching group row, then invoke
 * `onDock` (which dispatches le-dock). Uses the same arc as the group->Acting flight.
 */
export function foldAndDock(
  row: HTMLElement,
  opts: { group: WatchGroup; label: string },
  onDock: () => void,
): void {
  ensureEases();
  const target = document.querySelector<HTMLElement>(`[data-watch-row][data-group="${opts.group}"]`);
  const rr = row.getBoundingClientRect();
  const collapseRow = (after?: () => void) => {
    if (reduced()) {
      row.remove();
      after?.();
      return;
    }
    gsap.to(row, {
      height: 0,
      opacity: 0,
      paddingTop: 0,
      paddingBottom: 0,
      marginTop: 0,
      duration: 0.55,
      ease: "power2.inOut",
      onComplete: () => {
        row.remove();
        after?.();
      },
    });
  };
  if (reduced() || !target || !rr.width) {
    collapseRow();
    onDock();
    return;
  }
  const tr = target.getBoundingClientRect();
  if (!tr.width) {
    collapseRow();
    onDock();
    return;
  }
  const h0 = Math.min(rr.height, 50);
  const chip = document.createElement("div");
  chip.style.cssText =
    "position:fixed;z-index:99999;left:0;top:0;display:flex;align-items:center;gap:9px;box-sizing:border-box;padding:0 13px;height:" +
    h0 +
    "px;border-radius:12px;background:var(--card-solid,#fff);border:1.5px solid var(--accent);box-shadow:0 18px 42px -12px rgba(0,0,0,.45);pointer-events:none;overflow:hidden;color:var(--text-1);font-family:inherit;will-change:transform,width,height;";
  chip.innerHTML =
    '<span style="width:24px;height:24px;border-radius:7px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;background:var(--accent);">' +
    HEX_MARK.replace(/var\(--ha-on-accent\)/g, "var(--on-accent)") +
    '</span><span style="font-size:12.5px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
    opts.label +
    "</span>";
  document.body.appendChild(chip);
  const w0 = Math.min(rr.width, 330);
  const x0 = rr.left + 12,
    y0 = rr.top + (rr.height - h0) / 2;
  gsap.set(chip, { x: x0, y: y0, width: w0, autoAlpha: 0 });
  const hL = Math.max(26, Math.min(tr.height - 8, 30));
  const wL = Math.min(tr.width - 12, 168);
  const x1 = tr.left + 6,
    y1 = tr.top + (tr.height - hL) / 2;
  const cx = (x0 + x1) / 2,
    cy = Math.min(y0, y1) - 84;
  const proxy = { t: 0 };
  const bez = (t: number) => {
    const u = 1 - t;
    return { x: u * u * x0 + 2 * u * t * cx + t * t * x1, y: u * u * y0 + 2 * u * t * cy + t * t * y1 };
  };
  collapseRow();
  gsap
    .timeline({ onComplete: () => { chip.remove(); onDock(); } })
    .to(chip, { autoAlpha: 1, duration: 0.26, ease: "power2.out" })
    .to(chip, { width: wL, height: hL, duration: 0.65, ease: "power2.inOut" }, 0.1)
    .to(proxy, { t: 1, duration: 1.2, ease: "power2.inOut", onUpdate: () => { const p = bez(proxy.t); gsap.set(chip, { x: p.x, y: p.y }); } }, 0.18)
    .to(chip, { autoAlpha: 0, duration: 0.2, ease: "power2.in" }, "-=0.12");
}
