import { NextResponse } from "next/server";
import { getSnapshot, resolveUser } from "@/lib/snapshot";

export const runtime = "nodejs";
export const revalidate = 3600;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const daysParam = url.searchParams.get("days");
  const userParam = url.searchParams.get("user");

  let days = Number(daysParam);
  if (!Number.isFinite(days)) days = 365;
  days = Math.min(Math.max(days, 7), 365);

  try {
    const user = resolveUser(userParam || undefined);
    const snapshot = await getSnapshot({ user, days });
    return NextResponse.json(snapshot, {
      headers: {
        "cache-control": "public, s-maxage=3600, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    console.error("[snapshot route]", err);
    return NextResponse.json({ error: "snapshot_failed" }, { status: 500 });
  }
}
