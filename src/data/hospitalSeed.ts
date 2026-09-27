/** Starting state for a live hospital emergency booking, not a canned approval. */
import { seedTechnicians, seedAgentActivity } from "./seed";
import { addHours, computeFreezePoint, nowISO, sgDayKey } from "@/lib/time";
import { generateTrackingToken } from "@/lib/trackingToken";
import { DEFAULT_CONFIG, type ApprovalRequest, type Job, type JobFeedback } from "@/lib/types";
import type { BookingRequest } from "@/agents/schemas";

export const HOSPITAL_BOOKING: BookingRequest = {
  customer_name: "Demo Hospital - Facilities Desk",
  customer_email: "facilities@example.invalid",
  customer_phone: "",
  address: "Demo Hospital, 5 Lower Kent Ridge Road, Singapore",
  location: { lat: 1.2936, lng: 103.7831 },
  problem_category: "not_cooling",
  problem_description: "Emergency: the hospital ward aircon is not cooling and has a suspected refrigerant leak. The ward temperature is rising and patients are affected. We need an urgent repair today. Please coordinate access with the facilities desk.",
  photo_url: null,
  tier: "urgent",
  preferred_date: null,
};

export function buildHospitalDataset(anchorISO = nowISO()) {
  if (!Number.isFinite(Date.parse(anchorISO))) throw new Error("Invalid hospital demo anchor date");
  const clock = new Date(`${sgDayKey(anchorISO)}T09:00:00+08:00`).toISOString();
  const config = {
    ...structuredClone(DEFAULT_CONFIG),
  };
  const technicians = seedTechnicians().map((tech, i) => ({
    ...tech, photo_url: "", phone: "", current_workload: 3,
    // Synthetic extended coverage leaves enough time to finish a late re-plan.
    working_hours: { start: "08:00", end: "22:00" },
    // Nearby service sites keep alternative handovers feasible, including travel.
    location: { lat: HOSPITAL_BOOKING.location.lat + (i - 4) * 0.004, lng: HOSPITAL_BOOKING.location.lng + (i % 3) * 0.003 },
  }));
  const jobs: Job[] = [];
  for (const [i, tech] of technicians.entries()) {
    // All nine are on site now AND booked at the urgent dispatch slot (13:00).
    // Standard appointments can be proposed for displacement, but require HITL.
    for (const [stop, hour] of [9, 13, 16].entries()) {
      const skill = tech.skill_tags.includes("refrigerant_handling")
        ? "refrigerant_handling" : tech.skill_tags.includes("basic_maintenance")
          ? "basic_maintenance" : "electrical_work";
      const time = addHours(clock, hour - 9);
      const id = `hospital_base_${String(i + 1).padStart(2, "0")}_${stop + 1}`;
      jobs.push({
        job_id: id,
        customer_name: `[DEMO] ${["Morning repair", "Confirmed service appointment", "Afternoon repair"][stop]} ${i + 1}`,
        customer_email: `${id}@example.invalid`, customer_phone: "",
        location: { ...tech.location, address: `Demo service site ${i + 1}, Singapore` },
        problem_description: stop === 1
          ? "[DEMO] Confirmed Standard-tier appointment. Contact this customer to agree a replacement slot before approving any displacement for the hospital emergency."
          : "[DEMO] Existing repair booking occupying this technician; synthetic test data.",
        problem_category: skill, photo_url: null, skill_required: [skill], tier: "standard",
        scheduled_time: time, freeze_point: computeFreezePoint(time, config.freezeWindowHours),
        status: stop === 0 ? "in_progress" : "assigned",
        assigned_technician_id: tech.technician_id, score_breakdown: null,
        price: config.basePrice[skill], created_at: addHours(clock, -24),
        pipeline_stage: "assigned", reschedule_history: [],
        public_tracking_token: generateTrackingToken(), tech_substatus: stop === 0 ? "arrived" : null,
        dispatch_policy_version: config.policyVersion, dispatch_policy_snapshot: config.dispatchPolicy,
      });
    }
  }
  const { decisions, notifications } = seedAgentActivity(jobs, technicians);
  for (const d of decisions) {
    d.headline = `[DEMO replay] ${d.headline}`;
    d.input_summary = { ...d.input_summary, synthetic_demo: true };
    d.guardrail_notes.push("Synthetic background appointment replay; the hospital booking runs live after user submission.");
  }
  for (const n of notifications) {
    n.subject = `[DEMO] ${n.subject}`;
    n.body = `Simulated notification only. ${n.body}`;
  }
  return {
    anchorISO: clock, config, technicians, jobs, decisions, notifications,
    approvals: [] as ApprovalRequest[], feedback: [] as JobFeedback[],
    scenarios: [{
      id: "hospital-emergency", title: "All technicians busy: hospital emergency needs human approval",
      booking: HOSPITAL_BOOKING,
      explanation: "Submit this Urgent booking live. No technician is free at 13:00. The agent proposes moving a confirmed Standard appointment, waits for named coordinator approval, then reschedules and dispatches. Rejecting keeps existing appointments unchanged.",
    }],
  };
}
