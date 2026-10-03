// Writes migrations/base_0001.sql: the tables better-auth wants for base's
// options, as its getMigrations makes them for SQLite, from an empty
// database. Run after raising better-auth; test/schema.test.ts fails until
// the file matches.
import { writeFileSync } from "node:fs";

import { baseSql } from "../test/support/schema.ts";

const sql = await baseSql();
writeFileSync(new URL("../migrations/base_0001.sql", import.meta.url), sql);
console.log(`migrations/base_0001.sql: ${sql.split("create table").length - 1} tables`);
