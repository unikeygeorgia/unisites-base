import type { Auth, Data, Described, Filter, Row, createData } from "./data.ts";
/**
 * `/rest/v1/<table>` as PostgREST answers it, so that supabase-js's `from()` works unchanged on a
 * project's own D1 or Durable Object (unisites ADR 0030, step 2). Every request goes through
 * data.as(person), so the access rules decide what it reads and writes.
 *
 *   const rest = createRest({ data, auth: async (request) => (await session(request))?.user ?? null });
 *   if (url.pathname.startsWith("/rest/v1/")) return rest.handler(request);
 *
 *   const supabase = createClient(location.origin, "unisites");   // the key is not used
 *
 * What it takes (the forms Unichat's code uses; anything else is a 400, never a guess):
 * - select: columns, `*`, `alias:column`, and embeds `table(...)`, `alias:table(...)`,
 *   `table!fk_column(...)`, through a foreign key of one column, either way, nested.
 * - filters: eq neq gt gte lt lte like ilike in is, `not.`, `or=(...)`, `and=(...)`, nested.
 * - order (`nullsfirst`, `nullslast`), limit, offset, Range.
 * - Prefer: return=minimal|representation, count=exact (planned and estimated count exactly),
 *   resolution=merge-duplicates|ignore-duplicates, missing=default.
 * - Accept: application/vnd.pgrst.object+json (single(); maybeSingle() is supabase-js's).
 * - POST (insert, upsert with on_conflict), PATCH, DELETE, HEAD, and /rpc/<name> for the
 *   functions the project gives (`rpc`).
 *
 * Where it is not Postgres: values are SQLite's, so a column declared BOOLEAN (or BOOL) comes back
 * true or false, and one whose type names JSON (`JSON TEXT`) comes back parsed; a key a row leaves
 * out takes the column's default (PostgREST's missing=default) even without asking.
 */
export type RpcFunction = (args: Row, context: {
    db: Data;
    auth: Auth | null;
    request: Request;
}) => Promise<unknown>;
/**
 * A function answers POST; GET too only with `get: true`, for one that changes nothing (PostgREST's
 * STABLE), since a GET can come from another site's <img> with the person's cookie.
 */
export type Rpc = RpcFunction | {
    handler: RpcFunction;
    get?: boolean;
};
export type RestConfig = {
    data: ReturnType<typeof createData>;
    /** The person a request is from, or null; from the session cookie, or /auth/v1's token (gotrue.person). */
    auth: (request: Request) => Promise<Auth | null>;
    /**
     * Whether a request is the project's own server code, which reads and writes without rules as
     * Supabase's service role does (gotrue.isService: the service key). Never from a browser.
     */
    admin?: (request: Request) => boolean | Promise<boolean>;
    /** Where the API is; `/rest/v1/` as Supabase has it. */
    prefix?: string;
    /** The project's own functions, for supabase.rpc(name, args). */
    rpc?: Record<string, Rpc>;
    /** Other origins that may write with the person's cookie (an app's own WebView); none by default. */
    origins?: string[];
};
type Item = {
    k: "star";
} | {
    k: "column";
    name: string;
    alias?: string;
} | {
    k: "embed";
    table: string;
    alias?: string;
    hint?: string;
    items: Item[];
};
export declare function parseSelect(s: string, depth?: number): Item[];
/** `[not.]op.value` for one column. */
export declare function parseCondition(desc: Described, column: string, expr: string): Filter;
export declare function createRest(config: RestConfig): {
    handler: (request: Request) => Promise<Response>;
};
/** A value as Postgres would answer it: BOOLEAN as true or false, JSON parsed. */
export declare function valueOf(desc: Described): (column: string, v: unknown) => unknown;
export {};
