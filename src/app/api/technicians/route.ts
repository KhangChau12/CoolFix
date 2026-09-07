// GET  /api/technicians — roster for the Admin technician screen.
// POST /api/technicians — add a technician (Admin form).

import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";
import { SKILL_TAGS, type SkillTag } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const technicians = await repo.listTechnicians();
  return NextResponse.json({ technicians });
}

export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const skills = Array.isArray(b.skill_tags)
    ? (b.skill_tags as unknown[]).filter((s): s is SkillTag =>
        SKILL_TAGS.includes(s as SkillTag),
      )
    : [];
  if (!b.name || typeof b.name !== "string") {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (skills.length === 0) {
    return NextResponse.json({ error: "At least one valid skill_tag is required" }, { status: 400 });
  }

  const tech = {
    technician_id: `tech_${Date.now().toString(36)}`,
    name: String(b.name).slice(0, 120),
    photo_url: typeof b.photo_url === "string" ? b.photo_url : "https://i.pravatar.cc/120",
    skill_tags: skills,
    experience_level: b.experience_level === "senior" ? ("senior" as const) : ("junior" as const),
    location: (b.location as { lat: number; lng: number }) ?? { lat: 1.3521, lng: 103.8198 },
    working_hours: (b.working_hours as { start: string; end: string }) ?? {
      start: "09:00",
      end: "18:00",
    },
    current_workload: 0,
    phone: typeof b.phone === "string" ? b.phone : "",
  };
  await repo.upsertTechnician(tech);
  return NextResponse.json({ technician: tech }, { status: 201 });
}
