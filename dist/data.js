import { AccessError, bind, compileRule, isName, parseRule, quote, } from "./access.js";
export const d1 = (db) => async (sql, params) => (await db.prepare(sql).bind(...params).all()).results;
/** A Durable Object's `ctx.storage.sql`. */
export const sqlStorage = (storage) => async (sql, params) => storage.exec(sql, ...params).toArray();
// SQLite's rules for a declared type (https://www.sqlite.org/datatype3.html, 3.1).
function affinityOf(type) {
    const t = type.toUpperCase();
    if (t.includes("INT"))
        return "integer";
    if (/CHAR|CLOB|TEXT/.test(t))
        return "text";
    if (t.includes("BLOB") || t === "")
        return "blob";
    if (/REAL|FLOA|DOUB/.test(t))
        return "real";
    return "numeric";
}
const MAX_IN = 1000;
/** Values and nested arrays or objects in one contains-filter: each costs parameters (D1 takes 100). */
const MAX_CONTAINS = 12;
/** A key of a JSON object, written into a path in quotes: anything but a quote, a backslash or a control character. */
const JSON_KEY = /^[^"\\\u0000-\u001f]{1,64}$/;
/** A JSON column's containment as SQL, over `base` (the column, or a value inside it). */
function containment(op, base, value, text) {
    let leaves = 0;
    let alias = 0;
    const join = (pieces) => ({
        sql: pieces.map((p) => (typeof p === "string" ? p : p.sql)).join(""),
        params: pieces.flatMap((p) => (typeof p === "string" ? [] : p.params)),
    });
    const param = (v) => ({ sql: "?", params: [v] });
    // One JSON value of the column, by its type and value, against one of ours: as jsonb compares them.
    const count = () => {
        if (++leaves > MAX_CONTAINS)
            throw new AccessError("too_many", `at most ${MAX_CONTAINS} values in one contains`);
    };
    const scalar = (type, val, v) => {
        count();
        if (v === null)
            return join([type, " = 'null'"]);
        // A Postgres array literal's true and false are text: they also meet JSON's.
        if (text && typeof v === "string" && /^(t|true|f|false)$/i.test(v)) {
            return join(["(", type, ` = '${/^t/i.test(v) ? "true" : "false"}' OR (`, type, " = 'text' AND ", val, " = ", param(v), "))"]);
        }
        if (typeof v === "boolean")
            return join([type, ` = '${v}'`]);
        if (typeof v === "number") {
            if (!Number.isFinite(v))
                throw new AccessError("bad_value", "a number that is not finite");
            return join(["(", type, " IN ('integer', 'real') AND ", val, " = ", param(v), ")"]);
        }
        if (typeof v === "string") {
            const exact = join(["(", type, " = 'text' AND ", val, " = ", param(v), ")"]);
            return text ? join(["(", exact, " OR (", type, " IN ('integer', 'real') AND CAST(", val, " AS TEXT) = ", param(v), "))"]) : exact;
        }
        throw new AccessError("bad_value", "contains takes values, arrays and objects");
    };
    const all = (items) => (items.length ? join(["(", ...items.flatMap((x, i) => (i ? [" AND ", x] : [x])), ")"]) : { sql: "1", params: [] });
    const kind = (e) => (Array.isArray(e) ? "array" : "object");
    // A nested value is read only when it is of the kind asked for: json_each() of a string is an error.
    const ofKind = (type, e, inner) => join(["(CASE WHEN ", type, ` = '${kind(e)}' THEN `, inner(), " ELSE 0 END)"]);
    // base at path holds v.
    const holds = (b, path, v, depth) => {
        if (depth > 4)
            throw new AccessError("bad_value", "contains nests too deep");
        count();
        if (Array.isArray(v)) {
            return all(v.map((e) => {
                const j = `"$j${++alias}"`;
                const type = { sql: `${j}.type`, params: [] };
                const val = { sql: `${j}.value`, params: [] };
                const inner = e !== null && typeof e === "object" ? ofKind(type, e, () => holds(val, "$", e, depth + 1)) : scalar(type, val, e);
                return join(["EXISTS (SELECT 1 FROM json_each(", b, ", ", param(path), `) AS ${j} WHERE `, inner, ")"]);
            }));
        }
        if (v !== null && typeof v === "object") {
            return all(Object.entries(v).map(([k, e]) => {
                if (!JSON_KEY.test(k))
                    throw new AccessError("bad_value", "contains takes keys of 1 to 64 characters, without quotes or backslashes");
                const p = `${path}."${k}"`;
                const type = join(["json_type(", b, ", ", param(p), ")"]);
                if (e !== null && typeof e === "object")
                    return ofKind(type, e, () => holds(b, p, e, depth + 1));
                return scalar(type, join(["json_extract(", b, ", ", param(p), ")"]), e);
            }));
        }
        throw new AccessError("bad_value", "contains takes an array or an object");
    };
    // CASE, not AND: SQLite may read either side of an AND first, and json_each() of text that is
    // not JSON is an error.
    // In JSON a missing key is false (json_type() of it is NULL); a column that is not JSON is NULL.
    const guarded = (x) => join(["(CASE WHEN json_valid(", base, ") THEN coalesce(", x, ", 0) ELSE NULL END)"]);
    // As jsonb: an array contains an array, an object an object, never across.
    if (op === "cs")
        return guarded(ofKind(join(["json_type(", base, ")"]), value, () => holds(base, "$", value, 0)));
    if (!Array.isArray(value))
        throw new AccessError("bad_value", `${op} takes an array`);
    const j = `"$j${++alias}"`;
    const type = { sql: `${j}.type`, params: [] };
    const val = { sql: `${j}.value`, params: [] };
    const any = value.length ? join(["(", ...value.flatMap((e, i) => (i ? [" OR ", scalar(type, val, e)] : [scalar(type, val, e)])), ")"]) : { sql: "0", params: [] };
    const each = join(["(SELECT 1 FROM json_each(", base, `) AS ${j} WHERE `]);
    if (op === "ov")
        return guarded(join(["EXISTS ", each, any, ")"]));
    return guarded(join(["(CASE WHEN json_type(", base, ") = 'array' THEN NOT EXISTS ", each, "NOT ", any, ") ELSE NULL END)"]));
}
/** Column filters in one request: each is a parameter, and D1 takes 100 in a statement. */
const MAX_FILTERS = 30;
const among = (names, c) => !!names?.some((n) => n.toLowerCase() === c.toLowerCase());
function leaves(where) {
    let n = 0;
    const walk = (f) => {
        if (f === null || typeof f !== "object")
            return;
        if ("or" in f && Array.isArray(f.or))
            f.or.forEach(walk);
        else if ("and" in f && Array.isArray(f.and))
            f.and.forEach(walk);
        else if ("not" in f)
            walk(f.not);
        else
            n++;
    };
    where.forEach(walk);
    return n;
}
/** A change or delete names at least one column outright, not only in or/not (safeupdate). */
function narrows(where) {
    return Array.isArray(where) && where.some((f) => f !== null && typeof f === "object" && "column" in f);
}
function json(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        throw new AccessError("bad_value", "a value JSON cannot carry");
    }
}
/**
 * A value as the column will store it, before any rule sees it: SQLite turns '-5' into -5 in
 * an INTEGER column, so a rule checking the text would pass what the table then keeps as a
 * number. Text goes only into text columns, numbers and booleans only into numeric ones;
 * a column without a type takes either, and keeps it as it is.
 */
