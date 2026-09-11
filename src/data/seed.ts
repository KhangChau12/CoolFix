import type { AgentDecisionLog, Job, NotificationRecord, Technician } from "@/lib/types";
import { SG_LANDMARKS } from "@/lib/geo";
import {
  addHours,
  computeFreezePoint,
  DISPATCH_SERVICE_HOURS,
  hoursBetween,
  nowISO,
  sgHour,
  snapToServiceHours,
  snapToUrgentDispatchSlot,
} from "@/lib/time";
import { DEFAULT_CONFIG, DISPATCH_POLICY, SKILL_CERT, TIER_META } from "@/lib/types";

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
// 9 technicians with deliberately uneven skill coverage so scoring and
// the skill hard-constraint are visible in the demo. The last 3 (Amir,
// Farah, Kelvin) were added to round the roster out to a more convincing
// fleet size — deliberately holding ONLY basic_maintenance/electrical_work,
// the two skills already best-covered, so they add realistic day-to-day
// volume without changing the certified-technician counts the bump/HITL
// and Capacity-Agent chiller-saturation scenarios depend on exactly:
// refrigerant_handling stays at 3 (Marcus/Daniel/Gopal), commercial_chiller
// stays at 2 (Daniel/Hui Ling). Do not give any of these three either skill.

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
    {
      technician_id: "tech_amir",
      name: "Amir Rashid",
      photo_url: "https://i.pravatar.cc/120?img=14",
      skill_tags: ["basic_maintenance", "electrical_work"],
      experience_level: "junior",
      location: SG_LANDMARKS.punggol,
      working_hours: { start: "09:00", end: "19:00" },
      current_workload: 1,
      phone: "+65 8123 4007",
    },
    {
      technician_id: "tech_farah",
      name: "Farah Lim",
      photo_url: "https://i.pravatar.cc/120?img=47",
      skill_tags: ["basic_maintenance", "electrical_work"],
      experience_level: "senior",
      location: SG_LANDMARKS.sengkang,
      working_hours: { start: "08:00", end: "18:00" },
      current_workload: 2,
      phone: "+65 8123 4008",
    },
    {
      technician_id: "tech_kelvin",
      name: "Kelvin Ong",
      photo_url: "https://i.pravatar.cc/120?img=53",
      skill_tags: ["basic_maintenance"],
      experience_level: "junior",
      location: SG_LANDMARKS.yishun,
      working_hours: { start: "09:00", end: "20:00" },
      current_workload: 1,
      phone: "+65 8123 4009",
    },
  ];
}

// ── Seed jobs ───────────────────────────────────────────────────────
// A day's schedule the coordinator's agents have ALREADY worked through:
// every job here is assigned (or frozen), each with a synthetic pipeline
// trail in agent_decision_log (see seedDecisionLog below) so opening
// /admin/jobs/<id> shows the full replay. Includes one job past its
// freeze point (frozen) and a controlled setup where every
// refrigerant-skilled technician is busy at the urgent slot on soft-tier
// jobs — so an incoming urgent refrigerant job forces the Disruption
// Agent to re-plan ONE already-scheduled job, and (near Buona Vista) the
// HITL gate to open. The demo's new booking is the only thing that runs
// the live pipeline; the seed is the day it lands into.

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
   * "today_offset" — `hour` is hours-from-`now` directly (snapped into
   *                  service hours), NOT the anchor grid — guarantees the
   *                  job lands inside Capacity Agent's rolling "next 24h
   *                  from now" window regardless of what time the
   *                  demo/seed runs at. Used by the filler jobs meant to
   *                  read as "today's load"; the anchor grid (09:00 SGT
   *                  block) and the rolling window are two different time
   *                  bases that don't line up at every wall-clock hour.
   */
  hourMode?: "fixed" | "frozen_soon" | "urgent_slot" | "urgent_offset" | "today_offset";
  status: Job["status"];
  tech: string | null;
  stage: Job["pipeline_stage"];
  createdHoursAgo?: number;
}

