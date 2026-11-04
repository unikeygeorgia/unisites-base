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
    /** Each column's declared type, as the migration wrote it. */
    types: Map<string, string>;
    /** Each column's default, as SQL from the schema (PRAGMA table_info's dflt_value). */
    defaults: Map<string, string | null>;
    /** Foreign keys of one column; `to` null is the other table's key. */
    foreignKeys: {
        from: string;
        table: string;
        to: string | null;
    }[];
};
/** A table as a person may see it: its columns (without hidden ones), key and foreign keys. */
export type Described = {
    columns: {
        name: string;
        type: string;
        affinity: string;
    }[];
    key: string[];
    foreignKeys: {
        from: string;
        table: string;
        to: string;
    }[];
};
export type Upsert = {
    /** The columns of the UNIQUE index or key the rows may collide on; the table's key when missing. */
    onConflict?: string[];
    /** Leave a colliding row as it is (ON CONFLICT DO NOTHING), instead of changing it. */
    ignoreDuplicates?: boolean;
    returning?: boolean;
};
export type Data = {
    list(table: string, query?: Query): Promise<Row[]>;
    /** How many rows list() would find, without limit. */
    count(table: string, where?: Filter[]): Promise<number>;
    get(table: string, key: unknown, columns?: string[]): Promise<Row | null>;
    create(table: string, rows: Row | Row[], options?: {
        returning?: boolean;
    }): Promise<{
        count: number;
        rows?: Row[];
    }>;
    /** `one`: change at most one row, or none (supabase-js's single() on a change, as PostgREST does). */
    update(table: string, where: Filter[], patch: Row, options?: {
        returning?: boolean;
        one?: boolean;
    }): Promise<{
        count: number;
        rows?: Row[];
    }>;
    delete(table: string, where: Filter[], options?: {
        returning?: boolean;
        one?: boolean;
    }): Promise<{
        count: number;
        rows?: Row[];
    }>;
    /**
     * create(), and a row that collides with one already there changes it instead: create's rule on
     * every new row, and update's (with list and updateCheck) on each row it changes, as Postgres
     * does for INSERT ... ON CONFLICT DO UPDATE. A refused row writes nothing.
     */
    upsert(table: string, rows: Row | Row[], options?: Upsert): Promise<{
        count: number;
        rows?: Row[];
    }>;
    describe(table: string): Promise<Described>;
};
export declare function createData(config: DataConfig): {
    /** The data as this person may see it; null is signed out. */
    as: (auth: Auth | null) => Data;
    /** Everything, without rules: the project's own server code only. */
    admin: () => Data;
    /** Most rows one list returns. */
    maxRows: number;
};
export { AccessError, checkAccess, parseRule, type Access, type TableAccess } from "./access.ts";
