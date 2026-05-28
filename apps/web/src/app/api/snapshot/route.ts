import { NextResponse } from "next/server";
import { getSnapshot } from "@/lib/snapshot-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const daysParam = url.searchParams.get("days");
  const days = daysParam ? Math.min(Math.max(parseInt(daysParam, 10) || 365, 7), 365) : 365;

  try {
    const snapshot = await getSnapshot(days);
    return NextResponse.json(snapshot, {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
