import { USERS } from "@/config/users";
import { intensity, toWeeksGrid } from "@/lib/heatmap";
import { getSnapshot, type Snapshot } from "@/lib/snapshot";
import type { Day } from "@/lib/streak";
import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const revalidate = 3600;
export const alt = "did we ship today? Last 13 weeks shipping heatmap";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const bg = "#faf3e6";
const text = "#2a1500";
const orange = "#c4471a";
const amber = "#8a5a00";
const cells = ["#ede0c6", "#e8b894", "#d97a3a", "#c4471a", "#8a3500"] as const;

function socialChannels(snapshot: Snapshot) {
  return Object.entries(snapshot.channels)
    .filter(([name, channel]) => name !== "github" && channel.offline !== true)
    .map(([, channel]) => channel);
}

function isShipped(snapshot: Snapshot): boolean {
  const socials = socialChannels(snapshot);
  const socialToday = socials.reduce((sum, channel) => sum + channel.today_count, 0);
  return snapshot.channels.github.today_count > 0 && (socials.length === 0 || socialToday > 0);
}

function combinedDays(snapshot: Snapshot): Day[] {
  const gh = snapshot.channels.github.days;
  const socials = socialChannels(snapshot);
  if (socials.length === 0) return gh;
  return gh.map((d, i) => ({
    date: d.date,
    count: d.count > 0 && socials.some((s) => (s.days[i]?.count ?? 0) > 0) ? 1 : 0,
  }));
}

async function loadPreview() {
  const user = USERS[0];
  if (!user) return { shipped: false, days: [] as Day[] };
  try {
    const snapshot = await getSnapshot({ user, days: 91 });
    return { shipped: isShipped(snapshot), days: combinedDays(snapshot) };
  } catch (error) {
    console.warn("[opengraph-image] falling back to empty heatmap", error);
    return { shipped: false, days: [] as Day[] };
  }
}

function Heatmap({ days }: { days: Day[] }) {
  const weeks = toWeeksGrid(days).slice(-13);
  while (weeks.length < 13) weeks.unshift([null, null, null, null, null, null, null]);

  return (
    <div style={{ display: "flex", gap: 9 }}>
      {weeks.map((week, weekIndex) => (
        <div key={weekIndex} style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {week.map((day, dayIndex) => (
            <div
              key={day?.date ?? `${weekIndex}-${dayIndex}`}
              style={{
                width: 26,
                height: 26,
                borderRadius: 5,
                backgroundColor: day ? cells[intensity(day.count)] : "transparent",
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export default async function Image() {
  const preview = await loadPreview();
  const answer = preview.shipped ? "yes." : "no.";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: bg,
          color: text,
          padding: 24,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 56,
            padding: 54,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <div style={{ fontSize: 86, fontWeight: 800, letterSpacing: -5, lineHeight: 0.98 }}>
              did we ship today?
            </div>
            <div
              style={{
                marginTop: 36,
                fontSize: 150,
                fontWeight: 900,
                letterSpacing: -8,
                lineHeight: 0.9,
                color: preview.shipped ? amber : orange,
              }}
            >
              {answer}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <div style={{ fontSize: 27, letterSpacing: "0.18em", textTransform: "uppercase", color: amber }}>
              last 13 weeks
            </div>
            <Heatmap days={preview.days} />
          </div>
        </div>
      </div>
    ),
    size
  );
}
