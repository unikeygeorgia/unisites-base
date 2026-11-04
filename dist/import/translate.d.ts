import type { Column, PgFunction, Policy, Table } from "./catalog.ts";
import { type E, Unsupported, parseExpr } from "./pg.ts";
export type RuleContext = {
    tables: Map<string, Table>;
    /** The public schema's policies. */
    policies: Policy[];
    functions: PgFunction[];
    /** Function names inlined, for the report. */
    inlined?: Set<string>;
    /** What came out narrower than Postgres (never wider), for the report. */
    narrower?: Set<string>;
};
declare const COMMANDS: {
    readonly list: readonly ["SELECT", "ALL"];
    readonly create: readonly ["INSERT", "ALL"];
    readonly update: readonly ["UPDATE", "ALL"];
    readonly delete: readonly ["DELETE", "ALL"];
};
type Op = keyof typeof COMMANDS;
/**
 * A table's rule for one command, from its policies and grants, as access.json writes it: ""
 * lets everyone in, null is closed. fail() hears of each permissive policy left out.
 */
export declare function tableRule(table: string, op: Op, ctx: RuleContext, fail: (what: string) => void, which?: "using" | "check"): string | null;
/** The browser's roles a command's policies and grants let in at all: whose column grants count. */
export declare function admitted(table: Table, op: Op, policies: Policy[]): ("anon" | "authenticated")[];
/** One policy expression on its own, as a rule ("" when it lets everyone in); for tests. */
export declare function policyRule(table: string, sql: string, ctx: RuleContext): string;
/** A random UUID (version 4), as gen_random_uuid() makes one. */
export declare const UUID: string;
/** An expression in SQLite's SQL, over the table's own columns. */
export declare function toSqlite(e: E, columns: string[]): string;
export type Level = "auto" | "partial" | "manual";
export type ColumnPlan = {
    name: string;
    /** The SQLite declaration, without the column's name. */
    declaration: string;
    from: string;
    level: Level;
    notes: string[];
    /** fill: the session's field the column takes (a default of auth.uid()). */
    fill?: string;
    /** The column is the table's INTEGER PRIMARY KEY (identity or serial). */
    rowid?: boolean;
};
export declare function planColumn(c: Column, singleKey: boolean): ColumnPlan;
/** A column's default in SQLite, or the session's field it takes (fill). */
export declare function defaultOf(sql: string, type: string): {
    sql: string | null;
    fill?: string;
    why?: string;
};
export { Unsupported, parseExpr };