// ── Filler jobs (job_3001+) ─────────────────────────────────────────
// The 10 hand-crafted jobs below exist to drive specific demo scenarios
// (bump→HITL, auto-commit, frozen, …) — deliberately light so nobody's
// schedule was accidentally full. That also means the fleet-wide and
// per-skill thresholds the Capacity Agent checks (`capacityTotalPerDay`,
// `capacityFlexiblePerDay`, certified-techs × slots/day) never had a
// realistic chance to fire: 10 jobs across 6 technicians is nowhere near
// a busy day. These ~30 filler jobs round the seeded day out to a
// realistic SME volume (30-40 total) WITHOUT touching any of the
// hand-crafted timing the existing scenarios depend on:
//   - `hourMode: "fixed"` on a fixed dayOffset/hour grid — a completely
//     different time basis than the dynamic "urgent_slot"/"urgent_offset"
//     jobs (which resolve relative to `now` at seed time), so there's no
//     way to hand-collide with them by construction.
//   - `resolveFillerClashes()` in `seedJobs()` still nudges any filler
//     that happens to land within 90 min of ANY other job on the same
//     technician (including the dynamic ones, once resolved) forward by
//     1h, repeatedly, until clear — belt-and-braces against the timing
//     coincidence the fixed/dynamic split can't rule out on its own.
//   - Every filler is assigned to a technician who actually holds the
//     skill required, so the pipeline trail stays believable.
// commercial_chiller is deliberately over-represented on Daniel + Hui
// Ling — the only 2 certified technicians — so a new incoming chiller
// job has a real, reliable chance to see that skill's day-capacity
// (2 techs × 4 slots = 8) saturated and trigger `suggest_alternative_slot`
// without needing to also push the whole fleet near its 24/day cap.
const FILLER_ADDRESSES: { address: string; loc: { lat: number; lng: number } }[] = [
  { address: "Blk 115 Bishan St 12, #03-221", loc: { lat: 1.351, lng: 103.849 } },
  { address: "22 Sin Ming Lane, #02-15", loc: { lat: 1.3545, lng: 103.837 } },
  { address: "Blk 302 Jurong East St 32, #05-88", loc: { lat: 1.3495, lng: 103.73 } },
  { address: "60 Jurong West Central 3, #12-04", loc: { lat: 1.3405, lng: 103.706 } },
  { address: "Blk 410 Tampines St 41, #08-176", loc: { lat: 1.3535, lng: 103.955 } },
  { address: "9 Tampines Ave 2, #01-30", loc: { lat: 1.3555, lng: 103.94 } },
  { address: "Blk 780 Woodlands Cres, #04-99", loc: { lat: 1.4405, lng: 103.795 } },
  { address: "1 Woodlands Sq, #06-12", loc: { lat: 1.4358, lng: 103.786 } },
  { address: "18 Commonwealth Ln, #03-05", loc: { lat: 1.3025, lng: 103.799 } },
  { address: "Blk 55 Holland Close, #09-112", loc: { lat: 1.3115, lng: 103.792 } },
  { address: "30 Changi South Ave 6, #01-20", loc: { lat: 1.3235, lng: 103.951 } },
  { address: "Blk 220 Changi Village Rd, #02-08", loc: { lat: 1.3885, lng: 103.988 } },
  { address: "88 Clementi Rd, #04-40", loc: { lat: 1.3155, lng: 103.77 } },
  { address: "Blk 502 West Coast Dr, #11-266", loc: { lat: 1.311, lng: 103.762 } },
  { address: "Blk 172 Punggol Field, #06-88", loc: { lat: 1.4025, lng: 103.907 } },
  { address: "12 Punggol Walk, #03-14", loc: { lat: 1.406, lng: 103.898 } },
  { address: "Blk 261 Sengkang East Way, #09-102", loc: { lat: 1.3895, lng: 103.895 } },
  { address: "Blk 605 Yishun St 61, #04-33", loc: { lat: 1.4285, lng: 103.837 } },
];

interface FillerPlan {
  tech: string;
  skill: Job["skill_required"][number];
  category: string;
  desc: string;
  tier: Job["tier"];
  /** How many fillers land TODAY (day 0) for this plan. */
  todayCount: number;
  /** How many more land later in the week (days 2-4), for volume/variety
   *  without adding to today's density. */
  laterCount: number;
}

/**
 * Marcus and Daniel are excluded from day-0/1 filler load entirely —
 * job_2005 needs Marcus free mid-afternoon TODAY for the auto-commit
 * scenario, and Daniel's afternoon is already intentionally packed
 * (job_2006/2010/2011) for the HITL scenario. Adding same-day filler load
 * to either would risk silently flipping which of those two stories the
 * demo lands on depending on wall-clock time — exactly the kind of
 * "looks unrelated but breaks the scenario" bug worth avoiding by
 * construction rather than catching with a test after the fact.
 */
