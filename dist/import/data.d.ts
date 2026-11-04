import type { Catalog } from "./catalog.ts";
/**
 * A Supabase project's rows, and its people, as SQL for the drafts' schema (unisites ADR 0030,
 * step 5): files that `wrangler d1 execute --file` (or a Durable Object) applies to a database
 * made from base's migrations and schema.sql, in that order.
 *
 * Every value is read as text by Postgres itself, so nothing is lost on the way: a bigint or a
 * numeric keeps its digits, a timestamp is ISO in UTC with milliseconds (as now() writes it in a
 * rule), a boolean is 1 or 0, jsonb and arrays are JSON, bytea is a blob. People go into
 * _base_user with their own ids (so auth.uid() in old rows is still auth.id), their bcrypt
 * passwords into _base_account, which base signs in and writes again as scrypt.
 *
 * The files hold personal data and password hashes: they are written beside a .gitignore, and are
 * for one database, then deleted.
 */
/** One SELECT, read: Supabase's Management API, or PGlite in the tests. */
export type Query = (sql: string) => Promise<Record<string, unknown>[]>;
export type DataFile = {
    name: string;
    sql: string;
    rows: number;
};
export type Exported = {
    files: DataFile[];
    counts: Record<string, number>;
    notes: string[];
};
export type ExportOptions = {
    /** Rows read at once. */
    pageRows?: number;
    /** Rows in one file, so no file is too big to send. */
    fileRows?: number;
    /** Only these tables (people are always moved). */
    tables?: string[];
    /**
     * Links to the old project's files, rewritten in every text value: Supabase's
     * https://<ref>.supabase.co/storage/v1/ becomes the new address's /storage/v1/.
     */
    rewrite?: {
        from: string;
        to: string;
    };
};
export declare function exportData(catalog: Catalog, query: Query, options?: ExportOptions): Promise<Exported>;
/** How many rows each table has in Postgres, to compare after the import. */
export declare function countRows(catalog: Catalog, query: Query): Promise<Record<string, number>>;
