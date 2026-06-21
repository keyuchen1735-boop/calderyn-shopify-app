// Calderyn DashV2 — icon set. STANDARD: Lucide (https://lucide.dev) via
// `lucide-react`, wrapped behind the <CDIcon name="..."/> registry below.
// Monochrome (currentColor), default 20px / 1.7 stroke to match the dashboard's
// line-icon look. Lucide is the single approved icon source for the dashboard.
//
// To add an icon: import the component from "lucide-react" and add one line to
// CD_ICONS. Only registered icons ship (tree-shaken) — keep this registry curated.
//
// NOTE: the embedded admin (app/routes/app.*) uses @shopify/polaris-icons, NOT
// Lucide — that is the Shopify Polaris convention and an App Store expectation.
// Do not import Lucide there.
import type { CSSProperties } from "react";
import {
  Archive,
  ArrowDown,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Ban,
  Bell,
  BellOff,
  Box,
  Bug,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  Clock,
  FileText,
  Gauge,
  Globe,
  Heart,
  LineChart,
  Megaphone,
  MessageSquareMore,
  Moon,
  MoreHorizontal,
  Pause,
  Play,
  Radar,
  RotateCcw,
  Scissors,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Sun,
  Tag,
  TrendingUp,
  TriangleAlert,
  Undo2,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

export interface CDIconProps {
  name: string;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
  className?: string;
}

// name -> Lucide component. Names are stable so the 14 call sites never change.
export const CD_ICONS: Record<string, LucideIcon> = {
  archive: Archive,
  gauge: Gauge,
  bell: Bell,
  megaphone: Megaphone,
  sparkle: Sparkles,
  chart: LineChart,
  box: Box,
  clock: Clock,
  gear: Settings,
  bag: ShoppingBag,
  heart: Heart,
  scan: Radar,
  pause: Pause,
  reduce: ArrowDown,
  globe: Globe,
  swap: ArrowLeftRight,
  doc: FileText,
  snooze: BellOff,
  check: Check,
  x: X,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  chevronLeft: ChevronLeft,
  search: Search,
  bolt: Zap,
  undo: Undo2,
  shield: ShieldCheck,
  sun: Sun,
  moon: Moon,
  play: Play,
  arrowRight: ArrowRight,
  rotate: RotateCcw,
  arrowUpRight: ArrowUpRight,
  warn: TriangleAlert,
  assist: MessageSquareMore,
  ban: Ban,
  scissors: Scissors,
  trendingUp: TrendingUp,
  rotateCcw: RotateCcw,
  tag: Tag,
  more: MoreHorizontal,
  bug: Bug,
};

export function CDIcon({
  name,
  size = 20,
  strokeWidth = 1.7,
  style,
  className,
}: CDIconProps): JSX.Element {
  const Icon = CD_ICONS[name] ?? Radar;
  return (
    <Icon
      size={size}
      strokeWidth={strokeWidth}
      style={style}
      className={className}
      aria-hidden="true"
    />
  );
}

export const CD_ACTION_ICON: Record<string, string> = {
  pause_campaign: "pause",
  reduce_campaign_budget: "reduce",
  reallocate_budget: "swap",
  reallocate_spend_sku: "trendingUp",
  exclude_geo: "globe",
  reallocate_inventory: "swap",
  create_po_draft: "doc",
  snooze_alert: "snooze",
  discontinue: "ban",
  discontinue_sku: "archive",
  cut_ads: "scissors",
  reallocate_to_winner: "trendingUp",
  fix_returns: "rotateCcw",
  review_pricing: "tag",
};
