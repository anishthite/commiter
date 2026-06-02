import usersJson from "./users.json";

export type UserConfig = {
  slug: string;
  displayName: string;
  githubLogin: string;
  xLogin: string;
};

const data = usersJson as { users: UserConfig[] };

export const USERS: UserConfig[] = data.users;

const BY_SLUG: Record<string, UserConfig> = Object.fromEntries(
  USERS.map((u) => [u.slug, u])
);

export function getUserBySlug(slug: string): UserConfig | undefined {
  return BY_SLUG[slug];
}

export function listUserSlugs(): string[] {
  return USERS.map((u) => u.slug);
}
