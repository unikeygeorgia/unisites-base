import type { Access } from "../access.ts";
import type { Catalog } from "./catalog.ts";
import { type E } from "./pg.ts";
import { type Level } from "./translate.ts";
/**
 * A Supabase project's catalog (catalog.ts) as a plan for Unisites (unisites ADR 0030, step 4):
 * what moves by itself, what partly, what by hand, with drafts of the schema (SQLite, for D1 or a
 * Durable Object) and of access.json. Nothing here changes anything: the drafts are files to read.
 */
export type Item = {
    area: string;
    name: string;
    level: Level;
    note: string;
};
export type Report = {
    items: Item[];
    /** migrations/0001_from_supabase.sql, a draft. */
    schema: string;
    /** access.json, a draft. */
    access: Access;
    markdown: string;
};
export type CodeUse = {
    what: string;
    level: Level;
    note: string;
    at: string[];
};
export type ReportOptions = {
    project?: string;
    /** What the project's code asks of supabase-js (scanCode). */
    code?: CodeUse[];
    /** vercel.json, when the project has one. */
    vercel?: unknown;
    /** supabase.rpc("name") in the code, and where (rpcCalls). */
    rpc?: Map<string, string[]>;
    /** Tries the drafts (verifyDrafts), for the report's checks. */
    verify?: (schema: string, access: Access) => Item[];
};
export declare function buildReport(catalog: Catalog, options?: ReportOptions): Report;
export type { E };
