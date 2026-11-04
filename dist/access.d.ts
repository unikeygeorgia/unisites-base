/**
 * Access rules (unisites ADR 0030): what a signed-in person, or nobody, may
 * do with each table, the way PocketBase's API rules and Postgres' RLS say
 * it. data.ts applies them to every query it runs for a person.
 *
 * Per table, five rules: list, view, create, update, delete, plus
 * updateCheck (what a row may become; the update rule when it is missing,
 * as Postgres uses USING when WITH CHECK is left out). A missing or null
 * rule refuses everyone; "" lets everyone in, signed in or not.
 *
 * A rule is a small language, never SQL:
 *
 *   author = auth.id
 *   auth.role = 'admin' || (published = true && tenant = auth.tenant)
 *   exists(memberships, tenant_id = row.tenant_id && user_id = auth.id)
 *   status in ['draft', 'sent']
 *
 * A bare name is a column of the row (inside exists(), of that table; there
 * `row.<column>` is the outer row, and in an exists() inside another,
 * `up.<column>` is the row of the one around it). `auth.<field>` is the
 * session's field, null when signed out. `now()` is the time, as ISO text
 * (2026-11-04T12:00:00.000Z), the way imported timestamps are kept. Every value goes to SQL as a parameter, never as
 * text, and every name is checked before it is quoted.
 */
export type Rule = string | null;
export type TableAccess = {
    list?: Rule;
    view?: Rule;
    create?: Rule;
    update?: Rule;
    /** What the row may become; the update rule when missing. */
    updateCheck?: Rule;
    delete?: Rule;
    /** Never read, filtered, ordered by or written through a person's data. */
    hidden?: string[];
    /** Read, but never written by a person. */
    readonly?: string[];
    /** Columns set on create from the session (`{ "owner_id": "auth.id" }`), and readonly after. */
    fill?: Record<string, string>;
};
export type Access = {
    tables: Record<string, TableAccess>;
};
export type Operation = "list" | "view" | "create" | "update" | "updateCheck" | "delete";
export declare const OPERATIONS: Operation[];
export declare function isName(name: string): boolean;
export declare function quote(name: string): string;
export declare class AccessError extends Error {
    readonly code: "bad_name" | "bad_rule" | "forbidden" | "refused" | "unknown_table" | "unknown_column" | "hidden_column" | "readonly_column" | "filter_required" | "too_many" | "bad_value" | "conflict";
    constructor(code: "bad_name" | "bad_rule" | "forbidden" | "refused" | "unknown_table" | "unknown_column" | "hidden_column" | "readonly_column" | "filter_required" | "too_many" | "bad_value" | "conflict", message: string);
}
export type Value = string | number | boolean | null;
export type Node = {
    k: "lit";
    v: Value;
} | {
    k: "name";
    path: string[];
} | {
    k: "cmp";
    op: "=" | "!=" | "<" | "<=" | ">" | ">=";
    l: Node;
    r: Node;
} | {
    k: "in";
    l: Node;
    items: Node[];
} | {
    k: "and" | "or";
    items: Node[];
} | {
    k: "not";
    x: Node;
} | {
    k: "exists";
    table: string;
    where: Node;
} | {
    k: "now";
};
/** Parses a rule; "" is everyone, and is the literal true. */
export declare function parseRule(src: string): Node;
export type Sql = {
    sql: string;
    params: unknown[];
};
/** Where a column of the rule's own row comes from: the table, or a value about to be written. */
export type RowSource = (column: string) => Sql;
export type Compile = {
    auth: Record<string, unknown> | null;
    row: RowSource;
    /** Columns that exist, per table (for exists()); a missing table is unknown. */
    columns?: (table: string) => Set<string> | undefined;
};
export declare function bind(value: unknown): unknown;
export declare function compileRule(node: Node, c: Compile): Sql;
/** Names a rule reads: its own columns, the session's fields and the tables in exists(). */
export declare function namesIn(node: Node): {
    columns: Set<string>;
    auth: Set<string>;
    tables: Set<string>;
};
export type Finding = {
    level: "error" | "warning";
    table: string;
    message: string;
};
/** Column names that hold secrets or personal data (splinter 0023). */
export declare const SENSITIVE: string[];
/** Session fields a person changes themself: never a reason to let them in (splinter 0015). */
export declare const SELF_EDITED: string[];
/**
 * Problems in a project's rules, before anything runs: a rule that does not
 * parse, base's own tables opened, writes anyone may make, secrets left
 * readable, a rule trusting what a person writes about themself, and, with
 * the schema, names that do not exist.
 */
export declare function checkAccess(access: Access, schema?: Map<string, Set<string>>): Finding[];
