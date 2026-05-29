import { NextResponse } from "next/server";
import { getSnapshot } from "@/lib/snapshot";

export const runtime = "nodejs";
// Underlying source fetches are cached 1h at the Next fetch layer (D-004).
// Aligning the route revalidate keeps the cached JSON in sync with that
// window.
export const revalidate = 3600;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const daysParam = url.searchParams.get("days");
  const days = daysParam ? Math.min(Math.max(parseInt(daysParam, 10) || 365, 7), 365) : 365;

  try {
    const snapshot = await getSnapshot(days);
    return NextResponse.json(snapshot, {
      headers: {
        "cache-control": "public, s-maxage=3600, stale-while-revalidate=600",
      },
    });
  } catch (e) {
    // Log the full error server-side; never echo it to the client —
    // raw errors can include tokens, file paths, or login strings.
    console.error("[snapshot] error", e);
    return NextResponse.json({ error: "snapshot_failed" }, { status: 500 });
  }
}
