// POST /api/notifications/:id/ack — two-way notification acknowledgement
// ("Seen" button in the technician app).

import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  await repo.ackNotification(params.id);
  return NextResponse.json({ ok: true });
}