function stored(t, column, value) {
    const affinity = t.affinity.get(column) ?? "blob";
    const numeric = affinity === "integer" || affinity === "real" || affinity === "numeric";
    const wrong = (what) => new AccessError("bad_value", `${column}: ${what} into a ${affinity} column`);
    if (value === undefined || value === null)
        return null;
    switch (typeof value) {
        case "string":
            if (numeric)
                throw wrong("text");
            return value;
        case "number":
            if (!Number.isFinite(value))
                throw wrong("a number that is not finite");
            if (affinity === "text")
                throw wrong("a number");
            return value;
        case "boolean":
            if (affinity === "text")
                throw wrong("true or false");
            return value ? 1 : 0;
        case "object":
            if (numeric)
                throw wrong("an object");
            return json(value);
        default:
            throw wrong(typeof value);
    }
}
export function createData(config) {
    const maxRows = config.maxRows ?? 1000;
    const raw = config.exec;
    // A UNIQUE, foreign key or CHECK failure says only that it failed: its message names the
    // columns, and the row one's value collided with may be someone else's.
    const exec = async (sql, params) => {
        try {
            return await raw(sql, params);
        }
        catch (e) {
            const message = String(e?.message);
            if (/constraint failed|constraint violation|SQLITE_CONSTRAINT/i.test(message)) {
                throw new AccessError("conflict", "the row conflicts with another one, or with the table's own checks");
            }
            // REFUSED below: a rule that failed inside the statement stops all of it.
            if (/malformed JSON/i.test(message))
                throw new AccessError("refused", "a row the rules do not allow");
            // MORE_THAN_ONE below.
            if (/integer overflow/i.test(message))
                throw new AccessError("too_many", "more than one row");
            if (/too many SQL variables/i.test(message))
                throw new AccessError("too_many", "too many values in one request");
            if (/does not match any PRIMARY KEY or UNIQUE/i.test(message))
                throw new AccessError("bad_value", "on conflict names no key or UNIQUE index");
            throw e;
        }
    };
    const tables = new Map();
    const parsed = new Map();
    async function table(name) {
        if (!isName(name))
            throw new AccessError("bad_name", name);
        let t = tables.get(name);
        if (!t) {
            const info = (await exec(`PRAGMA table_info(${quote(name)})`, []));
            if (!info.length)
                throw new AccessError("unknown_table", name);
            const key = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
            const fks = (await exec(`PRAGMA foreign_key_list(${quote(name)})`, []));
            // Only keys of one column: an embed joins on one.
            const single = fks.filter((f) => fks.filter((g) => g.id === f.id).length === 1);
            t = {
                columns: info.map((c) => c.name),
                key: key.length ? key : ["rowid"],
                affinity: new Map(info.map((c) => [c.name, affinityOf(c.type ?? "")])),
                types: new Map(info.map((c) => [c.name, c.type ?? ""])),
                defaults: new Map(info.map((c) => [c.name, c.dflt_value ?? null])),
                foreignKeys: single.map((f) => ({ from: f.from, table: f.table, to: f.to ?? null })),
            };
            tables.set(name, t);
        }
        return t;
    }
    function rule(name, rules, op) {
        const id = `${name}\0${op}`;
        if (!parsed.has(id)) {
            const src = op === "updateCheck" && rules.updateCheck === undefined ? rules.update : rules[op];
            parsed.set(id, src === undefined || src === null ? null : parseRule(src));
        }
        return parsed.get(id);
    }
    function open(auth, admin) {
        function rulesOf(name) {
            if (!isName(name))
                throw new AccessError("bad_name", name);
            if (admin)
                return {};
            const r = Object.hasOwn(config.access.tables ?? {}, name) ? config.access.tables[name] : undefined;
            if (!r)
                throw new AccessError("unknown_table", name);
            return r;
        }
        // Every column one writes in has to exist; a person's may not be hidden, and when
        // written, not readonly.
        function columnsFor(name, t, rules, cols, how) {
            for (const c of cols) {
                // Only the table's own names, as written: never rowid, oid or _rowid_, which reach the
                // key (and hidden columns) under another name.
                if (!isName(c) || !t.columns.includes(c))
                    throw new AccessError("unknown_column", `${name}.${c}`);
                if (admin)
                    continue;
                if (among(rules.hidden, c))
                    throw new AccessError("hidden_column", `${name}.${c}`);
                if (how === "read")
                    continue;
                if (among(rules.readonly, c) || among(Object.keys(rules.fill ?? {}), c)) {
                    throw new AccessError("readonly_column", `${name}.${c}`);
                }
                if (how === "write" && t.key.includes(c))
                    throw new AccessError("readonly_column", `${name}.${c}`);
            }
        }
        function visible(t, rules) {
            return t.columns.filter((c) => admin || !among(rules.hidden, c));
        }
        // A rule as SQL, for rows read from the table, or for rows about to be written.
        async function ruleSql(name, rules, op, row) {
            if (admin)
                return { sql: "1", params: [] };
            const node = rule(name, rules, op);
            if (!node)
                throw new AccessError("forbidden", `${op} on ${name}`);
            await preload(node);
            return compileRule(node, { auth, row, columns: (t) => (tables.get(t) ? new Set(tables.get(t).columns) : undefined) });
        }
        // exists() names other tables; know their columns before compiling.
        async function preload(node) {
            if (node.k === "exists") {
                await table(node.table);
                await preload(node.where);
            }
            else if (node.k === "and" || node.k === "or")
                for (const i of node.items)
                    await preload(i);
            else if (node.k === "not")
                await preload(node.x);
        }
        const fromTable = (name) => (column) => ({ sql: `${quote(name)}.${quote(column)}`, params: [] });
        // ref: where a column's value is; the table's row, or a row given as parameters (sees()).
        function filterSql(name, t, rules, f, depth = 0, ref = fromTable(name)) {
            if (depth > 8)
                throw new AccessError("bad_value", "filters nest too deep");
            if (f === null || typeof f !== "object" || Array.isArray(f))
                throw new AccessError("bad_value", "a filter is an object");
            if ("or" in f || "and" in f) {
                const items = ("or" in f ? f.or : f.and).map((x) => filterSql(name, t, rules, x, depth + 1, ref));
                if (!items.length)
                    return { sql: "or" in f ? "0" : "1", params: [] };
                return { sql: `(${items.map((i) => i.sql).join("or" in f ? " OR " : " AND ")})`, params: items.flatMap((i) => i.params) };
            }
            if ("not" in f) {
                const x = filterSql(name, t, rules, f.not, depth + 1, ref);
                // NOT of NULL is NULL, so a row whose column is NULL is not found, as in Postgres.
                return { sql: `(NOT ${x.sql})`, params: x.params };
            }
            columnsFor(name, t, rules, [f.column], "read");
            const c = ref(f.column);
            const col = c.sql;
            const at = (sql, params = []) => ({ sql, params: [...c.params, ...params] });
            const scalar = (v) => {
                if (v !== null && typeof v === "object")
                    throw new AccessError("bad_value", `${f.column}: a value, not an object`);
                return bind(v);
            };
            switch (f.op) {
                case "eq":
                case "neq":
                case "gt":
                case "gte":
                case "lt":
                case "lte": {
                    const op = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[f.op];
                    return at(`(${col} ${op} ?)`, [scalar(f.value)]);
                }
                case "in": {
                    if (!Array.isArray(f.value))
                        throw new AccessError("bad_value", `${f.column}: in takes a list`);
                    if (f.value.length > MAX_IN)
                        throw new AccessError("too_many", `${f.column}: in takes at most ${MAX_IN}`);
                    if (!f.value.length)
                        return { sql: "0", params: [] };
                    // One parameter for the whole list: D1 takes at most 100 in a statement.
                    return at(`(${col} IN (SELECT value FROM json_each(?)))`, [json(f.value.map(scalar))]);
                }
                case "is": {
                    if (f.value === null)
                        return at(`(${col} IS NULL)`);
                    if (f.value === true || f.value === false)
                        return at(`(${col} IS ?)`, [f.value ? 1 : 0]);
                    throw new AccessError("bad_value", `${f.column}: is takes null, true or false`);
                }
                case "like":
                case "ilike": {
                    if (typeof f.value !== "string")
                        throw new AccessError("bad_value", `${f.column}: like takes text`);
                    // PostgREST's patterns: % or * any text, _ one character. like is case-sensitive (GLOB),
                    // ilike is not (LIKE, for ASCII; Georgian has no case).
                    if (f.op === "like") {
                        const glob = [...f.value].map((ch) => (ch === "%" || ch === "*" ? "*" : ch === "_" ? "?" : /[[\]?]/.test(ch) ? `[${ch}]` : ch)).join("");
                        return at(`(${col} GLOB ?)`, [glob]);
                    }
                    const like = [...f.value].map((ch) => (ch === "*" ? "%" : ch === "\\" ? "\\\\" : ch)).join("");
                    return at(`(${col} LIKE ? ESCAPE '\\')`, [like]);
                }
                case "cs":
                case "cd":
                case "ov": {
                    // A JSON column: text, or a column without a type.
                    const a = t.affinity.get(f.column);
                    if (a !== "text" && a !== "blob")
                        throw new AccessError("bad_value", `${f.column}: contains is for JSON columns`);
                    const x = containment(f.op, c, f.value, f.text === true);
                    return { sql: x.sql, params: x.params };
                }
                default:
                    throw new AccessError("bad_value", `unknown filter ${String(f.op)}`);
            }
        }
        function whereSql(name, t, rules, where, ref = fromTable(name)) {
            if (where !== undefined && !Array.isArray(where))
                throw new AccessError("bad_value", "filters are a list");
            if (leaves(where ?? []) > MAX_FILTERS)
                throw new AccessError("too_many", `at most ${MAX_FILTERS} filters`);
            const parts = (where ?? []).map((f) => filterSql(name, t, rules, f, 0, ref));
            return { sql: parts.length ? parts.map((p) => p.sql).join(" AND ") : "1", params: parts.flatMap((p) => p.params) };
        }
        function and(...parts) {
            return { sql: parts.map((p) => `coalesce(${p.sql}, 0)`).join(" AND "), params: parts.flatMap((p) => p.params) };
        }
        // A statement's WHERE: its parts as they are, since a WHERE drops a row whose condition is NULL as
        // it drops one whose condition is 0. Wrapped in coalesce() a filter on a column is an expression
        // SQLite cannot look up in an index, and every list, get, count, update and delete read the whole
        // table: Unichat's chat page read all 47,265 messages of every space for its two (2026-11-09).
        function where(...parts) {
            return { sql: parts.map((p) => `(${p.sql})`).join(" AND "), params: parts.flatMap((p) => p.params) };
        }
        function selectList(name, cols) {
            return cols.map((c) => `${quote(name)}.${quote(c)}`).join(", ");
        }
        function limitOf(n, fallback) {
            if (n === undefined)
                return fallback;
            if (!Number.isInteger(n) || n < 0)
                throw new AccessError("bad_value", "limit");
            return Math.min(n, maxRows);
        }
        // A failed check inside the statement: json() of text that is not JSON stops the statement,
        // and SQLite undoes all of it (exec turns the error into "refused"). The text depends on the
        // row, so SQLite never works it out once ahead of the rows.
        const REFUSED = (row) => `json('refused:' || typeof(${row}))`;
        // A change of more than one row stops the statement before it changes any: the count is
        // worked out once, at the first row, and abs() of the smallest integer is an error.
        function moreThanOne(name, t, cond) {
            const row = `${quote(name)}.${quote(t.columns[0])}`;
            return {
                sql: `(CASE WHEN (SELECT count(*) FROM ${quote(name)} WHERE ${cond.sql}) > 1 THEN abs(CASE WHEN typeof(${row}) IS NULL THEN 0 ELSE -9223372036854775807 - 1 END) ELSE 1 END)`,
                params: cond.params,
            };
        }
        const pick = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c] ?? null]));
        // What a statement returns: the caller's columns, or every column when Realtime wants the rows.
        function returned(t, rules, returning) {
            const cols = config.onChange ? t.columns : returning ? visible(t, rules) : [];
            return { sql: cols.length ? cols.map(quote).join(", ") : "1 AS _", cols: returning ? visible(t, rules) : [] };
        }
        async function emit(changes) {
            if (!config.onChange || !changes.length)
                return;
            try {
                await config.onChange(changes);
            }
            catch (e) {
                // The write is done; a room that could not be told must not undo it in the caller's eyes.
                console.error("onChange:", e);
            }
        }
        async function insert(name, input, options, conflict) {
            const rules = rulesOf(name);
            const t = await table(name);
            const rows = Array.isArray(input) ? input : [input];
            if (!rows.length)
                return { count: 0, ...(options.returning ? { rows: [] } : {}) };
            if (rows.length > maxRows)
                throw new AccessError("too_many", `at most ${maxRows} rows`);
            for (const r of rows)
                if (r === null || typeof r !== "object" || Array.isArray(r))
                    throw new AccessError("bad_value", "a row is an object");
            const given = [...new Set(rows.flatMap((r) => Object.keys(r)))];
            columnsFor(name, t, rules, given, "create");
            const fill = admin ? {} : (rules.fill ?? {});
            for (const c of Object.keys(fill))
                if (!t.columns.includes(c))
                    throw new AccessError("unknown_column", `${name}.${c}`);
            if (!given.length && !Object.keys(fill).length)
                throw new AccessError("bad_value", "a row needs a column");
            // Every column with a default goes in too, worked out once ("$v" is MATERIALIZED), so the
            // rules see the value the table keeps and not a NULL it never stores.
            const named = [...given, ...Object.keys(fill)];
            const cols = [...named, ...t.columns.filter((c) => t.defaults.get(c) != null && !named.includes(c))];
            // The rows go in as one JSON parameter (D1 takes at most 100), an object per row. A column
            // one row leaves out takes the column's default in it, and the rules see that default.
            const payload = json(rows.map((r) => {
                const o = {};
                for (const c of given)
                    if (Object.hasOwn(r, c) && r[c] !== undefined)
                        o[c] = stored(t, c, r[c]);
                for (const [c, from] of Object.entries(fill))
                    o[c] = stored(t, c, auth?.[from.slice(5)]);
                return o;
            }));
            const picked = (c) => `CASE WHEN json_type(value, '$.${c}') IS NULL THEN ${t.defaults.get(c) ?? "NULL"} ELSE json_extract(value, '$.${c}') END AS ${quote(`c_${c}`)}`;
            const vName = (c) => `"$v".${quote(`c_${c}`)}`;
            const fromNew = (c) => (cols.includes(c) ? { sql: vName(c), params: [] } : { sql: "NULL", params: [] });
            const checks = [await ruleSql(name, rules, "create", fromNew)];
            if (options.returning)
                checks.push(await ruleSql(name, rules, "list", fromNew));
            const allowed = and(...checks);
            let onConflict = "";
            let changed = [];
            let target = [];
            if (conflict) {
                target = conflict.onConflict?.length ? conflict.onConflict : t.key;
                if (target.includes("rowid"))
                    throw new AccessError("bad_value", `${name} has no key; name the columns it may collide on`);
                columnsFor(name, t, rules, target, "read");
                if (conflict.ignoreDuplicates)
                    onConflict = ` ON CONFLICT (${target.map(quote).join(", ")}) DO NOTHING`;
                else {
                    // A colliding row is changed as update() would: never its key, nor what fill set.
                    const set = given.filter((c) => !target.includes(c) && !t.key.includes(c));
                    const sets = set.length ? set : [target[0]];
                    const excluded = (c) => (set.includes(c) ? { sql: `excluded.${quote(c)}`, params: [] } : fromTable(name)(c));
                    const parts = [
                        await ruleSql(name, rules, "list", fromTable(name)),
                        await ruleSql(name, rules, "update", fromTable(name)),
                        await ruleSql(name, rules, "updateCheck", excluded),
                    ];
                    if (options.returning)
                        parts.push(await ruleSql(name, rules, "list", excluded));
                    const cond = and(...parts);
                    onConflict =
                        ` ON CONFLICT (${target.map(quote).join(", ")}) DO UPDATE SET ${sets.map((c) => `${quote(c)} = excluded.${quote(c)}`).join(", ")}` +
                            ` WHERE CASE WHEN ${cond.sql} THEN 1 ELSE ${REFUSED(`excluded.${quote(target[0])}`)} END`;
                    changed = cond.params;
                }
            }
            // Which rows an upsert will change rather than add, for Realtime's INSERT or UPDATE. Read
            // before the write, so a row added between the two is called an UPDATE: only the label.
            let existed = new Set();
            if (config.onChange && conflict && !conflict.ignoreDuplicates) {
                const keys = json(rows.map((r) => target.map((c) => stored(t, c, r[c]))));
                // A join on the key, so its index is used rather than every row read.
                const found = await exec(`SELECT ${target.map((c) => `${quote(name)}.${quote(c)}`).join(", ")} FROM json_each(?) AS "$k" JOIN ${quote(name)} ON ` +
                    target.map((c, i) => `${quote(name)}.${quote(c)} = json_extract("$k".value, '$[${i}]')`).join(" AND "), [keys]);
                existed = new Set(found.map((f) => JSON.stringify(target.map((c) => f[c]))));
            }
            const back = returned(t, rules, options.returning);
            const out = await exec(`WITH "$v" AS MATERIALIZED (SELECT ${cols.map(picked).join(", ")} FROM json_each(?)) ` +
                `INSERT OR ABORT INTO ${quote(name)} (${cols.map(quote).join(", ")}) ` +
                `SELECT ${cols.map(vName).join(", ")} FROM "$v" ` +
                `WHERE CASE WHEN NOT EXISTS (SELECT 1 FROM "$v" WHERE NOT (${allowed.sql})) THEN 1 ELSE ${REFUSED(vName(cols[0]))} END` +
                `${onConflict} RETURNING ${back.sql}`, [payload, ...allowed.params, ...changed]);
            if (!conflict?.ignoreDuplicates && out.length !== rows.length)
                throw new AccessError("refused", `create on ${name}`);
            const at = new Date().toISOString();
            await emit(out.map((r) => existed.has(JSON.stringify(target.map((c) => r[c])))
                ? { table: name, type: "UPDATE", record: r, old: pick(r, t.key.filter((k) => k !== "rowid")), at }
                : { table: name, type: "INSERT", record: r, old: null, at }));
            return { count: out.length, ...(options.returning ? { rows: out.map((r) => pick(r, back.cols)) } : {}) };
        }
        return {
            async list(name, query = {}) {
                const rules = rulesOf(name);
                const t = await table(name);
                const cols = query.columns?.length ? query.columns : visible(t, rules);
                columnsFor(name, t, rules, cols, "read");
                const where_ = where(whereSql(name, t, rules, query.where), await ruleSql(name, rules, "list", fromTable(name)));
                const order = (query.order ?? []).map((o) => {
                    columnsFor(name, t, rules, [o.column], "read");
                    return `${quote(name)}.${quote(o.column)} ${o.ascending === false ? "DESC" : "ASC"}${o.nulls ? ` NULLS ${o.nulls === "first" ? "FIRST" : "LAST"}` : ""}`;
                });
                const limit = limitOf(query.limit, maxRows);
                const offset = query.offset ?? 0;
                if (!Number.isInteger(offset) || offset < 0)
                    throw new AccessError("bad_value", "offset");
                return exec(`SELECT ${selectList(name, cols)} FROM ${quote(name)} WHERE ${where_.sql}${order.length ? ` ORDER BY ${order.join(", ")}` : ""} LIMIT ? OFFSET ?`, [...where_.params, limit, offset]);
            },
            async get(name, key, cols) {
                const rules = rulesOf(name);
                const t = await table(name);
                if (t.key.length !== 1)
                    throw new AccessError("bad_value", `${name} has no single key`);
                const pick = cols?.length ? cols : visible(t, rules);
                columnsFor(name, t, rules, pick, "read");
                const byKey = where({ sql: `${quote(name)}.${quote(t.key[0])} = ?`, params: [bind(key)] }, await ruleSql(name, rules, "view", fromTable(name)));
                const rows = await exec(`SELECT ${selectList(name, pick)} FROM ${quote(name)} WHERE ${byKey.sql} LIMIT 1`, byKey.params);
                return rows[0] ?? null;
            },
            create: (name, input, options = {}) => insert(name, input, options),
            upsert: (name, input, options = {}) => insert(name, input, options, options),
            async count(name, filters) {
                const rules = rulesOf(name);
                const t = await table(name);
                const cond = where(whereSql(name, t, rules, filters), await ruleSql(name, rules, "list", fromTable(name)));
                const rows = await exec(`SELECT count(*) AS n FROM ${quote(name)} WHERE ${cond.sql}`, cond.params);
                return Number(rows[0]?.n ?? 0);
            },
            async describe(name) {
                const rules = rulesOf(name);
                const t = await table(name);
                const shown = visible(t, rules);
                const keyOf = async (other) => (await table(other)).key;
                const foreignKeys = [];
                for (const f of t.foreignKeys) {
                    if (!shown.includes(f.from))
                        continue;
                    const to = f.to ?? (await keyOf(f.table))[0];
                    if (to && isName(f.table))
                        foreignKeys.push({ from: f.from, table: f.table, to });
                }
                return {
                    columns: shown.map((c) => ({ name: c, type: t.types.get(c) ?? "", affinity: t.affinity.get(c) ?? "blob" })),
                    key: t.key,
                    foreignKeys,
                };
            },
            async update(name, filters, patch, options = {}) {
                const rules = rulesOf(name);
                const t = await table(name);
                if (!admin && !narrows(filters))
                    throw new AccessError("filter_required", `update on ${name}`);
                if (patch === null || typeof patch !== "object" || Array.isArray(patch))
                    throw new AccessError("bad_value", "a patch is an object");
                const cols = Object.keys(patch);
                if (!cols.length)
                    throw new AccessError("bad_value", "nothing to change");
                columnsFor(name, t, rules, cols, "write");
                const next = new Map(cols.map((c) => [c, stored(t, c, patch[c])]));
                const fromNew = (c) => (next.has(c) ? { sql: "?", params: [next.get(c)] } : fromTable(name)(c));
                const parts = [
                    whereSql(name, t, rules, filters),
                    await ruleSql(name, rules, "list", fromTable(name)),
                    await ruleSql(name, rules, "update", fromTable(name)),
                    await ruleSql(name, rules, "updateCheck", fromNew),
                ];
                if (options.returning)
                    parts.push(await ruleSql(name, rules, "list", fromNew));
                if (options.one)
                    parts.push(moreThanOne(name, t, where(...parts)));
                const cond = where(...parts);
                const back = returned(t, rules, options.returning);
                const out = await exec(`UPDATE OR ABORT ${quote(name)} SET ${cols.map((c) => `${quote(c)} = ?`).join(", ")} WHERE ${cond.sql} RETURNING ${back.sql}`, [...cols.map((c) => next.get(c)), ...cond.params]);
                const at = new Date().toISOString();
                await emit(out.map((r) => ({ table: name, type: "UPDATE", record: r, old: pick(r, t.key.filter((k) => k !== "rowid")), at })));
                return { count: out.length, ...(options.returning ? { rows: out.map((r) => pick(r, back.cols)) } : {}) };
            },
            async delete(name, filters, options = {}) {
                const rules = rulesOf(name);
                const t = await table(name);
                if (!admin && !narrows(filters))
                    throw new AccessError("filter_required", `delete on ${name}`);
                const parts = [
                    whereSql(name, t, rules, filters),
                    await ruleSql(name, rules, "list", fromTable(name)),
                    await ruleSql(name, rules, "delete", fromTable(name)),
                ];
                if (options.one)
                    parts.push(moreThanOne(name, t, where(...parts)));
                const cond = where(...parts);
                const back = returned(t, rules, options.returning);
                const out = await exec(`DELETE FROM ${quote(name)} WHERE ${cond.sql} RETURNING ${back.sql}`, cond.params);
                const at = new Date().toISOString();
                await emit(out.map((r) => ({ table: name, type: "DELETE", record: null, old: r, at })));
                return { count: out.length, ...(options.returning ? { rows: out.map((r) => pick(r, back.cols)) } : {}) };
            },
            async sees(name, row, filters) {
                const rules = rulesOf(name);
                const t = await table(name);
                if (row === null || typeof row !== "object")
                    return null;
                // The row's values as parameters, with the column's affinity, so that a rule compares them
                // as it compares the stored column in list() (a bare parameter has none: 7 = '7' is false).
                const fromRow = (c) => {
                    const v = t.columns.includes(c) && Object.hasOwn(row, c) ? bind(row[c]) : null;
                    const a = t.affinity.get(c);
                    if (typeof v === "number" && (a === "integer" || a === "real" || a === "numeric"))
                        return { sql: "CAST(? AS NUMERIC)", params: [v] };
                    if (typeof v === "string" && a === "text")
                        return { sql: "CAST(? AS TEXT)", params: [v] };
                    return { sql: "?", params: [v] };
                };
                const cond = where(whereSql(name, t, rules, filters, fromRow), await ruleSql(name, rules, "list", fromRow));
                const ok = await exec(`SELECT 1 AS ok WHERE ${cond.sql}`, cond.params);
                return ok.length ? pick(row, visible(t, rules)) : null;
            },
        };
    }
    return {
        /** The data as this person may see it; null is signed out. */
        as: (auth) => open(auth, false),
        /** Everything, without rules: the project's own server code only. */
        admin: () => open(null, true),
        /** Most rows one list returns. */
        maxRows,
    };
}
export { AccessError, checkAccess, parseRule } from "./access.js";
