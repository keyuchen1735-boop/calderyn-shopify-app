// Calderyn DashV2 — shared UI primitives + animated charts.
// Ported from the prototype's ui.jsx. CD.money/CD.moneyK → imports from ./format;
// global CDIcon → import from ./icons. All animation/timing/SVG logic preserved.
import {
  useState,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { blendedRoas, money, moneyK, SEV_STYLE } from "./format";
import { CDIcon } from "./icons";
import { PlatformIcon } from "../PlatformIcon";
import type { DailyRow, Severity, Grade, Platform, Toast } from "./view-models";

/* ---------- CountUp: animated number ticker ---------- */
export function useCountUp(value: number, dur = 800): number {
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    const from = prev.current,
      to = value;
    if (from === to) return;
    prev.current = to;
    const t0 = performance.now();
    let raf: number;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (to - from) * e);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, dur]);
  return display;
}

export function CountMoney({ cents, className }: { cents: number; className?: string }) {
  const v = useCountUp(cents);
  return <span className={"tabular-nums " + (className || "")}>{money(Math.round(v))}</span>;
}

export function CountNum({
  value,
  decimals = 0,
  suffix = "",
  className,
}: {
  value: number;
  decimals?: number;
  suffix?: string;
  className?: string;
}) {
  const v = useCountUp(value);
  return (
    <span className={"tabular-nums " + (className || "")}>
      {v.toFixed(decimals)}
      {suffix}
    </span>
  );
}

/* ---------- Surfaces ---------- */
export function Card({
  children,
  className = "",
  onClick,
  pad = true,
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  pad?: boolean;
  hover?: boolean;
}) {
  const cls =
    "cd-card " + (pad ? "cd-pad " : "") + (hover || onClick ? "cd-card-hover " : "") + className;
  // When the card is a click target, make it keyboard-operable (WCAG AA):
  // a focusable button-role element that activates on Enter/Space.
  if (onClick) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
        className={cls}
      >
        {children}
      </div>
    );
  }
  return <div className={cls}>{children}</div>;
}

export function SectionTitle({
  children,
  action,
  onAction,
}: {
  children: ReactNode;
  action?: ReactNode;
  onAction?: () => void;
}) {
  return (
    <div className="flex items-baseline justify-between mb-3">
      <h2 className="cd-h2">{children}</h2>
      {action && (
        <button className="cd-link" onClick={onAction}>
          {action}
          <CDIcon name="chevronRight" size={13} style={{ display: "inline", verticalAlign: "-2px" }} />
        </button>
      )}
    </div>
  );
}

/* ---------- Badges & pills ---------- */
export function SevBadge({ severity }: { severity: Severity | string }) {
  const s = SEV_STYLE[severity] || SEV_STYLE.low;
  return (
    <span className="cd-sev" style={{ color: s.fg }}>
      <span className="cd-sev-dot"></span>
      {s.label}
    </span>
  );
}

type PillTone = "neutral" | "success" | "critical" | "accent" | "warn";

export function Pill({
  children,
  tone = "neutral",
  icon,
  title,
}: {
  children: ReactNode;
  tone?: PillTone;
  icon?: string;
  /** Native hover tooltip (e.g. the "why scale" reason on the Scale pill). */
  title?: string;
}) {
  const map: Record<PillTone, { bg: string; fg: string }> = {
    neutral: { bg: "var(--gray-bg)", fg: "var(--text-2)" },
    success: { bg: "var(--green-bg)", fg: "var(--green)" },
    critical: { bg: "var(--red-bg)", fg: "var(--red)" },
    accent: { bg: "var(--accent-bg)", fg: "var(--accent)" },
    warn: { bg: "var(--orange-bg)", fg: "var(--orange)" },
  };
  const s = map[tone] || map.neutral;
  return (
    <span className="cd-badge" style={{ background: s.bg, color: s.fg }} title={title}>
      {icon && <CDIcon name={icon} size={12} strokeWidth={2} />}
      {children}
    </span>
  );
}

export function GradePill({ grade }: { grade: Grade | string }) {
  const map: Record<string, [string, PillTone]> = {
    winning: ["Winning", "success"],
    okay: ["Okay", "warn"],
    poor: ["Poor", "critical"],
  };
  const [label, tone] = map[grade] || ["—", "neutral"];
  return <Pill tone={tone}>{label}</Pill>;
}

export function PlatformMark({ platform }: { platform: Platform | string }) {
  return (
    <span className="cd-platform" title={platform} data-platform={platform}>
      <PlatformIcon platform={platform} size={16} title={platform} />
    </span>
  );
}

/* ---------- Controls ---------- */
export function Toggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange && onChange(!value)}
      className="cd-toggle"
      data-on={value ? "1" : "0"}
    >
      <span className="cd-toggle-knob"></span>
    </button>
  );
}

type SegOption = string | { value: string; label: ReactNode };

