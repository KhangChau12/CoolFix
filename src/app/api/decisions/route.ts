// GET /api/decisions?limit=200 — Agent Reasoning Feed data.
// (The browser also subscribes to realtime inserts directly; this is the
// initial page load + a polling fallback.)

import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);
  const decisions = await repo.listDecisions(limit);
  return NextResponse.json({ decisions });
}
