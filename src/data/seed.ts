import type { Job, Technician } from "@/lib/types";
import { SG_LANDMARKS } from "@/lib/geo";
import {
  addHours,
  computeFreezePoint,
  DISPATCH_SERVICE_HOURS,
  nowISO,
  sgHour,
  snapToServiceHours,
  snapToUrgentDispatchSlot,
} from "@/lib/time";
import { DEFAULT_CONFIG, TIER_META } from "@/lib/types";

/**
 * The slot a new URGENT booking lands in — MUST match the orchestrator's
 * logic exactly (`snapToUrgentDispatchSlot`, URGENT_EARLIEST_HOURS from now).
 * Keep `URGENT_EARLIEST_HOURS` in sync with orchestrator.ts.
 */
export const URGENT_EARLIEST_HOURS = 4;

export function urgentSlotISO(): string {
  return snapToUrgentDispatchSlot(nowISO(), URGENT_EARLIEST_HOURS);
}

// ── Seed technicians ────────────────────────────────────────────────
// 6 technicians with deliberately uneven skill coverage so scoring and
// the skill hard-constraint are visible in the demo.

export function seedTechnicians(): Technician[] {
  return [
    {
      technician_id: "tech_marcus",
      name: "Marcus Tan",
      photo_url: "https://i.pravatar.cc/120?img=12",
      skill_tags: ["basic_maintenance", "refrigerant_handling"],
      experience_level: "senior",
      location: SG_LANDMARKS.bishan,
      // Long shift on purpose: Marcus is the Bishan refrigerant technician
      // the auto-commit demo depends on, and a same-day afternoon re-plan
      // slot for job_2005 must exist regardless of what time the demo runs.
      working_hours: { start: "08:00", end: "20:00" },
      current_workload: 2,
      phone: "+65 8123 4001",
    },
    {
      technician_id: "tech_wei_jie",
      name: "Wei Jie Lim",
      photo_url: "https://i.pravatar.cc/120?img=33",
      skill_tags: ["basic_maintenance", "electrical_work"],
      experience_level: "senior",
      location: SG_LANDMARKS.jurongEast,
      working_hours: { start: "09:00", end: "19:00" },
      current_workload: 1,
      phone: "+65 8123 4002",
    },
    {
      technician_id: "tech_priya",
      name: "Priya Nair",
      photo_url: "https://i.pravatar.cc/120?img=45",
      skill_tags: ["basic_maintenance"],
      experience_level: "junior",
      location: SG_LANDMARKS.tampines,
      working_hours: { start: "08:00", end: "17:00" },
      current_workload: 3,
      phone: "+65 8123 4003",
    },
    {
      technician_id: "tech_daniel",
      name: "Daniel Ong",
      photo_url: "https://i.pravatar.cc/120?img=52",
      // basic_maintenance included: every senior can do routine servicing,
      // and it keeps Daniel eligible for a "no cooling" refrigerant job
      // even when Job-Intake also tags basic_maintenance — otherwise the
      // Buona Vista bump→HITL scenario silently reassigns to Marcus.
      skill_tags: ["basic_maintenance", "refrigerant_handling", "electrical_work", "commercial_chiller"],
      experience_level: "senior",
      location: SG_LANDMARKS.buonaVista,
      working_hours: { start: "07:00", end: "16:00" },
      current_workload: 1,
      phone: "+65 8123 4004",
    },
    {
      technician_id: "tech_gopal",
      name: "Gopal Raman",
      photo_url: "https://i.pravatar.cc/120?img=25",
      skill_tags: ["basic_maintenance", "refrigerant_handling", "electrical_work"],
      experience_level: "junior",
      location: SG_LANDMARKS.woodlands,
      working_hours: { start: "09:00", end: "20:00" },
      current_workload: 0,
      phone: "+65 8123 4005",
    },
    {
      technician_id: "tech_hui_ling",
      name: "Hui Ling Chua",
      photo_url: "https://i.pravatar.cc/120?img=41",
      skill_tags: ["commercial_chiller", "electrical_work"],
      experience_level: "senior",
      location: SG_LANDMARKS.changi,
      working_hours: { start: "08:00", end: "18:00" },
      current_workload: 2,
      phone: "+65 8123 4006",
    },
  ];
}

// ── Seed jobs ───────────────────────────────────────────────────────
// A day's schedule already partly booked. Includes one job past its
// freeze point (frozen) and a controlled setup where every
// refrigerant-skilled technician is busy at 14:00 on soft-tier jobs —
// so an incoming urgent refrigerant job forces the Disruption Agent to
// bump one, and the HITL gate to open.

