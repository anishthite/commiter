import Link from "next/link";
import { ThemeToggle } from "@/lib/nerv/ThemeToggle";
import { JoinIssueForm } from "./JoinIssueForm";

export default function JoinPage() {
  return (
    <main className="min-h-screen px-4 py-6 sm:px-6 sm:py-12 max-w-xl mx-auto">
      <nav className="mb-6 flex items-center gap-2 text-[10px] uppercase tracking-widest text-nerv-text/70">
        <Link href="/" className="px-2 py-2 -my-2 hover:text-nerv-amber focus:text-nerv-amber">
          ← all
        </Link>
        <span className="ml-auto">
          <ThemeToggle />
        </span>
      </nav>

      <header className="mb-6">
        <h1 className="text-nerv-amber text-2xl sm:text-3xl lowercase font-mono tracking-tight">
          add yourself
        </h1>
        <p className="mt-2 text-sm text-nerv-text/70 lowercase">
          add yourself to the shipping leaderboard
        </p>
      </header>

      <JoinIssueForm />
    </main>
  );
}
