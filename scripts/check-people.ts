#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const usersPath = "apps/web/src/config/users.json";
const xPath = "apps/web/src/data/x-days-by-slug.json";
const issueTemplatePath = ".github/ISSUE_TEMPLATE/add-person.yml";

const users = JSON.parse(readFileSync(usersPath, "utf8")) as {
  users: Array<{ slug: string; displayName: string; githubLogin: string; xLogin: string }>;
};
const xDays = JSON.parse(readFileSync(xPath, "utf8")) as Record<string, { days?: unknown }>;
const issueTemplate = readFileSync(issueTemplatePath, "utf8");

assert.ok(Array.isArray(users.users));
assert.ok(users.users.length > 0);

const slugs = new Set<string>();
const gh = new Set<string>();
const x = new Set<string>();
for (const u of users.users) {
  assert.match(u.slug, /^[a-z0-9-]+$/);
  assert.ok(u.displayName.trim());
  assert.ok(u.githubLogin.trim());
  assert.ok(u.xLogin.trim());
  assert.equal(slugs.has(u.slug), false, `duplicate slug ${u.slug}`);
  assert.equal(gh.has(u.githubLogin.toLowerCase()), false, `duplicate github ${u.githubLogin}`);
  assert.equal(x.has(u.xLogin.toLowerCase()), false, `duplicate x ${u.xLogin}`);
  slugs.add(u.slug);
  gh.add(u.githubLogin.toLowerCase());
  x.add(u.xLogin.toLowerCase());

  // Existing tracked people should still have data after the one-file migration.
  assert.ok(xDays[u.slug], `missing x-days data for ${u.slug}`);
  assert.ok(Array.isArray(xDays[u.slug]?.days), `invalid x-days days[] for ${u.slug}`);
}

for (const field of ["display_name", "github_login", "x_login", "context"]) {
  assert.match(issueTemplate, new RegExp(`id: ${field}`));
}
assert.doesNotMatch(issueTemplate, /id: request_for/);
assert.doesNotMatch(issueTemplate, /type: checkboxes/);
assert.match(issueTemplate, /prefilled from `\/join`/);
assert.match(issueTemplate, /apps\/web\/src\/config\/users\.json/);

console.log("people issue-flow check ok");
