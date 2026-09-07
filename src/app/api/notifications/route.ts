// GET  /api/notifications?recipient=tech_x — technician / customer inbox.
// POST /api/notifications/:id/ack handled in [id]/ack/route.ts

import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const recipient = url.searchParams.get("recipient");
  const jobId = url.searchParams.get("job");
  let notifications = await repo.listNotifications();
  if (recipient) notifications = notifications.filter((n) => n.recipient_id === recipient);
  if (jobId) notifications = notifications.filter((n) => n.job_id === jobId);
  return NextResponse.json({ notifications });
}
