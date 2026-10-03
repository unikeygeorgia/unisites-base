import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { baseSql } from "./support/schema.ts";

describe("the migration", () => {
  it("is what better-auth wants for base's options (run `npm run migrations` after raising it)", async () => {
    expect(readFileSync(new URL("../migrations/base_0001.sql", import.meta.url), "utf8")).toBe(await baseSql());
  });

  it("names every table _base_*", () => {
    const sql = readFileSync(new URL("../migrations/base_0001.sql", import.meta.url), "utf8");
    const tables = [...sql.matchAll(/create table "([^"]+)"/g)].map((m) => m[1]);
    expect(tables.sort()).toEqual([
      "_base_account",
      "_base_rate_limit",
      "_base_session",
      "_base_sign_in",
      "_base_two_factor",
      "_base_user",
      "_base_verification",
    ]);
  });
});
