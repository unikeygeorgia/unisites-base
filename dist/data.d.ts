import { type Access } from "./access.ts";
/**
 * A project's data, for a person (unisites ADR 0030): every read and write
 * goes through the table's access rules (access.ts), in one SQL statement,
 * so nothing is read, written or counted that the rules do not allow.
 *
 *   const data = createData({ exec: d1(env.DB), access });
 *   const db = data.as({ id: user.id, role: user.role });   // null: signed out
 *   await db.list("orders", { where: [{ column: "status", op: "eq", value: "paid" }] });
 *
 * data.admin() is the same without rules, as Supabase's service role is:
 * for the project's own server code only, and `unisites-base check` shows
 * every place that uses it.
 *
 * What the rules add to each statement, as Postgres RLS does
 * (src/test/regress/sql/rowsecurity.sql):
 * - list: SELECT.
 * - view: get() of one row by its key.
 * - create: the new rows, all of them or none (a refused row writes nothing).
 * - update: the old row (update), the new one (updateCheck), and list on
 *   the old row, since a filter could otherwise learn of rows one cannot see.
 * - delete: delete and list on the row.
 * - returning: list on what comes back.
 * Update and delete need a filter, as Supabase's safeupdate asks.
 */
export type Row = Record<string, unknown>;
/** Runs one statement: D1, a Durable Object's SQLite, or node:sqlite in tests. */
export type Exec = (sql: string, params: unknown[]) => Promise<Row[]>;
export declare const d1: (db: D1Database) => Exec;
/** A Durable Object's `ctx.storage.sql`. */
export declare const sqlStorage: (storage: SqlStorage) => Exec;
export type Auth = Record<string, unknown> & {
    id: unknown;
};
export type Op = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "is" | "like" | "ilike";
export type Filter = {
    column: string;
    op: Op;
    value: unknown;
} | {
    or: Filter[];
} | {
    and: Filter[];
} | {
    not: Filter;
};
export type Order = {
    column: string;
    ascending?: boolean;
    nulls?: "first" | "last";
};
export type Query = {
    columns?: string[];
    where?: Filter[];
    order?: Order[];
    limit?: number;
    offset?: number;
};
export type DataConfig = {
    exec: Exec;
    access: Access;
    /** Most rows one list returns (and one create takes). */
    maxRows?: number;
};
export type Table = {
    columns: string[];
    key: string[];
    /** SQLite's affinity of each column, from its declared type. */
    affinity: Map<string, "integer" | "text" | "blob" | "real" | "numeric">;
};
export type Data = {
    list(table: string, query?: Query): Promise<Row[]>;
    get(table: string, key: unknown, columns?: string[]): Promise<Row | null>;
    create(table: string, rows: Row | Row[], options?: {
        returning?: boolean;
    }): Promise<{
        count: number;
        rows?: Row[];
    }>;
    update(table: string, where: Filter[], patch: Row, options?: {
        returning?: boolean;
    }): Promise<{
        count: number;
        rows?: Row[];
    }>;
    delete(table: string, where: Filter[], options?: {
        returning?: boolean;
    }): Promise<{
        count: number;
        rows?: Row[];
    }>;
};
export declare function createData(config: DataConfig): {
    /** The data as this person may see it; null is signed out. */
    as: (auth: Auth | null) => Data;
    /** Everything, without rules: the project's own server code only. */
    admin: () => Data;
};
export { AccessError, checkAccess, parseRule, type Access, type TableAccess } from "./access.ts";
