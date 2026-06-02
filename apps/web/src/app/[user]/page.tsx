import Link from "next/link";
import { notFound } from "next/navigation";
import { getSnapshot } from "@/lib/snapshot";
import { getOneLiner } from "@/lib/oneliner";
import { MagiPanel } from "@/lib/nerv/MagiPanel";
import { ThemeToggle } from "@/lib/nerv/ThemeToggle";
import { USERS, getUserBySlug } from "@/config/users";

export const revalidate = 3600;

// Pre-render both /anish and /subby at build time. New users in users.json
// get a static page each on the next deploy.
export function generateStaticParams() {
  return USERS.map((u) => ({ user: u.slug }));
}

type Params = { user: string };

export default async function UserPage({
  params,
}: {
  // Next 15 made params async — await it to satisfy the type. Works on
  // Next 14 as well since Promise<T> awaits to T.
  params: Promise<Params> | Params;
}) {
  const { user: slug } = await Promise.resolve(params);
  const userCfg = getUserBySlug(slug);
  if (!userCfg) {
    notFound();
  }

  let snapshot;
  let oneliner = "";
  let error: string | null = null;
  try {
    snapshot = await getSnapshot({ user: userCfg!, days: 365 });
    oneliner = await getOneLiner(snapshot);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const ghToday = snapshot?.channels.github.today_count ?? 0;
  const xToday = snapshot?.channels.twitter.today_count ?? 0;
  const xOffline = snapshot?.channels.twitter.offline === true;
  const shipped = xOffline ? ghToday > 0 : ghToday > 0 && xToday > 0;
  const combinedCurrent = snapshot?.combined.streak_current ?? 0;
  const displayName = userCfg?.displayName ?? slug;

  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 sm:py-12 max-w-6xl mx-auto">
      {/* Nav: back to summary + sibling-user quick links. */}
      {/* py-2 -my-2 expands the tap target to ~44px without disturbing the */}
      {/* visual rhythm; aria-current makes the active state non-color-only */}
      {/* (reviewer-flagged 2026-06-01). */}
      <nav className="mb-6 flex flex-wrap items-center gap-1 text-[10px] uppercase tracking-widest text-nerv-text/70">
        <Link href="/" className="px-2 py-2 -my-2 hover:text-nerv-amber focus:text-nerv-amber">
          ← all
        </Link>
        {USERS.map((u) => (
          <Link
            key={u.slug}
            href={`/${u.slug}`}
            aria-current={u.slug === slug ? "page" : undefined}
            className={
              "px-2 py-2 -my-2 " +
              (u.slug === slug
                ? "text-nerv-amber border-b border-nerv-amber/60"
                : "hover:text-nerv-amber focus:text-nerv-amber")
            }
          >
            {u.displayName}
          </Link>
        ))}
        <span className="ml-auto">
          <ThemeToggle />
        </span>
      </nav>

      {error ? (
        <div className="text-nerv-warn p-4 mb-6 text-sm">
          <div className="uppercase tracking-widest mb-2">SYS:FAULT</div>
          <code className="font-mono text-xs whitespace-pre-wrap">{error}</code>
          <div className="mt-3 text-xs text-nerv-text/80">
            Check <code className="text-nerv-amber">GITHUB_TOKEN</code> in{" "}
            <code className="text-nerv-amber">apps/web/.env.local</code>, and the user
            roster in <code className="text-nerv-amber">apps/web/src/config/users.json</code>.
          </div>
        </div>
      ) : (
        snapshot && (
          <>
            <header className="mb-6 sm:mb-8">
              <h1 className="text-nerv-amber text-2xl sm:text-3xl lowercase font-mono tracking-tight">
                did {displayName} ship today?
              </h1>
              <h2
                className={
                  "mt-1 text-6xl sm:text-7xl font-mono leading-none tabular-nums " +
                  (shipped ? "text-nerv-amber" : "text-nerv-orange")
                }
              >
                {shipped ? "yes." : "no."}
              </h2>

              <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm sm:text-base font-mono lowercase">
                <span className="text-nerv-text/90">
                  <span className="text-nerv-amber text-xl sm:text-2xl tabular-nums">
                    {combinedCurrent}
                  </span>
                  <span className="text-nerv-text/70"> day streak</span>
                </span>

                {oneliner && (
                  <span className="text-nerv-text/90 basis-full sm:basis-auto sm:flex-1 sm:min-w-0">
                    <span className="text-nerv-orange/80 mr-2">&gt;</span>
                    {oneliner}
                  </span>
                )}
              </div>
            </header>

            <div className={xOffline ? "grid gap-4" : "grid gap-4 sm:grid-cols-2"}>
              <MagiPanel
                label="GITHUB"
                unit="commits"
                data={snapshot.channels.github}
              />
              {!xOffline && (
                <MagiPanel
                  label="X"
                  unit="tweets"
                  data={snapshot.channels.twitter}
                />
              )}
            </div>

            {xOffline && (
              <p className="mt-3 text-[10px] uppercase tracking-widest text-nerv-text/60">
                x panel hidden for {displayName} — refresh action needs to run for{" "}
                <code className="text-nerv-text/80">
                  apps/web/src/data/x-days.{slug}.json
                </code>
              </p>
            )}

            <footer className="mt-8 text-[10px] uppercase tracking-widest text-nerv-text/60">
              {snapshot.generated_at.slice(0, 10)} ·{" "}
              {snapshot.generated_at.slice(11, 16)}Z
            </footer>
          </>
        )
      )}
    </main>
  );
}