interface SeedJobSpec {
  id: string;
  customer: string;
  email: string;
  phone: string;
  address: string;
  loc: { lat: number; lng: number };
  desc: string;
  category: string;
  skill: Job["skill_required"];
  tier: Job["tier"];
  /**
   * Slot as an offset from the "anchor" — the start of the next block of
   * service hours (see anchorDay()). `dayOffset` days + `hour` (SGT).
   * Keeps the seeded day deterministic no matter when seed runs.
   */
  dayOffset: number;
  hour: number;
  /**
   * "fixed"        — use dayOffset + hour literally.
   * "frozen_soon"  — resolve to now+2h (job sits inside its freeze window).
   * "urgent_slot"  — resolve to exactly where a new urgent booking lands,
   *                  so an incoming urgent job collides with this one.
   * "urgent_offset"— urgent_slot + `hour` (used as an hour offset, may be
   *                  negative), snapped to service hours. Fills a
   *                  technician's day around the urgent slot.
   */
  hourMode?: "fixed" | "frozen_soon" | "urgent_slot" | "urgent_offset";
  status: Job["status"];
  tech: string | null;
  stage: Job["pipeline_stage"];
  createdHoursAgo?: number;
}

const SPECS: SeedJobSpec[] = [
  {
    id: "job_2001",
    customer: "Rachel Sim",
    email: "rachel.sim@example.sg",
    phone: "+65 9111 0001",
    address: "Blk 210 Bishan St 23, #05-14",
    loc: { lat: 1.3541, lng: 103.848 },
    desc: "Living room aircon not cooling, water dripping inside the fan coil unit.",
    category: "not_cooling",
    skill: ["refrigerant_handling"],
    tier: "priority",
    dayOffset: 0,
    hour: 0,
    hourMode: "frozen_soon",
    status: "frozen",
    tech: "tech_marcus",
    stage: "done",
    createdHoursAgo: 20,
  },
  {
    id: "job_2002",
    customer: "Jonathan Koh",
    email: "jonathan.koh@example.sg",
    phone: "+65 9111 0002",
    address: "128 Tanjong Katong Rd, #02-01",
    loc: { lat: 1.305, lng: 103.899 },
    desc: "Scheduled servicing for 2 units, filter cleaning.",
    category: "routine",
    skill: ["basic_maintenance"],
    tier: "standard",
    dayOffset: 0,
    hour: 10,
    status: "assigned",
    tech: "tech_priya",
    stage: "assigned",
    createdHoursAgo: 40,
  },
  {
    id: "job_2003",
    customer: "Farah Ismail",
    email: "farah.ismail@example.sg",
    phone: "+65 9111 0003",
    address: "3 Fusionopolis Way, #10-21, one-north",
    loc: { lat: 1.2996, lng: 103.7876 },
    desc: "Office chiller reporting a pressure fault, needs an urgent check.",
    category: "commercial",
    skill: ["commercial_chiller"],
    tier: "priority",
    dayOffset: 0,
    hour: 11,
    status: "assigned",
    tech: "tech_hui_ling",
    stage: "assigned",
    createdHoursAgo: 30,
  },
  {
    id: "job_2004",
    customer: "Kelvin Yeo",
    email: "kelvin.yeo@example.sg",
    phone: "+65 9111 0004",
    address: "Blk 15 Jurong East St 13, #08-102",
    loc: { lat: 1.3335, lng: 103.742 },
    desc: "Install an extra bedroom unit, new power wiring required.",
    category: "install_electrical",
    skill: ["electrical_work"],
    tier: "standard",
    dayOffset: 1,
    hour: 10,
    status: "assigned",
    tech: "tech_wei_jie",
    stage: "assigned",
    createdHoursAgo: 24,
  },

  // ── Bump setup: every refrigerant-skilled technician (Marcus, Daniel,
  //    Gopal) is booked on a SOFT tier at exactly the slot a new urgent
  //    booking would land. An incoming urgent refrigerant job therefore
  //    has no free eligible technician and must bump one → Disruption
  //    Agent runs, HITL gate opens.
  {
    id: "job_2005",
    customer: "Nurul Aziz",
    email: "nurul.aziz@example.sg",
    phone: "+65 9111 0005",
    address: "Blk 512 Woodlands Dr 14, #03-88",
    loc: { lat: 1.436, lng: 103.7935 },
    desc: "Aircon cleaning, not urgent — any day this week is fine.",
    category: "routine",
    skill: ["basic_maintenance", "refrigerant_handling"],
    tier: "flexible",
    dayOffset: 0,
    hour: 0,
    hourMode: "urgent_slot",
    status: "assigned",
    tech: "tech_marcus",
    stage: "assigned",
    createdHoursAgo: 100,
  },
  {
    id: "job_2006",
    customer: "Terrence Lai",
    email: "terrence.lai@example.sg",
    phone: "+65 9111 0006",
    address: "5 Science Park Dr, #01-08",
    loc: { lat: 1.2915, lng: 103.7854 },
    desc: "Gas top-up check, flexible timing.",
    category: "not_cooling",
    skill: ["refrigerant_handling"],
    tier: "flexible",
    dayOffset: 0,
    hour: 0,
    hourMode: "urgent_slot",
    status: "assigned",
    tech: "tech_daniel",
    stage: "assigned",
    createdHoursAgo: 90,
  },
  {
    id: "job_2007",
    customer: "Sharon Teo",
    email: "sharon.teo@example.sg",
    phone: "+65 9111 0007",
    address: "Blk 680 Woodlands Ave 6, #12-45",
    loc: { lat: 1.4402, lng: 103.801 },
    desc: "Aircon noisy, needs a look. Standard timing is fine.",
    category: "not_cooling",
    skill: ["refrigerant_handling"],
    tier: "standard",
    dayOffset: 0,
    hour: 0,
    hourMode: "urgent_slot",
    status: "assigned",
    tech: "tech_gopal",
    stage: "assigned",
    createdHoursAgo: 50,
  },

  // ── Two contrasting re-plan scenarios share the same setup ──────────
  //   Every refrigerant technician (Marcus / Daniel / Gopal) is already on
  //   a soft-tier job at the urgent slot (job_2005/2006/2007). An incoming
  //   urgent refrigerant job therefore has to bump one of them — and WHICH
  //   one depends on where the incoming job is:
  //
  //   • Incoming near BISHAN → bumps job_2005 (Marcus, Bishan). Marcus has
  //     a free afternoon, so the Disruption Agent shifts job_2005 ~2h on
  //     the same technician: 1 Flexible customer, same day, comfortable
  //     gap, no SLA breach → clears every auto-commit rail → AUTO-COMMITS,
  //     no human. (eval: goldenAutoReplan)
  //
  //   • Incoming near BUONA VISTA → bumps job_2006 (Daniel). Daniel is the
  //     ONLY refrigerant+chiller technician and job_2010 / job_2011 fill
  //     the rest of his day, so job_2006's only re-plan pushes it to the
  //     NEXT DAY. A cross-day move breaks the auto-commit rails, and a
  //     reassignment to Marcus/Gopal exceeds the added-travel rail — so it
  //     goes to the Approvals queue. (eval: goldenBumpHITL)
  //
  //   job_2010 / job_2011 are Priority (never bump targets) and sit at
  //   urgent_slot + 2h / + 4h. 1.5h apart is only the HARD FLOOR
  //   (findTimeClash's <1.5h threshold — start-to-start distance, no
  //   separate travel/rest buffer added on top of it anywhere in the
  //   codebase). The product's own comfort target is 2h+: see
  //   heuristicCost's squeezePenalty and AUTO_REPLAN_LIMITS.minGapHours,
  //   both keyed off the exact same start-to-start "tightest_gap_hours"
  //   measure, and the Disruption Agent's own LLM prompt explicitly calls
  //   a job placed right at the 1.5h floor against another "fragile — no
  //   travel buffer" and asks for "a slightly later slot with a clear
  //   gap" instead. So these two are spaced a full 2h apart, not just
  //   barely legal — an earlier version had them 1h apart (a genuine
  //   overlap under the app's fixed ~1.5h-visit assumption) and a version
  //   after that fixed it to exactly 1.5h apart (legal, but exactly the
  //   "fragile" pattern the LLM prompt itself warns against). Note
  //   job_2006's HITL outcome does NOT depend on Daniel's afternoon being
  //   fully packed — it's `standard` tier, and
  //   AUTO_REPLAN_LIMITS.movableTiers = ["flexible"] already excludes it
  //   from ever auto-committing regardless of gap size. The Gantt view
  //   also lane-splits any jobs that DO land within 1.5h of each other
  //   (`assignLanes` in schedule/page.tsx) so a real near-clash stays
  //   legible instead of rendering as one merged block, but the seed
  //   itself shouldn't rely on that as a crutch.
  {
    id: "job_2010",
    customer: "PowerCool Facilities",
    email: "ops@powercool.example.sg",
    phone: "+65 9111 0010",
    address: "16 Ayer Rajah Cres, #03-01",
    loc: { lat: 1.2968, lng: 103.787 },
    desc: "Quarterly chiller inspection, booked slot.",
    category: "commercial",
    skill: ["commercial_chiller"],
    tier: "priority",
    dayOffset: 0,
    hour: 2,
    hourMode: "urgent_offset",
    status: "assigned",
    tech: "tech_daniel",
    stage: "assigned",
    createdHoursAgo: 30,
  },
  {
    id: "job_2011",
    customer: "Lena Foo",
    email: "lena.foo@example.sg",
    phone: "+65 9111 0011",
    address: "Blk 34 Holland Dr, #10-122",
    loc: { lat: 1.3092, lng: 103.7938 },
    desc: "Aircon servicing for three units.",
    category: "not_cooling",
    skill: ["refrigerant_handling"],
    tier: "priority",
    dayOffset: 0,
    hour: 4,
    hourMode: "urgent_offset",
    status: "assigned",
    tech: "tech_daniel",
    stage: "assigned",
    createdHoursAgo: 26,
  },

  // Pending job in the queue — not yet processed by agents.
  {
    id: "job_2008",
    customer: "Aaron Chan",
    email: "aaron.chan@example.sg",
    phone: "+65 9111 0008",
    address: "Blk 88 Tampines St 81, #11-231",
    loc: { lat: 1.352, lng: 103.94 },
    desc: "Aircon leaking a lot of water, suspect a blocked drain pipe.",
    category: "not_cooling",
    skill: ["refrigerant_handling"],
    tier: "standard",
    dayOffset: 1,
    hour: 15,
    hourMode: "fixed",
    status: "pending",
    tech: null,
    stage: "scoring",
    createdHoursAgo: 3,
  },
];

