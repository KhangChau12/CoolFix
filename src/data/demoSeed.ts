/** Showcase data, deliberately separate from the small regression-test fixture.
 * Schedules/IDs are repeatable; public tracking credentials remain random.
 * All people, bookings, activity and feedback in this dataset are synthetic.
 */
import { seedTechnicians, seedAgentActivity } from "./seed";
import { distanceKm, SG_LANDMARKS } from "@/lib/geo";
import { addHours, computeFreezePoint, nowISO, sgDayKey } from "@/lib/time";
import { generateTrackingToken } from "@/lib/trackingToken";
import {
  DEFAULT_CONFIG, TIER_META, estimatedJobMinutes,
  type ApprovalRequest, type GeoPoint, type Job, type JobFeedback,
  type ReplanOption, type RuntimeConfig, type SkillTag, type Technician,
} from "@/lib/types";

const PLACES = [
  { ...SG_LANDMARKS.cityHall, address: "City Hall, North Bridge Road, Singapore" },
  { ...SG_LANDMARKS.jurongEast, address: "Jurong East Central, Singapore" },
  { ...SG_LANDMARKS.tampines, address: "Tampines Central, Singapore" },
  { ...SG_LANDMARKS.woodlands, address: "Woodlands Square, Singapore" },
  { ...SG_LANDMARKS.bishan, address: "Bishan Street 13, Singapore" },
  { ...SG_LANDMARKS.buonaVista, address: "Buona Vista, North Buona Vista Road, Singapore" },
  { ...SG_LANDMARKS.changi, address: "Changi Business Park, Singapore" },
  { ...SG_LANDMARKS.clementi, address: "Clementi Avenue 3, Singapore" },
  { ...SG_LANDMARKS.punggol, address: "Punggol Central, Singapore" },
  { ...SG_LANDMARKS.sengkang, address: "Sengkang Square, Singapore" },
  { ...SG_LANDMARKS.yishun, address: "Yishun Avenue 2, Singapore" },
];

function destination(from: GeoPoint, rotation: number): Job["location"] {
  // Visible cross-district routes with enough slack for the existing peak-hour
  // drive estimate. Never claim these are observed traffic conditions.
  const choices = PLACES.filter((p) => distanceKm(from, p) >= 8 && distanceKm(from, p) <= 20);
  return { ...choices[rotation % choices.length] };
}

