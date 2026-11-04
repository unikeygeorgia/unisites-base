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
        function filterSql(name, t, rules, f, depth = 0) {
            if (depth > 8)
                throw new AccessError("bad_value", "filters nest too deep");
            if (f === null || typeof f !== "object" || Array.isArray(f))
                throw new AccessError("bad_value", "a filter is an object");
            if ("or" in f || "and" in f) {
                const items = ("or" in f ? f.or : f.and).map((x) => filterSql(name, t, rules, x, depth + 1));
                if (!items.length)
                    return { sql: "or" in f ? "0" : "1", params: [] };
                return { sql: `(${items.map((i) => i.sql).join("or" in f ? " OR " : " AND ")})`, params: items.flatMap((i) => i.params) };
            }
            if ("not" in f) {
                const x = filterSql(name, t, rules, f.not, depth + 1);
                return { sql: `(NOT coalesce(${x.sql}, 0))`, params: x.params };
            }
            columnsFor(name, t, rules, [f.column], "read");
            const col = `${quote(name)}.${quote(f.column)}`;
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
                    return { sql: `(${col} ${op} ?)`, params: [scalar(f.value)] };
                }
                case "in": {
                    if (!Array.isArray(f.value))
                        throw new AccessError("bad_value", `${f.column}: in takes a list`);
                    if (f.value.length > MAX_IN)
                        throw new AccessError("too_many", `${f.column}: in takes at most ${MAX_IN}`);
                    if (!f.value.length)
                        return { sql: "0", params: [] };
                    // One parameter for the whole list: D1 takes at most 100 in a statement.
                    return { sql: `(${col} IN (SELECT value FROM json_each(?)))`, params: [json(f.value.map(scalar))] };
                }
                case "is": {
                    if (f.value === null)
                        return { sql: `(${col} IS NULL)`, params: [] };
                    if (f.value === true || f.value === false)
                        return { sql: `(${col} IS ?)`, params: [f.value ? 1 : 0] };
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
                        return { sql: `(${col} GLOB ?)`, params: [glob] };
                    }
                    const like = [...f.value].map((ch) => (ch === "*" ? "%" : ch === "\\" ? "\\\\" : ch)).join("");
                    return { sql: `(${col} LIKE ? ESCAPE '\\')`, params: [like] };
                }
                default:
                    throw new AccessError("bad_value", `unknown filter ${String(f.op)}`);
            }
        }
        function whereSql(name, t, rules, where) {
            if (where !== undefined && !Array.isArray(where))
                throw new AccessError("bad_value", "filters are a list");
            if (leaves(where ?? []) > MAX_FILTERS)
                throw new AccessError("too_many", `at most ${MAX_FILTERS} filters`);
            const parts = (where ?? []).map((f) => filterSql(name, t, rules, f));
            return { sql: parts.length ? parts.map((p) => p.sql).join(" AND ") : "1", params: parts.flatMap((p) => p.params) };
        }
        function and(...parts) {
            return { sql: parts.map((p) => `coalesce(${p.sql}, 0)`).join(" AND "), params: parts.flatMap((p) => p.params) };
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
            if (conflict) {
                const target = conflict.onConflict?.length ? conflict.onConflict : t.key;
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
            const back = options.returning ? visible(t, rules) : [];
            const out = await exec(`WITH "$v" AS MATERIALIZED (SELECT ${cols.map(picked).join(", ")} FROM json_each(?)) ` +
                `INSERT OR ABORT INTO ${quote(name)} (${cols.map(quote).join(", ")}) ` +
                `SELECT ${cols.map(vName).join(", ")} FROM "$v" ` +
                `WHERE CASE WHEN NOT EXISTS (SELECT 1 FROM "$v" WHERE NOT (${allowed.sql})) THEN 1 ELSE ${REFUSED(vName(cols[0]))} END` +
                `${onConflict} RETURNING ${back.length ? back.map(quote).join(", ") : "1 AS _"}`, [payload, ...allowed.params, ...changed]);
            if (!conflict?.ignoreDuplicates && out.length !== rows.length)
                throw new AccessError("refused", `create on ${name}`);
            return { count: out.length, ...(options.returning ? { rows: out } : {}) };
        }
        return {
            async list(name, query = {}) {
                const rules = rulesOf(name);
                const t = await table(name);
                const cols = query.columns?.length ? query.columns : visible(t, rules);
                columnsFor(name, t, rules, cols, "read");
                const where = and(whereSql(name, t, rules, query.where), await ruleSql(name, rules, "list", fromTable(name)));
                const order = (query.order ?? []).map((o) => {
                    columnsFor(name, t, rules, [o.column], "read");
                    return `${quote(name)}.${quote(o.column)} ${o.ascending === false ? "DESC" : "ASC"}${o.nulls ? ` NULLS ${o.nulls === "first" ? "FIRST" : "LAST"}` : ""}`;
                });
                const limit = limitOf(query.limit, maxRows);
                const offset = query.offset ?? 0;
                if (!Number.isInteger(offset) || offset < 0)
                    throw new AccessError("bad_value", "offset");
                return exec(`SELECT ${selectList(name, cols)} FROM ${quote(name)} WHERE ${where.sql}${order.length ? ` ORDER BY ${order.join(", ")}` : ""} LIMIT ? OFFSET ?`, [...where.params, limit, offset]);
            },
            async get(name, key, cols) {
                const rules = rulesOf(name);
                const t = await table(name);
                if (t.key.length !== 1)
                    throw new AccessError("bad_value", `${name} has no single key`);
                const pick = cols?.length ? cols : visible(t, rules);
                columnsFor(name, t, rules, pick, "read");
                const where = and({ sql: `${quote(name)}.${quote(t.key[0])} = ?`, params: [bind(key)] }, await ruleSql(name, rules, "view", fromTable(name)));
                const rows = await exec(`SELECT ${selectList(name, pick)} FROM ${quote(name)} WHERE ${where.sql} LIMIT 1`, where.params);
                return rows[0] ?? null;
            },
            create: (name, input, options = {}) => insert(name, input, options),
            upsert: (name, input, options = {}) => insert(name, input, options, options),
            async count(name, where) {
                const rules = rulesOf(name);
                const t = await table(name);
                const cond = and(whereSql(name, t, rules, where), await ruleSql(name, rules, "list", fromTable(name)));
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
            async update(name, where, patch, options = {}) {
                const rules = rulesOf(name);
                const t = await table(name);
                if (!admin && !narrows(where))
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
                    whereSql(name, t, rules, where),
                    await ruleSql(name, rules, "list", fromTable(name)),
                    await ruleSql(name, rules, "update", fromTable(name)),
                    await ruleSql(name, rules, "updateCheck", fromNew),
                ];
                if (options.returning)
                    parts.push(await ruleSql(name, rules, "list", fromNew));
                if (options.one)
                    parts.push(moreThanOne(name, t, and(...parts)));
                const cond = and(...parts);
                const back = options.returning ? visible(t, rules) : [];
                const out = await exec(`UPDATE OR ABORT ${quote(name)} SET ${cols.map((c) => `${quote(c)} = ?`).join(", ")} WHERE ${cond.sql} ` +
                    `RETURNING ${back.length ? back.map(quote).join(", ") : "1 AS _"}`, [...cols.map((c) => next.get(c)), ...cond.params]);
                return { count: out.length, ...(options.returning ? { rows: out } : {}) };
            },
            async delete(name, where, options = {}) {
                const rules = rulesOf(name);
                const t = await table(name);
                if (!admin && !narrows(where))
                    throw new AccessError("filter_required", `delete on ${name}`);
                const parts = [
                    whereSql(name, t, rules, where),
                    await ruleSql(name, rules, "list", fromTable(name)),
                    await ruleSql(name, rules, "delete", fromTable(name)),
                ];
                if (options.one)
                    parts.push(moreThanOne(name, t, and(...parts)));
                const cond = and(...parts);
                const back = options.returning ? visible(t, rules) : [];
                const out = await exec(`DELETE FROM ${quote(name)} WHERE ${cond.sql} RETURNING ${back.length ? back.map(quote).join(", ") : "1 AS _"}`, cond.params);
                return { count: out.length, ...(options.returning ? { rows: out } : {}) };
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
