"use client";

import { useMemo, useState } from "react";

const ISSUE_BASE = "https://github.com/anishthite/commiter/issues/new";

function cleanHandle(s: string) {
  return s.trim().replace(/^@+/, "");
}

function issueUrl(input: {
  displayName: string;
  githubLogin: string;
  xLogin: string;
  context: string;
}) {
  const displayName = input.displayName.trim();
  const githubLogin = cleanHandle(input.githubLogin);
  const xLogin = cleanHandle(input.xLogin);
  const params = new URLSearchParams({
    template: "add-person.yml",
    labels: "add-person",
    title: `Add person: ${displayName || githubLogin || ""}`,
    display_name: displayName,
    github_login: githubLogin,
    x_login: xLogin,
  });
  if (input.context.trim()) params.set("context", input.context.trim());
  return `${ISSUE_BASE}?${params.toString()}`;
}

export function JoinIssueForm() {
  const [displayName, setDisplayName] = useState("");
  const [githubLogin, setGithubLogin] = useState("");
  const [xLogin, setXLogin] = useState("");
  const [context, setContext] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const href = useMemo(
    () => issueUrl({ displayName, githubLogin, xLogin, context }),
    [displayName, githubLogin, xLogin, context]
  );

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        window.location.assign(href);
      }}
    >
      <label className="grid gap-1 text-xs uppercase tracking-widest text-nerv-text/70">
        display name
        <input
          required
          maxLength={40}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="bg-transparent border border-nerv-text/30 rounded px-3 py-2 text-base text-nerv-text normal-case focus:outline-none focus:border-nerv-amber"
          placeholder="ada"
        />
      </label>

      <label className="grid gap-1 text-xs uppercase tracking-widest text-nerv-text/70">
        github username
        <input
          required
          maxLength={39}
          pattern="@?[A-Za-z0-9](?:[A-Za-z0-9\-]{0,37}[A-Za-z0-9])?"
          value={githubLogin}
          onChange={(e) => setGithubLogin(e.target.value)}
          className="bg-transparent border border-nerv-text/30 rounded px-3 py-2 text-base text-nerv-text normal-case focus:outline-none focus:border-nerv-amber"
          placeholder="octocat"
        />
      </label>

      <label className="grid gap-1 text-xs uppercase tracking-widest text-nerv-text/70">
        x username
        <input
          required
          maxLength={16}
          pattern="@?[A-Za-z0-9_]{1,15}"
          value={xLogin}
          onChange={(e) => setXLogin(e.target.value)}
          className="bg-transparent border border-nerv-text/30 rounded px-3 py-2 text-base text-nerv-text normal-case focus:outline-none focus:border-nerv-amber"
          placeholder="@octocat"
        />
      </label>

      <label className="grid gap-1 text-xs uppercase tracking-widest text-nerv-text/70">
        context <span className="text-nerv-text/40">optional</span>
        <textarea
          rows={3}
          value={context}
          onChange={(e) => setContext(e.target.value)}
          className="bg-transparent border border-nerv-text/30 rounded px-3 py-2 text-base text-nerv-text normal-case focus:outline-none focus:border-nerv-amber"
          placeholder="this is me / they asked to be added / profile link..."
        />
      </label>

      <label className="flex gap-2 text-xs lowercase text-nerv-text/70">
        <input
          required
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 accent-nerv-amber"
        />
        handles are exact and this person is not already on the dashboard.
      </label>

      <button
        type="submit"
        disabled={!confirmed}
        className="mt-2 rounded border border-nerv-amber/70 px-4 py-3 text-left text-nerv-amber lowercase hover:bg-nerv-amber hover:text-nerv-bg focus:outline-none focus:bg-nerv-amber focus:text-nerv-bg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-nerv-amber"
      >
        open prefilled issue →
      </button>
    </form>
  );
}