export function buildDemoDataset(anchorISO = nowISO()) {
  if (!Number.isFinite(Date.parse(anchorISO))) throw new Error("Invalid demo anchor date");
  const day = sgDayKey(anchorISO);
  const clock = new Date(`${day}T09:00:00+08:00`).toISOString();
  const at = (dayOffset: number, hour: number) => addHours(clock, dayOffset * 24 + hour - 9);
  const config: RuntimeConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    capacityTotalPerDay: 48, capacityFlexiblePerDay: 16,
  };
  const technicians: Technician[] = seedTechnicians().map((t) => ({
    ...t, working_hours: { start: "09:00", end: "20:00" }, current_workload: 0,
  }));
  const additions = [
    { name: "Siti Rahman", id: "siti", location: SG_LANDMARKS.clementi },
    { name: "Arun Menon", id: "arun", location: SG_LANDMARKS.cityHall },
    { name: "Jasmine Lee", id: "jasmine", location: SG_LANDMARKS.tampines },
  ];
  additions.forEach((t, i) => technicians.push({
    technician_id: `tech_${t.id}`, name: t.name, photo_url: "",
    skill_tags: i === 1 ? ["basic_maintenance", "refrigerant_handling"] : ["basic_maintenance", "electrical_work"],
    experience_level: i === 0 ? "junior" : "senior", location: t.location,
    working_hours: { start: "09:00", end: "20:00" }, current_workload: 0,
    phone: `+65 8000 00${10 + i}`,
  }));
  const jobs: Job[] = [];
  let sequence = 0;
  function makeJob(tech: Technician | null, time: string, skill: SkillTag, location: Job["location"], tier: Job["tier"]): Job {
    const n = ++sequence;
    const created = addHours(time, -Math.min(TIER_META[tier].slaHours / 2, 48));
    return {
      job_id: `demo_job_${String(n).padStart(4, "0")}`,
      customer_name: `Demo Customer ${String(n).padStart(3, "0")}`,
      customer_email: `customer${n}@example.invalid`, customer_phone: "+65 8000 0000",
      location, problem_description: `[DEMO] ${skill.replaceAll("_", " ")} service requested at ${location.address}.`,
      problem_category: skill, photo_url: null, skill_required: [skill], tier,
      scheduled_time: time, freeze_point: computeFreezePoint(time, config.freezeWindowHours),
      status: "assigned", assigned_technician_id: tech?.technician_id ?? null,
      score_breakdown: null, price: Math.round(config.basePrice[skill] * TIER_META[tier].priceMultiplier),
      created_at: created > clock ? addHours(clock, -1) : created,
      pipeline_stage: "assigned", reschedule_history: [], public_tracking_token: generateTrackingToken(), tech_substatus: null,
      dispatch_policy_version: config.policyVersion, dispatch_policy_snapshot: config.dispatchPolicy,
    };
  }

  // 34 appointments per day over five days: two days of service history,
  // a busy current day, and two future days for the multi-day scheduler.
  for (let offset = -2; offset <= 2; offset++) {
    technicians.forEach((tech, techIndex) => {
      const chiller = tech.skill_tags.includes("commercial_chiller");
      const slots = chiller ? [11, 16] : [11, 14.5, 18];
      let previous = tech.location;
      slots.forEach((hour, stop) => {
        const location = destination(previous, techIndex + stop + offset + 2);
        previous = location;
        const skill: SkillTag = chiller ? "commercial_chiller" : tech.skill_tags[(stop + offset + 2) % tech.skill_tags.length];
        // Future bookings are standard/flexible so their SLA windows remain
        // valid even though they were all booked before the demo clock.
        const tier = offset > 0 ? (stop % 2 ? "flexible" : "standard") : (["standard", "priority", "flexible"] as const)[(techIndex + stop) % 3];
        const job = makeJob(tech, at(offset, hour), skill, location, tier);
        if (offset < 0) {
          job.status = "completed";
          job.pipeline_stage = "done";
        } else if (offset === 0 && stop === 0) {
          job.status = "frozen";
          if (techIndex === 1 || techIndex === 4) {
            job.status = "in_progress";
            job.tech_substatus = "en_route";
          }
        }
        jobs.push(job);
      });
    });
  }

  const approvals: ApprovalRequest[] = [];
  const scenarios: { id: string; title: string; jobId: string; approvalId: string; explanation: string }[] = [];
  function approval(job: Job, title: string, reason: string, options: ReplanOption[], frozen: string[] = []) {
    const id = `demo_approval_${approvals.length + 1}`;
    approvals.push({
      approval_id: id, created_at: addHours(clock, -(approvals.length + 1) / 60),
      kind: frozen.length ? "emergency_override" : "standard", job_id: job.job_id,
      reason: `[DEMO] ${reason}`, disruption_log_id: `demo_disruption_${id}`, options,
      chosen_option_id: null, status: "pending", resolved_by: null, resolved_at: null,
      frozen_jobs_impacted: frozen,
    });
    scenarios.push({ id, title, jobId: job.job_id, approvalId: id, explanation: reason });
  }
  function replacement(technicianId: string, hour: number, emergency: boolean) {
    const existing = jobs.find((j) => j.assigned_technician_id === technicianId && j.scheduled_time === at(0, hour))!;
    existing.tier = "standard";
    existing.price = config.basePrice[existing.skill_required[0]];
    const tech = technicians.find((t) => t.technician_id === technicianId)!;
    const incoming = makeJob(tech, existing.scheduled_time, existing.skill_required[0], { ...existing.location }, "urgent");
    incoming.customer_name = emergency ? "Demo Clinic — cooling outage" : "Demo Pharmacy — temperature alarm";
    incoming.problem_description = emergency ? "[DEMO] Clinic cooling outage; changing a frozen appointment requires coordinator approval and customer contact." : "[DEMO] Urgent temperature alarm; a standard customer contests being displaced to another day.";
    incoming.created_at = addHours(clock, -0.25);
    incoming.status = "pending";
    incoming.pipeline_stage = "awaiting_approval";
    jobs.push(incoming);
    const options: ReplanOption[] = [11, 15].map((moveHour, i) => ({
      option_id: `demo_option_${emergency ? "frozen" : "standard"}_${i + 1}`,
      label: `Move existing visit to day +3, ${moveHour}:00`,
      summary: "Offer the existing customer a new visit after the busy two-day schedule; confirm consent before approving.",
      moves: [{ job_id: existing.job_id, customer_name: existing.customer_name, from_time: existing.scheduled_time, to_time: at(3, moveHour), technician_id: technicianId }],
      trade_offs: { customers_affected: 1, total_added_travel_km: distanceKm(tech.location, existing.location), sla_breaches: 0, frozen_jobs_touched: emergency ? 1 : 0, total_shift_hours: 72 + moveHour - hour },
      recommended: i === 0,
    }));
    approval(incoming, emergency ? "Frozen appointment / emergency override" : "Customer rescheduling dispute", incoming.problem_description.replace("[DEMO] ", ""), options, emergency ? [existing.job_id] : []);
  }
  replacement("tech_marcus", 14.5, false);
  replacement("tech_priya", 11, true);

  const paired = makeJob(null, at(0, 15), "commercial_chiller", { ...PLACES[1] }, "priority");
  paired.customer_name = "Demo Industrial Plant — supervised pair";
  paired.skill_required = ["commercial_chiller", "refrigerant_handling", "electrical_work"];
  paired.status = "pending"; paired.pipeline_stage = "awaiting_approval";
  paired.problem_description = "[DEMO] Plant access requires two technicians and an isolation permit. A coordinator must confirm the permit, customer access, and a supervised team; approving only acknowledges manual ownership.";
  jobs.push(paired);
  approval(paired, "Safety permit / supervised pair", paired.problem_description.replace("[DEMO] ", ""), []);

  const dispute = makeJob(null, at(0, 18), "refrigerant_handling", { ...PLACES[6] }, "standard");
  dispute.customer_name = "Demo Customer — disputed repair quote";
  dispute.status = "pending"; dispute.pipeline_stage = "awaiting_approval";
  dispute.problem_description = "[DEMO] Customer disputes the refrigerant quote and declines site access until a coordinator explains the price. Approving acknowledges manual follow-up; it does not charge the customer or dispatch a technician.";
  jobs.push(dispute);
  approval(dispute, "Price dispute / customer access", dispute.problem_description.replace("[DEMO] ", ""), []);

  const committed = jobs.filter((j) => j.status !== "pending");
  const { decisions, notifications } = seedAgentActivity(committed, technicians);
  decisions.forEach((d) => {
    d.headline = `[DEMO replay] ${d.headline}`;
    d.input_summary = { ...d.input_summary, synthetic_demo: true };
    d.guardrail_notes.push("Synthetic seed replay; no LLM call or real delivery occurred.");
  });
  notifications.forEach((n) => {
    n.subject = `[DEMO] ${n.subject}`;
    n.body = `Simulated notification only. ${n.body}`;
  });
  for (const a of approvals) decisions.push({
    log_id: a.disruption_log_id, timestamp: a.created_at,
    agent_name: a.options.length ? "DisruptionAgent" : "AssignmentEdgecaseAgent",
    job_id: a.job_id, reasoning_kind: "rule", input_summary: { synthetic_demo: true },
    output_summary: { approval_id: a.approval_id, reason: a.reason }, replan_options: a.options,
    requires_human_approval: true, outcome: "requires_approval", approved_by: null,
    headline: a.reason, latency_ms: 0,
    guardrail_notes: ["Human decision required. Synthetic demo case; no customer has been contacted."],
  });
  const feedback: JobFeedback[] = committed.filter((j) => j.status === "completed").map((j, i) => ({
    feedback_id: `demo_feedback_${j.job_id}`, job_id: j.job_id, technician_id: j.assigned_technician_id!,
    rating: i % 9 === 0 ? 2 : i % 4 === 0 ? 4 : 5,
    positive_tags: i % 9 === 0 ? [] : ["professional", "explained_clearly"],
    improvement_tags: i % 9 === 0 ? ["late_arrival", "communication"] : [],
    comment: i % 9 === 0 ? "[DEMO] Arrival was late and the revised ETA was not communicated." : "[DEMO] Service completed and the repair was explained clearly.",
    created_at: addHours(j.scheduled_time, estimatedJobMinutes(j.skill_required) / 60 + 0.5),
    source_hash: null, flagged: false, excluded_from_adaptation: false, flag_reason: null,
  }));
  technicians.forEach((t) => {
    t.current_workload = committed.filter((j) => j.assigned_technician_id === t.technician_id && sgDayKey(j.scheduled_time) === day).length;
  });
  return { anchorISO: clock, technicians, jobs, decisions, notifications, feedback, approvals, config, scenarios };
}
