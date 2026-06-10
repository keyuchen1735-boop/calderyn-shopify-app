// Calderyn DashV2 — icon set. Original line icons in an SF-symbol spirit:
// 24×24 grid, 1.7px stroke, round caps/joins, drawn for optical balance.
import type { CSSProperties, ReactNode } from "react";

export interface CDIconProps {
  name: string;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
  className?: string;
}

type IconComponent = (props: Omit<CDIconProps, "name">) => JSX.Element;

const cdIcon =
  (paths: ReactNode, _extra: Record<string, unknown> = {}): IconComponent =>
  (props) => {
    const { size = 20, strokeWidth = 1.7, style, className } = props;
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={style}
        className={className}
        aria-hidden="true"
      >
        {paths}
      </svg>
    );
  };

const IconGauge = cdIcon(
  <>
    <path d="M4 14a8 8 0 1 1 16 0" />
    <path d="M12 14l3.5-4.5" />
    <circle cx="12" cy="14" r="1.4" fill="currentColor" stroke="none" />
    <path d="M5 18h14" />
  </>,
);
const IconBell = cdIcon(
  <>
    <path d="M6 10a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 14 6 10Z" />
    <path d="M10 18.8a2.2 2.2 0 0 0 4 0" />
  </>,
);
const IconMegaphone = cdIcon(
  <>
    <path d="M4 10v4l11 4V6L4 10Z" />
    <path d="M15 8.5a3.5 3.5 0 0 1 0 7" transform="translate(4 -4)" />
    <path d="M7 14.5V17a2 2 0 0 0 2 2h.5" />
  </>,
);
const IconSparkle = cdIcon(
  <>
    <path d="M12 4l1.8 4.6L18 10.2l-4.2 1.6L12 16.5l-1.8-4.7L6 10.2l4.2-1.6L12 4Z" />
    <path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z" />
  </>,
);
const IconChart = cdIcon(
  <>
    <path d="M4 19V5" />
    <path d="M4 19h16" />
    <path d="M7.5 15.5l3.5-4 3 2.5 4.5-6" />
  </>,
);
const IconBox = cdIcon(
  <>
    <path d="M4 8l8-4 8 4v8l-8 4-8-4V8Z" />
    <path d="M4 8l8 4 8-4" />
    <path d="M12 12v8" />
  </>,
);
const IconClock = cdIcon(
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4.2l2.8 1.8" />
  </>,
);
const IconGear = cdIcon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 4.5v2M12 17.5v2M19.5 12h-2M6.5 12h-2M17.3 6.7l-1.4 1.4M8.1 15.9l-1.4 1.4M17.3 17.3l-1.4-1.4M8.1 8.1L6.7 6.7" />
  </>,
);
const IconBag = cdIcon(
  <>
    <path d="M6 8h12l-1 11H7L6 8Z" />
    <path d="M9 8V7a3 3 0 0 1 6 0v1" />
  </>,
);
const IconHeart = cdIcon(
  <>
    <path d="M12 19s-7-4.3-7-9.2A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.2C19 14.7 12 19 12 19Z" />
  </>,
);
const IconScan = cdIcon(
  <>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="4.2" opacity="0.5" />
    <path d="M12 12l5.5-3.2" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
  </>,
);
const IconPause = cdIcon(
  <>
    <path d="M9 6v12M15 6v12" strokeWidth="2.2" />
  </>,
);
const IconReduce = cdIcon(
  <>
    <path d="M12 5v14M12 19l-5-5M12 19l5-5" />
  </>,
);
const IconGlobe = cdIcon(
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M4 12h16M12 4c2.5 2.3 3.6 5 3.6 8S14.5 17.7 12 20c-2.5-2.3-3.6-5-3.6-8S9.5 6.3 12 4Z" />
  </>,
);
const IconSwap = cdIcon(
  <>
    <path d="M7 9h11M15 5.5L18.5 9 15 12.5" />
    <path d="M17 15H6M9 11.5L5.5 15 9 18.5" />
  </>,
);
const IconDoc = cdIcon(
  <>
    <path d="M7 4h7l4 4v12H7V4Z" />
    <path d="M14 4v4h4" />
    <path d="M10 13h5M10 16h5" />
  </>,
);
const IconSnooze = cdIcon(
  <>
    <path d="M9 8h6l-6 8h6" />
  </>,
);
const IconCheck = cdIcon(
  <>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </>,
);
const IconX = cdIcon(
  <>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </>,
);
const IconChevronRight = cdIcon(
  <>
    <path d="M9.5 6l6 6-6 6" />
  </>,
);
const IconChevronLeft = cdIcon(
  <>
    <path d="M14.5 6l-6 6 6 6" />
  </>,
);
const IconSearch = cdIcon(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M15.8 15.8L20 20" />
  </>,
);
const IconBolt = cdIcon(
  <>
    <path d="M13 3L6 13.5h5L10.5 21 18 10.5h-5L13 3Z" />
  </>,
);
const IconUndo = cdIcon(
  <>
    <path d="M8 7L4.5 10.5 8 14" />
    <path d="M4.5 10.5H15a4.5 4.5 0 0 1 0 9h-3" />
  </>,
);
const IconShield = cdIcon(
  <>
    <path d="M12 3.5l7 2.5v5c0 5-3 8.2-7 9.5-4-1.3-7-4.5-7-9.5V6l7-2.5Z" />
    <path d="M9 11.8l2.2 2.2L15.5 9.5" />
  </>,
);
const IconSun = cdIcon(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M21 12h-2M5 12H3M18.4 5.6l-1.4 1.4M7 17l-1.4 1.4M18.4 18.4L17 17M7 7L5.6 5.6" />
  </>,
);
const IconMoon = cdIcon(
  <>
    <path d="M19.5 14A8 8 0 0 1 10 4.5 8 8 0 1 0 19.5 14Z" />
  </>,
);
const IconPlay = cdIcon(
  <>
    <path d="M8.5 6l9 6-9 6V6Z" />
  </>,
);
const IconArrowUpRight = cdIcon(
  <>
    <path d="M7 17L17 7M9 7h8v8" />
  </>,
);
const IconWarn = cdIcon(
  <>
    <path d="M12 4.5L21 19H3L12 4.5Z" />
    <path d="M12 10v4" />
    <circle cx="12" cy="16.7" r="0.9" fill="currentColor" stroke="none" />
  </>,
);
const IconAssist = cdIcon(
  <>
    <path d="M5 6.5h14v9H12l-4 3.5v-3.5H5v-9Z" />
    <path d="M9 11h.01M12 11h.01M15 11h.01" strokeWidth="2.4" />
  </>,
);

