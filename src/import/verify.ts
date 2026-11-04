import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { checkAccess, type Access } from "../access.ts";
import type { Item } from "./report.ts";

/**
 * The drafts tried before anyone reads them: base's migrations and the draft schema on an empty
 * SQLite (as D1 runs them), then `check` of the draft access.json against what they made.
 * Node only: the CLI and the tests use it.
 */
export function verifyDrafts(schema: string, access: Access): Item[] {
  const items: Item[] = [];
  const db = new DatabaseSync(":memory:");
  const base = new URL("../../migrations/", import.meta.url);
  for (const f of readdirSync(base).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, base), "utf8"));
  try {
    db.exec(schema);
    items.push({ area: "checks", name: "schema.sql", level: "auto", note: "runs on SQLite after base's migrations, as D1 will run it" });
  } catch (e) {
    items.push({ area: "checks", name: "schema.sql", level: "manual", note: `SQLite refuses it: ${(e as Error).message}` });
    return items;
  }
  const tables = new Map<string, Set<string>>();
  for (const { name } of db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]) {
    tables.set(name, new Set((db.prepare(`pragma table_info("${name.replaceAll('"', '""')}")`).all() as { name: string }[]).map((c) => c.name)));
  }
  const found = checkAccess(access, tables);
  for (const f of found) items.push({ area: "checks", name: `access.json ${f.table}`, level: f.level === "error" ? "manual" : "partial", note: f.message });
  if (!found.length) items.push({ area: "checks", name: "access.json", level: "auto", note: "check finds nothing" });
  return items;
}
