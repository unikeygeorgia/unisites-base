/**
 * Postgres expressions as Postgres prints them back (pg_policies, pg_get_constraintdef,
 * pg_get_expr) and SQL functions' bodies, parsed far enough to translate: comparisons, AND, OR,
 * NOT, IS, IN, ANY(ARRAY[...]), BETWEEN, LIKE, casts (dropped), function calls, EXISTS and
 * subqueries of one table. Anything else throws Unsupported with what it met, so the report says
 * so instead of guessing.
 */
export declare class Unsupported extends Error {
}
export type Select = {
    items: {
        e: E;
        alias?: string;
    }[];
    from?: {
        schema?: string;
        table: string;
        alias?: string;
    };
    where?: E;
};
export type E = {
    k: "lit";
    v: string | number | boolean | null;
} | {
    k: "col";
    path: string[];
} | {
    k: "fn";
    name: string[];
    args: E[];
} | {
    k: "bin";
    op: string;
    l: E;
    r: E;
} | {
    k: "and" | "or";
    items: E[];
} | {
    k: "not";
    x: E;
} | {
    k: "isnull";
    x: E;
    not: boolean;
} | {
    k: "is";
    x: E;
    v: boolean;
    not: boolean;
} | {
    k: "in";
    x: E;
    list: E[];
    not: boolean;
} | {
    k: "insub";
    x: E;
    sub: Select;
    not: boolean;
} | {
    k: "any";
    x: E;
    op: string;
    arr: E;
} | {
    k: "array";
    items: E[];
} | {
    k: "exists";
    sub: Select;
} | {
    k: "sub";
    sub: Select;
} | {
    k: "between";
    x: E;
    lo: E;
    hi: E;
    not: boolean;
} | {
    k: "neg";
    x: E;
} | {
    k: "cast";
    x: E;
    type: string;
} | {
    k: "index";
    x: E;
    i: number;
};
export declare function parseExpr(src: string): E;
/** A SQL function's body: one SELECT. */
export declare function parseSelect(src: string): Select;
/** An index as pg_get_indexdef prints it. */
export declare function parseIndex(src: string): {
    unique: boolean;
    name: string;
    table: string;
    method: string;
    items: string;
    where?: E;
};
