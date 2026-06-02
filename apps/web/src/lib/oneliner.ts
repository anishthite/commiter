import "server-only";
import type { Snapshot } from "./snapshot";

/**
 * Produce a single short sentence shown above the dashboard to nudge or
 * congratulate the operator. Tries Claude Haiku if `ANTHROPIC_API_KEY` is
 * set; falls back to a deterministic rule-based pool otherwise.
 *
 * Cached in-memory for 1 hour keyed on (PT hour bucket, today counts,
 * streak length). The page-level `revalidate = 3600` does most of the
 * heavy lifting — this cache just protects dev-mode reloads from
 * burning API calls.
 */
const TTL_MS = 60 * 60 * 1000;
let cache: { key: string; line: string; ts: number } | null = null;

export async function getOneLiner(snapshot: Snapshot): Promise<string> {
  const ctx = describe(snapshot);
  const key = `${ctx.hourBucket}|${ctx.gh}|${ctx.x}|${ctx.streak}`;
  if (cache && cache.key === key && Date.now() - cache.ts < TTL_MS) {
    return cache.line;
  }

  let line: string;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      line = await llmLine(ctx);
    } catch (e) {
      console.warn(
        "[oneliner] LLM failed, falling back to rules:",
        e instanceof Error ? e.message : e
      );
      line = rulesLine(ctx);
    }
  } else {
    line = rulesLine(ctx);
  }

  cache = { key, line, ts: Date.now() };
  return line;
}

type Ctx = {
  hourBucket: string;
  hourPT: number;
  gh: number;
  x: number;
  streak: number;
  longest: number;
  tz: string;
};

function describe(snapshot: Snapshot): Ctx {
  const now = new Date();
  const hourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: snapshot.tz,
    hour: "2-digit",
    hour12: false,
  }).format(now);
  const hourPT = parseInt(hourStr, 10);
  return {
    hourBucket: now.toISOString().slice(0, 13),
    hourPT: Number.isFinite(hourPT) ? hourPT : 12,
    gh: snapshot.channels.github.today_count,
    x: snapshot.channels.twitter.today_count,
    streak: snapshot.combined.streak_current,
    longest: snapshot.combined.streak_longest,
    tz: snapshot.tz,
  };
}

/* ------------------------------- LLM path ------------------------------- */

async function llmLine(ctx: Ctx): Promise<string> {
  const prompt = `you are nerv's terminal: a terse, sardonic, motivational console for one operator who ships code on github and posts on x. you do not praise easily. you are not cute.

state:
- time (${ctx.tz}): ~${String(ctx.hourPT).padStart(2, "0")}:00
- github today: ${ctx.gh} commits
- x today: ${ctx.x} tweets
- combined streak (days with both): ${ctx.streak}
- longest ever: ${ctx.longest}

write ONE LINE, 8-16 words MAX, lowercase, no emojis, no exclamation marks. blunt, observational, time-aware. focus on the COMBINED STREAK — reference the number, what's at stake if today gets dropped, or the new high if today lands. ends in a period. nothing else, no quotes, just the line.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 80,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(5000),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`anthropic http ${res.status}`);
  }
  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("anthropic returned no text");
  return clean(text);
}

function clean(s: string): string {
  return s
    .trim()
    .split("\n")[0]!
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .slice(0, 200);
}

/* ------------------------------ Rule path ------------------------------- */

function rulesLine(ctx: Ctx): string {
  const { gh, x, streak, longest, hourPT } = ctx;
  const bothShipped = gh > 0 && x > 0;

  if (bothShipped) {
    if (streak >= longest && longest >= 5) {
      return `${streak} days. record territory. don't blink.`;
    }
    if (streak >= 7) return `${streak} days running. don't be the one who broke it.`;
    if (streak >= 3) return `both shipped. ${streak}d streak. keep typing.`;
    return "both today. clean run. now go eat.";
  }

  if (gh > 0 && x === 0) {
    if (hourPT >= 21) return "code's in. one tweet before midnight closes the loop.";
    return "code's in. now tell the world. 280 chars.";
  }

  if (x > 0 && gh === 0) {
    if (hourPT >= 21) return "you posted. now build, even a typo fix.";
    return "you talked about it. now build it. one commit.";
  }

  // both at zero. We used to nag with a different line per hour bucket;
  // dropped that ladder — the giant "no." headline already makes the
  // point. Only the late-evening streak-at-risk warning survives because
  // it carries actual information (the streak number) rather than just
  // editorializing about the clock.
  if (streak >= 14 && hourPT >= 18) {
    return `${streak}-day streak about to die. don't let it.`;
  }
  return "nothing shipped yet.";
}