export const CD_ICONS: Record<string, IconComponent> = {
  gauge: IconGauge,
  bell: IconBell,
  megaphone: IconMegaphone,
  sparkle: IconSparkle,
  chart: IconChart,
  box: IconBox,
  clock: IconClock,
  gear: IconGear,
  bag: IconBag,
  heart: IconHeart,
  scan: IconScan,
  pause: IconPause,
  reduce: IconReduce,
  globe: IconGlobe,
  swap: IconSwap,
  doc: IconDoc,
  snooze: IconSnooze,
  check: IconCheck,
  x: IconX,
  chevronRight: IconChevronRight,
  chevronLeft: IconChevronLeft,
  search: IconSearch,
  bolt: IconBolt,
  undo: IconUndo,
  shield: IconShield,
  sun: IconSun,
  moon: IconMoon,
  play: IconPlay,
  arrowUpRight: IconArrowUpRight,
  warn: IconWarn,
  assist: IconAssist,
};

export function CDIcon({ name, ...rest }: CDIconProps): JSX.Element {
  const C = CD_ICONS[name] || IconScan;
  return <C {...rest} />;
}

export const CD_ACTION_ICON: Record<string, string> = {
  pause_campaign: "pause",
  reduce_campaign_budget: "reduce",
  exclude_geo: "globe",
  reallocate_inventory: "swap",
  create_po_draft: "doc",
  snooze_alert: "snooze",
};
