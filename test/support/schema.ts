import { DatabaseSync } from "node:sqlite";

import { getMigrations } from "better-auth/db/migration";

import { baseOptions } from "../../src/base.ts";

/** Every option that adds a table or a column is on, so the migration has them all. */
export function fullOptions(database: DatabaseSync) {
  return baseOptions({
    app: "Test",
    baseURL: "https://example.test",
    database,
    google: { clientId: "id", clientSecret: "secret" },
    mail: async () => {},
    secret: "s".repeat(40),
    sms: async () => {},
  });
}

export async function baseSql(): Promise<string> {
  const { compileMigrations } = await getMigrations(fullOptions(new DatabaseSync(":memory:")));
  const statements = (await compileMigrations())
    .split(/;\s*\n/)
    .map((s) => s.trim().replace(/;$/, ""))
    .filter(Boolean);
  return [
    "-- unisites-base: the project's sign-in tables (unisites ADR 0021, 0022), as better-auth",
    "-- makes them for SQLite. Written by `npm run migrations`; do not edit by hand.",
    ...statements.map((s) => `${s};`),
    "",
  ].join("\n");
}
