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
  ArrowDown,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BellOff,
  Box,
  Bug,
  AlignLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  Clock,
  Eye,
  FileText,
  Gauge,
  Globe,
  Heart,
  LineChart,
  Lock,
  Megaphone,
  MessageSquareMore,
  Moon,
  MoreHorizontal,
  Pause,
  Play,
  Radar,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Sun,
  Target,
  TrendingDown,
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
  more: MoreHorizontal,
  bug: Bug,
  target: Target,
  lock: Lock,
  eye: Eye,
  list: AlignLeft,
  trendUp: TrendingUp,
  trendDown: TrendingDown,
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
  exclude_geo: "globe",
  reallocate_inventory: "swap",
  create_po_draft: "doc",
  snooze_alert: "snooze",
};