export function Segmented({
  options,
  value,
  onChange,
  small,
}: {
  options: SegOption[];
  value: string;
  onChange: (next: string) => void;
  small?: boolean;
}) {
  return (
    <div className={"cd-seg " + (small ? "cd-seg-sm" : "")}>
      {options.map((o) => {
        const v = typeof o === "string" ? o : o.value;
        const label = typeof o === "string" ? o : o.label;
        return (
          <button
            key={v}
            className="cd-seg-btn"
            data-active={v === value ? "1" : "0"}
            onClick={() => onChange(v)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function Btn({
  children,
  kind = "secondary",
  icon,
  onClick,
  disabled,
  small,
  className = "",
}: {
  children: ReactNode;
  kind?: "primary" | "secondary";
  icon?: string;
  onClick?: () => void;
  disabled?: boolean;
  small?: boolean;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`cd-btn cd-btn-${kind} ${small ? "cd-btn-sm" : ""} ${className}`}
    >
      {icon && <CDIcon name={icon} size={small ? 14 : 16} strokeWidth={1.9} />}
      {children}
    </button>
  );
}

/* ---------- Meters ---------- */
export function Meter({
  pct,
  tone = "accent",
  height = 6,
}: {
  pct: number;
  tone?: "accent" | "success" | "critical" | "warn";
  height?: number;
}) {
  const color = {
    accent: "var(--accent)",
    success: "var(--green)",
    critical: "var(--red)",
    warn: "var(--orange)",
  }[tone];
  return (
    <div className="cd-meter" style={{ height }}>
      <div
        className="cd-meter-fill"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }}
      ></div>
    </div>
  );
}

/* ---------- Charts (SVG, animated) ---------- */
export function Sparkline({
  data,
  width = 96,
  height = 28,
  stroke,
  refLine,
}: {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
  refLine?: number | null;
}) {
  const min = Math.min(...data),
    max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * (width - 4) + 2,
    height - 3 - ((v - min) / range) * (height - 6),
  ]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const refY = refLine != null ? height - 3 - ((refLine - min) / range) * (height - 6) : null;
  return (
    <svg width={width} height={height} className="overflow-visible">
      {refY != null && refY > 0 && refY < height && (
        <line
          x1="2"
          x2={width - 2}
          y1={refY}
          y2={refY}
          stroke="var(--hairline-strong)"
          strokeDasharray="3 3"
          strokeWidth="1"
        />
      )}
      <path
        d={d}
        fill="none"
        stroke={stroke || "var(--accent)"}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="cd-draw"
      />
      <circle
        cx={pts[pts.length - 1][0]}
        cy={pts[pts.length - 1][1]}
        r="2.4"
        fill={stroke || "var(--accent)"}
      />
    </svg>
  );
}

/* Animated dual-series area chart (spend vs revenue → blended ROAS). */
export function AreaChart({
  rows,
  height = 220,
  live,
}: {
  rows: DailyRow[];
  height?: number;
  live?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    const t = setTimeout(() => setDrawn(true), 60);
    return () => {
      ro.disconnect();
      clearTimeout(t);
    };
  }, []);
  const padL = 8,
    padR = 8,
    padT = 14,
    padB = 22;
  const innerW = w - padL - padR,
    innerH = height - padT - padB;
  // Floor the divisors: an all-zero-revenue series would make maxV 0 (every
  // y() → NaN) and a single-point series would make length-1 0 (every x → NaN),
  // poisoning the SVG path coordinates.
  const maxV = Math.max(1, ...rows.map((r) => r.revenue_cents)) * 1.08;
  const span = Math.max(1, rows.length - 1);
  const x = (i: number) => padL + (i / span) * innerW;
  const y = (v: number) => padT + innerH - (v / maxV) * innerH;
  const line = (key: "revenue_cents" | "spend_cents") =>
    rows.map((r, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(r[key]).toFixed(1)).join(" ");
  const area = (key: "revenue_cents" | "spend_cents") =>
    line(key) + ` L ${x(rows.length - 1)} ${padT + innerH} L ${x(0)} ${padT + innerH} Z`;
  const onMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - padL) / innerW) * (rows.length - 1));
    setHover(Math.min(rows.length - 1, Math.max(0, i)));
  };
  const h = hover != null ? rows[hover] : null;
  return (
    <div
      ref={ref}
      className="relative w-full select-none"
      style={{ height }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <svg width={w} height={height} className="block">
        <defs>
          <linearGradient id="cd-rev-g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((p) => (
          <line
            key={p}
            x1={padL}
            x2={w - padR}
            y1={padT + innerH * p}
            y2={padT + innerH * p}
            stroke="var(--hairline)"
            strokeWidth="1"
          />
        ))}
        <g style={{ opacity: drawn ? 1 : 0, transition: "opacity 0.8s ease 0.2s" }}>
          <path d={area("revenue_cents")} fill="url(#cd-rev-g)" />
        </g>
        <path
          d={line("revenue_cents")}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          className={drawn ? "cd-chart-line cd-chart-line-drawn" : "cd-chart-line"}
        />
        <path
          d={line("spend_cents")}
          fill="none"
          stroke="var(--text-3)"
          strokeWidth="1.6"
          strokeDasharray="4 3"
          strokeLinecap="round"
          style={{ opacity: drawn ? 0.9 : 0, transition: "opacity 0.6s ease 0.5s" }}
        />
        {h && hover != null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={padT}
              y2={padT + innerH}
              stroke="var(--hairline-strong)"
              strokeWidth="1"
            />
            <circle
              cx={x(hover)}
              cy={y(h.revenue_cents)}
              r="3.5"
              fill="var(--accent)"
              stroke="var(--card)"
              strokeWidth="1.5"
            />
            <circle
              cx={x(hover)}
              cy={y(h.spend_cents)}
              r="3"
              fill="var(--text-3)"
              stroke="var(--card)"
              strokeWidth="1.5"
            />
          </>
        )}
        {live && (
          <circle
            cx={x(rows.length - 1)}
            cy={y(rows[rows.length - 1].revenue_cents)}
            r="3.5"
            fill="var(--accent)"
            className="cd-pulse-dot"
          />
        )}
      </svg>
      <div className="absolute left-2 bottom-0 cd-caption">30 days ago</div>
      <div className="absolute right-2 bottom-0 cd-caption">today</div>
      {h && hover != null && (
        <div className="cd-tip" style={{ left: Math.min(w - 170, Math.max(0, x(hover) - 80)) }}>
          <div className="cd-caption">{h.daysAgo === 0 ? "Today" : `${h.daysAgo}d ago`}</div>
          <div className="flex items-center gap-2">
            <span className="cd-dot" style={{ background: "var(--accent)" }}></span>Revenue{" "}
            <b className="ml-auto tabular-nums">{moneyK(h.revenue_cents)}</b>
          </div>
          <div className="flex items-center gap-2">
            <span className="cd-dot" style={{ background: "var(--text-3)" }}></span>Ad spend{" "}
            <b className="ml-auto tabular-nums">{moneyK(h.spend_cents)}</b>
          </div>
          <div className="flex items-center gap-2 cd-caption">
            Blended ROAS{" "}
            <b className="ml-auto tabular-nums" style={{ color: "var(--text-1)" }}>
              {blendedRoas(h.revenue_cents, h.spend_cents)}
            </b>
          </div>
        </div>
      )}
    </div>
  );
}

