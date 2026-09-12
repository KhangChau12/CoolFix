// ── Icon system ──────────────────────────────────────────────────────
// Single source of truth mapping domain concepts to Lucide icons, so call
// sites import a semantic name instead of picking a raw Lucide export
// (and instead of the emoji/glyph characters this file replaces app-wide).
// Color always comes from existing CSS tokens (TIER_META.colorVar, agent
// accent vars, etc.) — icons here are shape only, never color.

import {
  AlertTriangle,
  ArrowUpCircle,
  Bell,
  Calendar,
  CircleDot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  CircleDollarSign,
  ClipboardList,
  Clock,
  Gauge,
  Layers,
  Leaf,
  Lock,
  LayoutDashboard,
  ListChecks,
  MapPin,
  Monitor,
  Repeat,
  Scale,
  Search,
  Share2,
  Sliders,
  Smartphone,
  Sparkles,
  SquareStack,
  Users,
  Waypoints,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { AgentName, Tier } from "./types";

/** Tier -> icon. Distinct from tier *color*, which stays on TIER_META.colorVar. */
export const TIER_ICON: Record<Tier, LucideIcon> = {
  urgent: Zap,
  priority: ArrowUpCircle,
  standard: Clock,
  flexible: Leaf,
};

/** One authoritative agent -> icon map, shared by AgentFeed, AgentFlowMap, queue, etc. */
export const AGENT_ICON: Record<AgentName, LucideIcon> = {
  PricingEngine: CircleDollarSign,
  JobIntakeAgent: Search,
  CapacityAgent: Gauge,
  TechnicianStateAgent: CircleDot,
  AssignmentAgent: Users,
  AssignmentTiebreakAgent: Scale,
  AssignmentEdgecaseAgent: SquareStack,
  DisruptionAgent: Zap,
  NotificationAgent: Sparkles,
  Orchestrator: Waypoints,
};

/** Sidebar nav icons, `admin/layout.tsx`. */
export const NAV_ICON = {
  dashboard: LayoutDashboard,
  flow: Waypoints,
  schedule: Calendar,
  queue: ListChecks,
  technicians: Users,
  approvals: CircleCheck,
  settings: Sliders,
} as const;

/** Landing-page persona cards. */
export const PERSONA_ICON = {
  company: Monitor,
  customer: ClipboardList,
  technician: Smartphone,
  tracking: Search,
} as const;

/** Generic status/step icons used across booking steps, tech app, schedule, maps. */
export const STATUS_ICON = {
  check: Check,
  pause: Clock,
  lock: Lock,
  reschedule: Repeat,
  pin: MapPin,
  close: X,
  disrupted: AlertTriangle,
  layers: Layers,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  chevronUp: ChevronUp,
  bell: Bell,
  share: Share2,
} as const;
