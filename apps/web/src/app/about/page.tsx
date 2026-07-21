import Link from "next/link";
import { ThemeToggle } from "@/lib/nerv/ThemeToggle";

export default function AboutPage() {
  return (
    <main className="min-h-screen px-4 py-8 pb-12 sm:px-6 sm:py-12 max-w-2xl mx-auto">
      <nav className="mb-8 flex items-center gap-3 text-[10px] uppercase tracking-widest text-nerv-text/70">
        <Link href="/" className="px-2 py-2 -my-2 hover:text-nerv-amber focus:text-nerv-amber">
          ← all
        </Link>
        <span className="ml-auto">
          <ThemeToggle />
        </span>
      </nav>

      <h1 className="text-nerv-amber text-2xl sm:text-3xl lowercase font-mono tracking-tight">
        about
      </h1>

      <div className="mt-6 space-y-4 text-sm sm:text-base leading-7 text-nerv-text/85">
        <p>
          A small leaderboard built to see if people are shipping (posting to X
          and comitting on github).
        </p>
        <p>
          <Link href="/join" className="text-nerv-amber underline underline-offset-2">
            add yourself
          </Link>{" "}
          or{" "}
          <a href="mailto:anishthite@gmail.com" className="text-nerv-amber underline underline-offset-2">
            email anishthite@gmail.com
          </a>{" "}
          with questions
        </p>
      </div>
    </main>
  );
}
