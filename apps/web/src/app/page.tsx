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

  const ghToday = snapshot?.channels.github.today_count ?? 0;
  const xToday = snapshot?.channels.twitter.today_count ?? 0;
  const xOffline = snapshot?.channels.twitter.offline === true;
  const shipped = xOffline ? ghToday > 0 : ghToday > 0 && xToday > 0;

  const combinedCurrent = snapshot?.combined.streak_current ?? 0;

  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 sm:py-12 max-w-6xl mx-auto">
      {error ? (
        <div className="text-nerv-warn p-4 mb-6 text-sm">
          <div className="uppercase tracking-widest mb-2">SYS:FAULT</div>
          <code className="font-mono text-xs whitespace-pre-wrap">{error}</code>
          <div className="mt-3 text-xs text-nerv-text/80">
            Check <code className="text-nerv-amber">GITHUB_TOKEN</code>,{" "}
            <code className="text-nerv-amber">GITHUB_LOGIN</code>, and{" "}
            <code className="text-nerv-amber">X_LOGIN</code> in{" "}
            <code className="text-nerv-amber">apps/web/.env.local</code>.
          </div>
        </div>
      ) : (
        snapshot && (
          <>
            <header className="mb-6 sm:mb-8">
              <h1 className="text-nerv-amber text-2xl sm:text-3xl lowercase font-mono tracking-tight">
                did anish ship today?
              </h1>
              <h2
                className={
                  "mt-1 text-6xl sm:text-7xl font-mono leading-none tabular-nums " +
                  (shipped ? "text-nerv-amber" : "text-nerv-orange")
                }
              >
                {shipped ? "yes." : "no."}
              </h2>

              {/* Single-line status: combined streak + LLM oneliner.
                  The per-channel today counts already live inside the
                  GitHub/X panels below, so we don't repeat them here. */}
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

            <div
              className={
                xOffline
                  ? "grid gap-4"
                  : "grid gap-4 grid-cols-2"
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
              <p className="mt-3 text-[10px] uppercase tracking-widest text-nerv-text/60">
                x panel hidden — set <code className="text-nerv-text/80">X_LOGIN</code> and run the{" "}
                <code className="text-nerv-text/80">refresh-x-days</code> action (needs{" "}
                <code className="text-nerv-text/80">SOCIALDATA_API_KEY</code> in GH Secrets); data file is bundled at{" "}
                <code className="text-nerv-text/80">apps/web/src/data/x-days.json</code>
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
