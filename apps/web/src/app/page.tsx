import { getSnapshot } from "@/lib/snapshot";
import { getOneLiner } from "@/lib/oneliner";
import { MagiPanel } from "@/lib/nerv/MagiPanel";

// Snapshot is fetched on the server with each underlying source cached
// 1h at the Next.js fetch layer (D-004). Page-level revalidate aligns
// the SSR render frequency with the data freshness window.
export const revalidate = 3600;

export default async function Page() {
  let snapshot;
  let oneliner = "";
  let error: string | null = null;
  try {
    snapshot = await getSnapshot(365);
    oneliner = await getOneLiner(snapshot);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // "did we ship today?" semantics:
  //   • Both channels live  → YES iff BOTH shipped (preserves AND streak)
  //   • Twitter offline    → YES iff GitHub shipped (don't punish the
  //                            user for a missing data source they didn't
  //                            choose to wire up)
  const ghToday = snapshot?.channels.github.today_count ?? 0;
  const xToday = snapshot?.channels.twitter.today_count ?? 0;
  const xOffline = snapshot?.channels.twitter.offline === true;
  const shipped = xOffline ? ghToday > 0 : ghToday > 0 && xToday > 0;

  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 sm:py-12 max-w-6xl mx-auto">
      {error ? (
        <div className="border border-nerv-warn text-nerv-warn p-4 mb-6 text-sm">
          <div className="uppercase tracking-widest mb-2">SYS:FAULT</div>
          <code className="font-mono text-xs whitespace-pre-wrap">{error}</code>
          <div className="mt-3 text-xs text-nerv-text/60">
            Check <code className="text-nerv-amber">GITHUB_TOKEN</code>,{" "}
            <code className="text-nerv-amber">GITHUB_LOGIN</code>, and{" "}
            <code className="text-nerv-amber">X_LOGIN</code> in{" "}
            <code className="text-nerv-amber">apps/web/.env.local</code>.
          </div>
        </div>
      ) : (
        snapshot && (
          <>
            <header className="mb-8 sm:mb-10">
              <h1 className="text-nerv-text/60 text-base sm:text-lg lowercase">
                did we ship today?
              </h1>
              <div
                className={
                  "mt-2 text-6xl sm:text-7xl font-mono leading-none tabular-nums " +
                  (shipped ? "text-nerv-amber" : "text-nerv-orange")
                }
              >
                {shipped ? "yes." : "no."}
              </div>
              {oneliner && (
                <p className="mt-3 text-sm sm:text-base text-nerv-text/70 lowercase font-mono">
                  <span className="text-nerv-orange/60 mr-2">&gt;</span>
                  {oneliner}
                </p>
              )}
              <div className="mt-3 text-[11px] sm:text-xs uppercase tracking-widest text-nerv-text/50 flex gap-4 flex-wrap">
                <span>
                  github{" "}
                  <span
                    className={
                      ghToday > 0 ? "text-nerv-amber" : "text-nerv-text/40"
                    }
                  >
                    {ghToday > 0 ? `+${ghToday} commits` : "idle"}
                  </span>
                </span>
                {!xOffline && (
                  <>
                    <span aria-hidden>·</span>
                    <span>
                      x{" "}
                      <span
                        className={
                          xToday > 0 ? "text-nerv-amber" : "text-nerv-text/40"
                        }
                      >
                        {xToday > 0 ? `+${xToday} tweets` : "idle"}
                      </span>
                    </span>
                  </>
                )}
              </div>
            </header>

            <div
              className={
                xOffline
                  ? "grid gap-4"
                  : "grid gap-4 sm:grid-cols-2"
              }
            >
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
              <p className="mt-3 text-[10px] uppercase tracking-widest text-nerv-text/30">
                x panel hidden — set <code className="text-nerv-text/50">X_LOGIN</code> and run the{" "}
                <code className="text-nerv-text/50">refresh-x-days</code> action (needs{" "}
                <code className="text-nerv-text/50">SOCIALDATA_API_KEY</code> in GH Secrets); data file is bundled at{" "}
                <code className="text-nerv-text/50">apps/web/src/data/x-days.json</code>
              </p>
            )}

            <footer className="mt-8 text-[10px] uppercase tracking-widest text-nerv-text/30">
              {snapshot.generated_at.slice(0, 10)} ·{" "}
              {snapshot.generated_at.slice(11, 16)}Z
            </footer>
          </>
        )
      )}
    </main>
  );
}