const NO_TODAY_FILLER_TECHS = new Set(["tech_marcus", "tech_daniel"]);

function buildFillerSpecs(): SeedJobSpec[] {
  // Wei Jie / Priya / Gopal / Hui Ling carry the bulk of TODAY's volume —
  // enough to bring the fleet within reach of capacityTotalPerDay (24) so
  // Capacity Agent's fleet-wide cap is a real, reachable trigger, not just
  // the narrow per-skill one. Marcus and Daniel's extra volume (see
  // NO_TODAY_FILLER_TECHS) lands later in the week instead. commercial_
  // chiller is deliberately concentrated on Hui Ling (the one of its 2
  // certified techs free today) so that skill's own day-capacity
  // (2 techs × 4 slots = 8) has a real chance to saturate on its own,
  // independent of the fleet-wide cap.
  const plans: FillerPlan[] = [
    { tech: "tech_marcus", skill: "basic_maintenance", category: "routine", desc: "Routine servicing, filter clean.", tier: "flexible", todayCount: 0, laterCount: 3 },
    { tech: "tech_marcus", skill: "refrigerant_handling", category: "not_cooling", desc: "Aircon cooling weakly, gas top-up check.", tier: "standard", todayCount: 0, laterCount: 2 },
    { tech: "tech_wei_jie", skill: "basic_maintenance", category: "routine", desc: "Scheduled servicing, 2 units.", tier: "flexible", todayCount: 3, laterCount: 1 },
    { tech: "tech_wei_jie", skill: "electrical_work", category: "install_electrical", desc: "New unit wiring, power point added.", tier: "standard", todayCount: 2, laterCount: 1 },
    { tech: "tech_priya", skill: "basic_maintenance", category: "routine", desc: "Aircon cleaning, annual servicing.", tier: "flexible", todayCount: 3, laterCount: 2 },
    { tech: "tech_gopal", skill: "basic_maintenance", category: "routine", desc: "Filter and coil cleaning.", tier: "flexible", todayCount: 2, laterCount: 1 },
    { tech: "tech_gopal", skill: "refrigerant_handling", category: "not_cooling", desc: "Not cooling, suspected leak.", tier: "standard", todayCount: 2, laterCount: 1 },
    { tech: "tech_gopal", skill: "electrical_work", category: "install_electrical", desc: "New bedroom unit, wiring check.", tier: "priority", todayCount: 1, laterCount: 0 },
    { tech: "tech_daniel", skill: "commercial_chiller", category: "commercial", desc: "Quarterly chiller plant inspection.", tier: "priority", todayCount: 0, laterCount: 4 },
    { tech: "tech_hui_ling", skill: "commercial_chiller", category: "commercial", desc: "Office chiller preventive maintenance.", tier: "standard", todayCount: 6, laterCount: 2 },
    { tech: "tech_hui_ling", skill: "electrical_work", category: "install_electrical", desc: "Electrical fault, panel inspection.", tier: "standard", todayCount: 1, laterCount: 2 },
    // Amir / Farah / Kelvin — added to round the roster out to 9 (see the
    // header note on seedTechnicians). Only basic_maintenance/electrical_work,
    // so they add real volume without touching the certified-tech counts
    // the bump/HITL/chiller-saturation scenarios depend on.
    { tech: "tech_amir", skill: "basic_maintenance", category: "routine", desc: "Aircon servicing, standard unit.", tier: "flexible", todayCount: 3, laterCount: 2 },
    { tech: "tech_amir", skill: "electrical_work", category: "install_electrical", desc: "Power point relocation for new unit.", tier: "standard", todayCount: 1, laterCount: 1 },
    { tech: "tech_farah", skill: "basic_maintenance", category: "routine", desc: "Aircon cleaning, 3 units.", tier: "flexible", todayCount: 2, laterCount: 2 },
    { tech: "tech_farah", skill: "electrical_work", category: "install_electrical", desc: "New installation, electrical fault check.", tier: "priority", todayCount: 2, laterCount: 1 },
    { tech: "tech_kelvin", skill: "basic_maintenance", category: "routine", desc: "Routine servicing, filter clean.", tier: "flexible", todayCount: 3, laterCount: 2 },
  ];

  const customers = [
    "Wong Mei Ling", "Farid Iskandar", "Tan Boon Keng", "Suresh Kumar", "Chua Li Wen",
    "Amir Hakim", "Ong Hui Fang", "Bala Krishnan", "Ng Wei Ting", "Rashid Ali",
    "Koh Sze Min", "Vijay Nathan", "Lim Poh Choo", "Zainab Aziz", "Tan Jun Hao",
    "Priscilla Goh", "Hafiz Rahman", "Chen Xiu Ying", "Kavitha Rao", "Wong Zi Xuan",
    "Muthu Selvam", "Angeline Teo", "Danish Iqbal", "Lee Kah Wei", "Nur Aisyah",
    "Marcus Lau", "Hema Malini", "Timothy Ho", "Siti Nurhaliza", "Ravi Chandran",
  ];

  const specs: SeedJobSpec[] = [];
  let n = 0;

  function pushJob(
    tech: string,
    plan: FillerPlan,
    args: { hourMode: "today_offset" | "fixed"; dayOffset: number; hour: number },
  ) {
    const idx = n % FILLER_ADDRESSES.length;
    const loc = FILLER_ADDRESSES[idx];
    const customer = customers[n % customers.length];
    n++;
    specs.push({
      id: `job_3${String(n).padStart(3, "0")}`,
      customer,
      email: `${customer.toLowerCase().replace(/\s+/g, ".")}@example.sg`,
      phone: `+65 9222 ${String(1000 + n).slice(-4)}`,
      address: loc.address,
      loc: loc.loc,
      desc: plan.desc,
      category: plan.category,
      skill: [plan.skill],
      tier: plan.tier,
      dayOffset: args.dayOffset,
      hour: args.hourMode === "today_offset" ? args.hour : Math.round(args.hour),
      hourMode: args.hourMode,
      status: "assigned",
      tech,
      stage: "assigned",
      createdHoursAgo: 6 + (n % 20),
    });
  }

  // ── "Today" fillers ─────────────────────────────────────────────
  // Anchored to `now` directly (today_offset), not the anchor grid —
  // that's what guarantees they land inside Capacity Agent's rolling 24h
  // window no matter what wall-clock hour the demo/seed runs at (see the
  // hourMode doc comment on why the two time bases don't otherwise line
  // up). Same-tech fillers land ~2.2h apart, clear of the ±90min clash
  // window.
  const todayCursor: Record<string, number> = {};
  for (const plan of plans) {
    if (plan.todayCount === 0 || NO_TODAY_FILLER_TECHS.has(plan.tech)) continue;
    for (let i = 0; i < plan.todayCount; i++) {
      const c = todayCursor[plan.tech] ?? 0;
      todayCursor[plan.tech] = c + 1;
      pushJob(plan.tech, plan, { hourMode: "today_offset", dayOffset: 0, hour: 1 + c * 2.2 });
    }
  }

  // ── "Later" fillers ─────────────────────────────────────────────
  // Flattened across ALL plans first, then dealt round-robin across days
  // 2-6 (5 days) — one job per day per pass — so the week comes out
  // EVENLY loaded regardless of how the per-plan counts happen to add up.
  // Assigning day-by-day per tech (the earlier version of this generator)
  // let whichever tech had the biggest laterCount dictate how full each
  // day got, which is how a demo run ended up with 27/3/15 jobs on three
  // consecutive days instead of a believable week. Day 1 (tomorrow) is
  // skipped — job_2004/2008 and the dynamic "+24h" re-plan/capacity
  // scenarios already use it, and piling fillers on top narrows how much
  // room those scenarios have.
  const LATER_DAYS = [2, 3, 4, 5, 6];
  type LaterReq = { tech: string; plan: FillerPlan };
  const laterQueue: LaterReq[] = [];
  for (const plan of plans) {
    for (let i = 0; i < plan.laterCount; i++) laterQueue.push({ tech: plan.tech, plan });
  }
  const hourCursorByTechDay = new Map<string, number>();
  laterQueue.forEach((req, i) => {
    const dayOffset = LATER_DAYS[i % LATER_DAYS.length];
    const key = `${req.tech}|${dayOffset}`;
    const slot = hourCursorByTechDay.get(key) ?? 0;
    hourCursorByTechDay.set(key, slot + 1);
    pushJob(req.tech, req.plan, { hourMode: "fixed", dayOffset, hour: 9 + slot * 3 });
  });

  return specs;
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

  // Tomorrow-afternoon job the agents already handled — assigned, waiting
  // for its slot. Gopal (Woodlands, refrigerant-certified) is free tomorrow;
  // job_2005/2006/2007 only load the refrigerant technicians at TODAY's
  // urgent slot, so there is no clash a day out.
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
    status: "assigned",
    tech: "tech_gopal",
    stage: "assigned",
    createdHoursAgo: 8,
  },
  ...buildFillerSpecs(),
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

  const jobs = SPECS.map((s) => {
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
    } else if (s.hourMode === "today_offset") {
      // Snapped into service hours like the dynamic slots — an offset that
      // would land at 2am gets pulled to the next open hour instead. The
      // offsets fillers use are small enough (≤ ~15h) that this never
      // pushes the job outside the "next 24h" window it exists to fall
      // inside of.
      scheduled = snapToServiceHours(addHours(now, s.hour), 0, DISPATCH_SERVICE_HOURS);
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

  resolveFillerClashes(jobs, freezeWindowHours);
  return jobs;
}

/**
 * Belt-and-braces pass: nudge any filler job (`job_3xxx`) that lands within
 * 90 min of ANY other job on the same technician — including the 10
 * hand-crafted jobs, whose dynamic slots (`urgent_slot`/`urgent_offset`)
 * are only known after they're resolved above. Fillers are on a separate,
 * fixed time basis by construction (see `buildFillerSpecs`) so this should
 * rarely fire, but a real coincidence is cheap to rule out here rather than
 * leave a double-booking in the seed. Mutates `jobs` in place.
 */
function resolveFillerClashes(jobs: Job[], freezeWindowHours: number): void {
  const byTech = new Map<string, Job[]>();
  for (const j of jobs) {
    if (!j.assigned_technician_id) continue;
    const arr = byTech.get(j.assigned_technician_id) ?? [];
    arr.push(j);
    byTech.set(j.assigned_technician_id, arr);
  }
  const isFiller = (id: string) => id.startsWith("job_3");

  for (const [, techJobs] of byTech) {
    // Fixed (non-filler) jobs are ground truth and never move; fillers are
    // nudged forward, in id order, until clear of everyone already placed.
    const fixed = techJobs.filter((j) => !isFiller(j.job_id));
    const fillers = techJobs
      .filter((j) => isFiller(j.job_id))
      .sort((a, b) => a.job_id.localeCompare(b.job_id));
    const placed = [...fixed];
    for (const job of fillers) {
      let guard = 0;
      while (
        placed.some(
          (p) => Math.abs(hoursBetween(p.scheduled_time, job.scheduled_time)) < 1.5,
        ) &&
        guard++ < 48
      ) {
        job.scheduled_time = addHours(job.scheduled_time, 1);
        job.freeze_point = computeFreezePoint(job.scheduled_time, freezeWindowHours);
      }
      placed.push(job);
    }
  }
}

function basePriceFor(skills: Job["skill_required"]): number {
  const table = DEFAULT_CONFIG.basePrice;
  return Math.max(...skills.map((s) => table[s] ?? 80));
}

function demoBreakdown(id: string) {
  // Deterministic pseudo-breakdowns for pre-assigned seed jobs so the Gantt
  // tooltips and feed have data before any agent runs. Same shape a live
  // score has (five weighted components in [0,1] that sum to `total`); the
  // numbers are synthetic but plausible — a decent-but-not-perfect match.
  const seed = [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const travel = r3(0.14 + (seed % 7) * 0.02);
  const skill_fit = r3(0.16 + (seed % 3) * 0.02);
  const availability = r3(0.09 + (seed % 5) * 0.015);
  const sla_headroom = r3(0.02 + (seed % 4) * 0.01);
  const load_balance = r3(0.05 + (seed % 6) * 0.015);
  return {
    travel,
    skill_fit,
    availability,
    sla_headroom,
    load_balance,
    total: r3(travel + skill_fit + availability + sla_headroom + load_balance),
    raw: {
      detour_min: 4 + (seed % 9),
      util_pct: 30 + (seed % 5) * 8,
      hours_to_deadline: 24 + (seed % 6) * 12,
    },
  };
}

// ── Synthetic pipeline trail for pre-assigned seed jobs ─────────────
//
// The seed represents a day the coordinator's agents have already worked
// through — so each assigned/frozen job needs a believable
// agent_decision_log, the same shape a live run writes, so that
// /admin/jobs/<id> (PipelineReplay) and the dashboard feed show a real
// pipeline instead of "no agent activity recorded".
//
// This is NOT a re-run of the pipeline: it's a deterministic reconstruction
// of what each agent would have logged, ending at the same pipeline_stage
// the job carries. `reasoning_kind` matches each agent's real nature
// (Job-Intake and Notification are LLM agents in this system; Pricing /
// Capacity / Tech-State / Assignment are rule engines) so the feed's
// LLM/rule split stays truthful — the reconstruction just didn't spend
// the tokens. Ordering matches /api/decisions?job=…: rows sort by
// timestamp, then by the base36 counter in the log_id tail — both
// ascending here, one row ~30s after the previous, the whole trail
// finishing a few minutes after the job's created_at.

function urgencyHintFor(tier: Job["tier"]): "low" | "medium" | "high" {
  if (tier === "urgent") return "high";
  if (tier === "flexible") return "low";
  return "medium";
}

interface SeededRow {
  agent: AgentDecisionLog["agent_name"];
  kind: "llm" | "rule";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  headline: string;
  outcome: AgentDecisionLog["outcome"];
  guardrails?: string[];
  score?: AgentDecisionLog["score_breakdown"];
  latencyMs?: number;
}

/**
 * One decision-log + notification set per assigned/frozen seed job.
 * `jobs` is the output of seedJobs(); `techs` the output of
 * seedTechnicians(). Returns both so the seed script / reset route can
 * insert them alongside the jobs.
 */
export function seedAgentActivity(
  jobs: Job[],
  techs: Technician[],
): { decisions: AgentDecisionLog[]; notifications: NotificationRecord[] } {
  const decisions: AgentDecisionLog[] = [];
  const notifications: NotificationRecord[] = [];
  const techName = (id: string | null) =>
    techs.find((t) => t.technician_id === id)?.name ?? id ?? "unassigned";

  // Global monotonic counter → the base36 tail /api/decisions sorts on.
  let seq = 0;
  const nextTail = () => (seq++).toString(36);

  for (const job of jobs) {
    if (!job.assigned_technician_id) continue; // pending / unassignable — no trail

    const tier = job.tier;
    const meta = TIER_META[tier];
    const urgency = urgencyHintFor(tier);
    const sb = job.score_breakdown ?? demoBreakdown(job.job_id);
    const basePrice = basePriceFor(job.skill_required);
    const certs = job.skill_required.map((s) => SKILL_CERT[s]).join(", ");
    const tName = techName(job.assigned_technician_id);
    const frozen = job.status === "frozen";

    const rows: SeededRow[] = [
      {
        agent: "Orchestrator",
        kind: "rule",
        input: { tier, category: job.problem_category, customer_name: job.customer_name },
        output: { pipeline: "start" },
        headline: `New booking received (${job.customer_name}, ${meta.labelEn})`,
        outcome: "info",
        guardrails: ["Booking passed schema validation (least-privilege, oversize-guarded)."],
      },
      {
        agent: "JobIntakeAgent",
        kind: "llm",
        input: { problem_description: job.problem_description, category_hint: job.problem_category },
        output: {
          skill_required: job.skill_required,
          urgency_hint: urgency,
          injection_attempt: false,
        },
        headline: `Classified as ${job.skill_required.join(" + ")} · urgency ${urgency}`,
        outcome: "auto_commit",
        guardrails: ["Customer free-text treated as untrusted input (delimited, no instructions followed)."],
      },
      {
        agent: "PricingEngine",
        kind: "rule",
        input: { skill_required: job.skill_required, tier },
        output: {
          price: job.price,
          base_price: basePrice,
          tier_multiplier: meta.priceMultiplier,
          currency: "SGD",
          breakdown: `${basePrice} SGD × ${meta.priceMultiplier} (${meta.labelEn}) = ${job.price} SGD`,
        },
        headline: `Priced at ${job.price} SGD (${meta.labelEn})`,
        outcome: "auto_commit",
        guardrails: ["Rule-based — no LLM call (deliberate architecture decision)."],
      },
      {
        agent: "CapacityAgent",
        kind: "rule",
        input: { tier, skill_required: job.skill_required },
        output: { decision: "accept", skill_saturated: false },
        headline: "Capacity OK — booking accepted at the requested window",
        outcome: "auto_commit",
        guardrails: ["Skill-aware saturation check (certified technicians for this skill in the next 24h)."],
      },
      {
        agent: "AssignmentAgent",
        kind: "rule",
        input: {
          skill_required: job.skill_required,
          required_certification: certs,
          tier,
          policy: DISPATCH_POLICY[tier],
          roster_size: techs.length,
        },
        output: {
          assigned_technician_id: job.assigned_technician_id,
          conflict: false,
        },
        headline: `Assigned ${tName} — match ${Math.round(sb.total * 100)}%`,
        outcome: "auto_commit",
        score: sb,
        guardrails: [
          "Reads the roster from context — least-privilege by construction: location and workload only, never phone or home address.",
          "Four hard constraints filter the pool before scoring (certification, working hours, no double-booking, route feasibility); scoring is travel + skill-fit + availability + SLA-headroom + load-balance, each in [0,1], weighted by the tier's dispatch policy.",
        ],
      },
      {
        agent: "NotificationAgent",
        kind: "llm",
        input: { channel: "technician_app", kind: "new_assignment" },
        output: { recipient: job.assigned_technician_id, acknowledged: false },
        headline: `Job card sent to ${tName}'s app`,
        outcome: "info",
        guardrails: ["Notification built from structured job facts only — not the raw customer text."],
      },
      {
        agent: "NotificationAgent",
        kind: "llm",
        input: { channel: "customer_email", kind: "booking_confirmed" },
        output: { recipient: job.customer_email, acknowledged: false },
        headline: `Booking confirmation emailed to ${job.customer_name}`,
        outcome: "info",
      },
      {
        agent: "Orchestrator",
        kind: "rule",
        input: { conflict: false },
        output: {
          result: frozen ? "assigned_auto" : "assigned_auto",
          technician: job.assigned_technician_id,
        },
        headline: frozen
          ? "Auto-committed — schedule since locked (inside freeze window)"
          : "Auto-commit: technician assigned, no schedule conflict",
        outcome: "auto_commit",
        guardrails: ["Zero impact on other jobs → full autonomy, no human approval needed."],
      },
    ];

    // Anchor the trail a few minutes after the booking was created.
    const startMs = new Date(job.created_at).getTime() + 4_000;
    rows.forEach((r, i) => {
      const ts = new Date(startMs + i * 32_000).toISOString();
      decisions.push({
        log_id: `seedlog_${job.job_id}_${nextTail()}`,
        timestamp: ts,
        agent_name: r.agent,
        job_id: job.job_id,
        reasoning_kind: r.kind,
        input_summary: r.input,
        output_summary: r.output,
        score_breakdown: r.score ?? null,
        candidates: null,
        replan_options: null,
        requires_human_approval: false,
        outcome: r.outcome,
        approved_by: null,
        headline: r.headline,
        latency_ms: r.latencyMs ?? (r.kind === "llm" ? 900 : 0),
        guardrail_notes: r.guardrails ?? [],
      });
    });

    // Two notifications, matching the two NotificationAgent rows.
    const notifBase = new Date(startMs + rows.length * 32_000).toISOString();
    notifications.push({
      notification_id: `seednote_${job.job_id}_tech`,
      created_at: notifBase,
      channel: "technician_app",
      recipient_id: job.assigned_technician_id,
      job_id: job.job_id,
      kind: "new_assignment",
      subject: `New job · ${job.customer_name}`,
      body: `${job.skill_required.join(" + ")} at ${job.location.address}. Tap "Seen" to acknowledge.`,
      acknowledged: frozen,
      acknowledged_at: frozen ? addHours(notifBase, 1) : null,
    });
    notifications.push({
      notification_id: `seednote_${job.job_id}_cust`,
      created_at: notifBase,
      channel: "customer_email",
      recipient_id: job.customer_email,
      job_id: job.job_id,
      kind: "booking_confirmed",
      subject: `Your CoolFix booking is confirmed`,
      body: `Hi ${job.customer_name}, ${tName} is scheduled to visit. We'll remind you before the appointment.`,
      acknowledged: false,
      acknowledged_at: null,
    });
  }

  return { decisions, notifications };
}
