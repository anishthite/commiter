import { getSnapshot } from "@/lib/snapshot-server";
import { MagiPanel } from "@/lib/nerv/MagiPanel";

export const dynamic = "force-dynamic";

export default async function Page() {
  let snapshot;
  let error: string | null = null;
  try {
    snapshot = await getSnapshot(365);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="min-h-screen p-8 max-w-6xl mx-auto">
      <header className="flex items-baseline justify-between mb-8 border-b border-nerv-grid pb-4">
        <h1 className="text-nerv-orange tracking-widest uppercase">
          NERV // Central Dogma
        </h1>
        <div className="text-xs text-nerv-text/60 uppercase tracking-widest">
          Shipping Tracker · v0
        </div>
      </header>

      {error && (
        <div className="border border-nerv-warn text-nerv-warn p-4 mb-6 text-sm">
          <div className="uppercase tracking-widest mb-2">SYS:FAULT</div>
          <code className="font-mono text-xs whitespace-pre-wrap">{error}</code>
          <div className="mt-3 text-xs text-nerv-text/60">
            Did you run <code className="text-nerv-amber">pnpm migrate</code> and{" "}
            <code className="text-nerv-amber">pnpm ingest:github</code>?
          </div>
        </div>
      )}

      {snapshot && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <MagiPanel
              name="MAGI-01"
              subtitle="GitHub"
              data={snapshot.channels.github}
            />
            <MagiPanel
              name="MAGI-02"
              subtitle="X / Twitter"
              data={snapshot.channels.twitter}
            />
          </div>

          <footer className="mt-8 pt-4 border-t border-nerv-grid flex items-baseline justify-between text-xs uppercase tracking-widest text-nerv-text/60">
            <div>SYS:OK</div>
            <div>
              COMBINED STREAK{" "}
              <span className="text-nerv-orange">
                {String(snapshot.combined.streak_current).padStart(3, "0")}
              </span>
              {"  · "}
              MODE {snapshot.combined.mode.toUpperCase()}
            </div>
            <div>{snapshot.generated_at.slice(11, 19)} UTC</div>
          </footer>
        </>
      )}
    </main>
  );
}