/* Ring gauge for composite scores. */
export function RingGauge({
  value,
  size = 120,
  label,
  sublabel,
  tone,
}: {
  value: number;
  size?: number;
  label?: ReactNode;
  sublabel?: ReactNode;
  tone?: string;
}) {
  const [v, setV] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setV(value), 120);
    return () => clearTimeout(t);
  }, [value]);
  const r = (size - 12) / 2,
    c = 2 * Math.PI * r;
  const color = tone || (value >= 70 ? "var(--green)" : value >= 50 ? "var(--orange)" : "var(--red)");
  const shown = useCountUp(value, 900);
  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--gray-bg)" strokeWidth="8" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v / 100)}
          style={{ transition: "stroke-dashoffset 1s cubic-bezier(0.22,1,0.36,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div
          className="tabular-nums"
          style={{ fontSize: size * 0.26, fontWeight: 700, letterSpacing: "-0.02em" }}
        >
          {Math.round(shown)}
        </div>
        {label && (
          <div className="cd-caption" style={{ marginTop: -2 }}>
            {label}
          </div>
        )}
      </div>
      {sublabel}
    </div>
  );
}

/* Horizontal score bar (predictor dimensions). */
export function ScoreBar({ score }: { score: number }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setV(score), 100);
    return () => clearTimeout(t);
  }, [score]);
  const color = score >= 70 ? "var(--green)" : score >= 50 ? "var(--orange)" : "var(--red)";
  return (
    <div className="flex items-center gap-2.5 w-full">
      <div className="cd-meter flex-1" style={{ height: 5 }}>
        <div className="cd-meter-fill" style={{ width: v + "%", background: color }}></div>
      </div>
      <span className="tabular-nums cd-mono-num" style={{ width: 26, textAlign: "right" }}>
        {score}
      </span>
    </div>
  );
}

/* ---------- Toast ---------- */
export function ToastHost({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="cd-toast">
          <CDIcon
            name={t.icon || "check"}
            size={15}
            strokeWidth={2}
            style={{ color: t.tone === "critical" ? "var(--red)" : "var(--green)" }}
          />
          {t.text}
        </div>
      ))}
    </div>
  );
}

/* ---------- Empty / placeholder ---------- */
export function Placeholder({
  icon = "scan",
  title,
  sub,
}: {
  icon?: string;
  title?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 gap-2">
      <div className="cd-ph-icon">
        <CDIcon name={icon} size={22} />
      </div>
      <div className="cd-h3">{title}</div>
      {sub && (
        <div className="cd-caption" style={{ maxWidth: 320 }}>
          {sub}
        </div>
      )}
    </div>
  );
}
