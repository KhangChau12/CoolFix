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

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<{
      notification_id: string;
      channel: "technician_app" | "customer_email";
      recipient_id: string;
      job_id: string;
      kind: "route_change_request";
      subject: string;
      body: string;
    }>;

    if (
      body.channel !== "technician_app" ||
      body.kind !== "route_change_request" ||
      !body.recipient_id ||
      !body.job_id ||
      !body.subject ||
      !body.body
    ) {
      return NextResponse.json({ error: "A technician route-change notification is incomplete." }, { status: 400 });
    }

    const notification = {
      notification_id:
        body.notification_id ?? `ntf_route_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      created_at: new Date().toISOString(),
      channel: body.channel,
      recipient_id: body.recipient_id,
      job_id: body.job_id,
      kind: body.kind,
      subject: body.subject,
      body: body.body,
      acknowledged: false,
      acknowledged_at: null,
    } as const;

    await repo.insertNotification(notification);
    return NextResponse.json({ notification }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to create notification." },
      { status: 500 },
    );
  }
}