/**
 * The anchor: 09:00 SGT on the first day whose 09:00 is still in the
 * future. If it's already past 17:00 SGT, anchor to tomorrow.
 */
function anchorDay(): Date {
  const now = new Date();
  const h = sgHour(now.toISOString());
  // Work out "today 09:00 SGT" as a UTC instant. SGT = UTC+8, no DST.
  const sgNow = new Date(now.getTime() + 8 * 3600_000);
  const y = sgNow.getUTCFullYear();
  const m = sgNow.getUTCMonth();
  const d = sgNow.getUTCDate();
  let anchor = new Date(Date.UTC(y, m, d, 1, 0, 0)); // 09:00 SGT == 01:00 UTC
  if (h >= 16) anchor = new Date(anchor.getTime() + 24 * 3600_000);
  return anchor;
}

export function seedJobs(freezeWindowHours: number): Job[] {
  const now = nowISO();
  const anchor = anchorDay();

  return SPECS.map((s) => {
    let scheduled: string;
    if (s.hourMode === "frozen_soon") {
      scheduled = addHours(now, 2);
    } else if (s.hourMode === "urgent_slot") {
      scheduled = urgentSlotISO();
    } else if (s.hourMode === "urgent_offset") {
      scheduled = snapToServiceHours(
        addHours(urgentSlotISO(), s.hour),
        0,
        DISPATCH_SERVICE_HOURS,
      );
    } else {
      const dt = new Date(
        anchor.getTime() + s.dayOffset * 24 * 3600_000 + (s.hour - 9) * 3600_000,
      );
      scheduled = dt.toISOString();
    }
    const price = basePriceFor(s.skill) * TIER_META[s.tier].priceMultiplier;
    const createdAt = s.createdHoursAgo
      ? addHours(now, -s.createdHoursAgo)
      : addHours(now, -12);

    return {
      job_id: s.id,
      customer_name: s.customer,
      customer_email: s.email,
      customer_phone: s.phone,
      location: { ...s.loc, address: s.address },
      problem_description: s.desc,
      problem_category: s.category,
      photo_url: null,
      skill_required: s.skill,
      tier: s.tier,
      scheduled_time: scheduled,
      freeze_point: computeFreezePoint(scheduled, freezeWindowHours),
      status: s.status,
      assigned_technician_id: s.tech,
      score_breakdown: s.tech ? demoBreakdown(s.id) : null,
      price: Math.round(price),
      created_at: createdAt,
      pipeline_stage: s.stage,
      reschedule_history: [],
    };
  });
}

function basePriceFor(skills: Job["skill_required"]): number {
  const table = DEFAULT_CONFIG.basePrice;
  return Math.max(...skills.map((s) => table[s] ?? 80));
}

function demoBreakdown(id: string) {
  // Deterministic pseudo-breakdowns for pre-assigned seed jobs so the
  // Gantt tooltips and feed have data before any agent runs.
  const seed = [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const distance = Math.round((0.3 + (seed % 7) * 0.12) * 100) / 100;
  const skill_match = 2;
  const urgency = Math.round((0.8 + (seed % 5) * 0.2) * 100) / 100;
  const workload = Math.round((0.25 + (seed % 3) * 0.1) * 100) / 100;
  return {
    distance,
    skill_match,
    urgency,
    workload,
    total: Math.round((distance + skill_match + urgency + workload) * 100) / 100,
  };
}
