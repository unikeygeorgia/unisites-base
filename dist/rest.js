import { AccessError, isName } from "./access.js";
class RestError extends Error {
    status;
    code;
    details;
    constructor(status, code, message, details = null) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
const unsupported = (what) => new RestError(400, "PGRST100", `not supported: ${what}`);
const MAX_BODY = 2 * 1024 * 1024;
const MAX_DEPTH = 4;
/** Embeds in one select, side by side and nested: each is a query. */
const MAX_EMBEDS = 20;
/** Embedded rows one request reads, as many times data's maxRows. */
const EMBED_ROWS = 5;
/** Splits at commas outside parentheses and double quotes. */
function split(s) {
    const out = [];
    let depth = 0;
    let quoted = false;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quoted) {
            if (ch === "\\")
                i++;
            else if (ch === '"')
                quoted = false;
        }
        else if (ch === '"')
            quoted = true;
        else if (ch === "(")
            depth++;
        else if (ch === ")") {
            if (--depth < 0)
                throw new RestError(400, "PGRST100", `unbalanced parentheses: ${s}`);
        }
        else if (ch === "," && depth === 0) {
            out.push(s.slice(start, i));
            start = i + 1;
        }
    }
    if (depth !== 0 || quoted)
        throw new RestError(400, "PGRST100", `unbalanced parentheses or quotes: ${s}`);
    out.push(s.slice(start));
    return out;
}
export function parseSelect(s, depth = 0) {
    if (depth > MAX_DEPTH)
        throw unsupported(`embeds deeper than ${MAX_DEPTH}`);
    const items = [];
    for (const part of split(s.replace(/\s+/g, ""))) {
        if (part === "*") {
            items.push({ k: "star" });
            continue;
        }
        const embed = /^(?:([A-Za-z_]\w*):)?([A-Za-z_]\w*)(?:!([A-Za-z_]\w*))?\((.*)\)$/s.exec(part);
        if (embed) {
            const [, alias, table, hint, inner] = embed;
            if (hint === "inner")
                throw unsupported("!inner embeds");
            items.push({ k: "embed", table: table, alias, hint: hint === "left" ? undefined : hint, items: parseSelect(inner || "*", depth + 1) });
            continue;
        }
        const column = /^(?:([A-Za-z_]\w*):)?([A-Za-z_]\w*)$/.exec(part);
        if (column) {
            items.push({ k: "column", name: column[2], alias: column[1] });
            continue;
        }
        throw unsupported(`select item ${JSON.stringify(part)} (casts, JSON paths and aggregates are not)`);
    }
    return items;
}
// --- filters ---------------------------------------------------------------------------------
const OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in", "is"]);
function unquote(v) {
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"'))
        return v.slice(1, -1).replace(/\\(.)/g, "$1");
    return v;
}
/** A value as the column keeps it: PostgREST's are text, and Postgres reads them by the column's type. */
function coerce(desc, column, value) {
    const c = desc.columns.find((x) => x.name === column);
    if (!c)
        return value;
    if (/BOOL/i.test(c.type)) {
        if (value === "true")
            return true;
        if (value === "false")
            return false;
        throw new RestError(400, "22P02", `invalid input syntax for type boolean: "${value}"`);
    }
    if (c.affinity === "integer" || c.affinity === "real" || c.affinity === "numeric") {
        if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value))
            return Number(value);
        throw new RestError(400, "22P02", `invalid input syntax for type ${c.type || "numeric"}: "${value}"`);
    }
    return value;
}
/** `[not.]op.value` for one column. */
export function parseCondition(desc, column, expr) {
    if (!isName(column))
        throw new RestError(400, "42703", `column ${column} does not exist`);
    let negate = false;
    if (expr.startsWith("not.")) {
        negate = true;
        expr = expr.slice(4);
    }
    const dot = expr.indexOf(".");
    const op = dot < 0 ? expr : expr.slice(0, dot);
    const raw = dot < 0 ? "" : expr.slice(dot + 1);
    if (!OPS.has(op))
        throw unsupported(`the filter ${JSON.stringify(op)}`);
    let filter;
    if (op === "in") {
        if (!raw.startsWith("(") || !raw.endsWith(")"))
            throw new RestError(400, "PGRST100", `in takes (a,b,...): ${raw}`);
        const inner = raw.slice(1, -1);
        filter = { column, op: "in", value: inner === "" ? [] : split(inner).map((v) => coerce(desc, column, unquote(v))) };
    }
    else if (op === "is") {
        const v = { null: null, unknown: null, true: true, false: false }[raw.toLowerCase()];
        if (v === undefined)
            throw new RestError(400, "PGRST100", `is takes null, true or false: ${raw}`);
        filter = { column, op: "is", value: v };
    }
    else if (op === "like" || op === "ilike") {
        filter = { column, op, value: unquote(raw) };
    }
    else {
        filter = { column, op: op, value: coerce(desc, column, unquote(raw)) };
    }
    return negate ? { not: filter } : filter;
}
/** `or=(a.eq.1,and(b.gt.2,c.is.null))`, and `and=`, `not.or=`, `not.and=`. */
function parseLogic(desc, kind, raw, depth = 0) {
    if (depth > 8)
        throw unsupported("filters nested deeper than 8");
    if (!raw.startsWith("(") || !raw.endsWith(")"))
        throw new RestError(400, "PGRST100", `${kind} takes (...): ${raw}`);
    const items = split(raw.slice(1, -1)).map((part) => {
        const nested = /^(not\.)?(and|or)(\(.*\))$/s.exec(part);
        if (nested) {
            const f = parseLogic(desc, nested[2], nested[3], depth + 1);
            return nested[1] ? { not: f } : f;
        }
        const dot = part.indexOf(".");
        if (dot < 0)
            throw new RestError(400, "PGRST100", `a condition is column.op.value: ${part}`);
        return parseCondition(desc, part.slice(0, dot), part.slice(dot + 1));
    });
    return kind === "or" ? { or: items } : { and: items };
}
function parseOrder(raw) {
    return split(raw).map((part) => {
        const [column, ...mods] = part.split(".");
        if (!column || !isName(column))
            throw unsupported(`order by ${JSON.stringify(part)}`);
        const o = { column };
        for (const m of mods) {
            if (m === "asc")
                o.ascending = true;
            else if (m === "desc")
                o.ascending = false;
            else if (m === "nullsfirst")
                o.nulls = "first";
            else if (m === "nullslast")
                o.nulls = "last";
            else
                throw unsupported(`order ${JSON.stringify(m)}`);
        }
        return o;
    });
}
const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
function parseQuery(desc, params) {
    const where = [];
    const out = { where };
    const int = (key, v) => {
        if (!/^\d{1,9}$/.test(v))
            throw new RestError(400, "PGRST100", `${key} is a whole number`);
        return Number(v);
    };
    for (const [key, value] of params) {
        if (key === "order")
            out.order = parseOrder(value);
        else if (key === "limit")
            out.limit = int(key, value);
        else if (key === "offset")
            out.offset = int(key, value);
        else if (RESERVED.has(key))
            continue;
        else if (key === "or" || key === "and")
            where.push(parseLogic(desc, key, value));
        else if (key === "not.or" || key === "not.and")
            where.push({ not: parseLogic(desc, key.slice(4), value) });
        else if (key.includes("."))
            throw unsupported(`filters, order and limits on embedded tables (${key})`);
        else
            where.push(parseCondition(desc, key, value));
    }
    return out;
}
// --- the handler -----------------------------------------------------------------------------
function prefer(request) {
    const out = new Map();
    for (const part of (request.headers.get("prefer") ?? "").split(",")) {
        const [k, v] = part.trim().split("=");
        if (k)
            out.set(k.toLowerCase(), (v ?? "").toLowerCase());
    }
    return out;
}
function json(status, body, headers = {}, head = false) {
    return new Response(head || body === undefined ? null : JSON.stringify(body), {
        status,
        headers: {
            ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
            "cache-control": "private, no-store",
            ...headers,
        },
    });
}
function fail(e) {
    const send = (status, code, message, details = null) => json(status, { code, message, details, hint: null });
    if (e instanceof RestError)
        return send(e.status, e.code, e.message, e.details);
    if (e instanceof AccessError) {
        switch (e.code) {
            case "unknown_table":
            case "bad_name":
                return send(404, "PGRST205", `Could not find the table '${e.message}' in the schema cache`);
            // Hidden columns are answered as missing ones: whether one is there is not said.
            case "unknown_column":
            case "hidden_column":
                return send(400, "42703", `column ${e.message} does not exist`);
            case "readonly_column":
                return send(403, "42501", `permission denied for column ${e.message}`);
            case "forbidden":
                return send(403, "42501", `permission denied: ${e.message}`);
            case "refused":
                return send(403, "42501", "new row violates row-level security policy", e.message);
            case "filter_required":
                return send(400, "21000", "UPDATE and DELETE require a WHERE clause", e.message);
            case "conflict":
                return send(409, "23505", "duplicate key value or a failed check", e.message);
            case "bad_value":
                return send(400, "22P02", e.message);
            case "too_many":
                return send(400, "54000", e.message);
            default:
                break;
        }
    }
    console.error("rest:", e);
    return send(500, "XX000", "internal error");
}
export function createRest(config) {
    const prefix = config.prefix ?? "/rest/v1/";
    async function body(request) {
        if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
            throw new RestError(415, "PGRST107", "the body must be application/json");
        }
        const tooLarge = () => new RestError(413, "PGRST100", "the body is too large");
        if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY)
            throw tooLarge();
        // Read with a cap: a body without a length could be any size.
        const chunks = [];
        let size = 0;
        if (request.body) {
            const reader = request.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                size += value.byteLength;
                if (size > MAX_BODY) {
                    await reader.cancel();
                    throw tooLarge();
                }
                chunks.push(value);
            }
        }
        const all = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
            all.set(c, at);
            at += c.byteLength;
        }
        const text = new TextDecoder().decode(all);
        try {
            return JSON.parse(text);
        }
        catch {
            throw new RestError(400, "PGRST102", "the body is not JSON");
        }
    }
    async function handler(request) {
        try {
            return await handle(request);
        }
        catch (e) {
            return fail(e);
        }
    }
    async function handle(request) {
        const url = new URL(request.url);
        if (!url.pathname.startsWith(prefix))
            throw new RestError(404, "PGRST125", "not found");
        let path;
        try {
            path = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/\/$/, "");
        }
        catch {
            throw new RestError(404, "PGRST125", "not found");
        }
        const method = request.method.toUpperCase();
        // Writes and functions with the person's cookie only from the project's own pages (and the
        // app's): every *.unisites.ge is the same site as every other, so SameSite=Lax is not enough.
        if ((method !== "GET" && method !== "HEAD") || path.startsWith("rpc/")) {
            const origin = request.headers.get("origin");
            const site = request.headers.get("sec-fetch-site");
            const allowed = (o) => !!o && (o === url.origin || !!config.origins?.includes(o));
            if ((origin && !allowed(origin)) || ((site === "cross-site" || site === "same-site") && !allowed(origin))) {
                throw new RestError(403, "PGRST301", "this origin may not write");
            }
        }
        for (const h of ["accept-profile", "content-profile"]) {
            const p = request.headers.get(h);
            if (p && p !== "public")
                throw new RestError(406, "PGRST106", `only the public schema: ${p}`);
        }
        const auth = await config.auth(request);
        const db = config.data.as(auth);
        if (path.startsWith("rpc/"))
            return rpc(request, url, path.slice(4), db, auth);
        const table = path;
        if (!isName(table))
            throw new AccessError("unknown_table", table);
        const desc = await db.describe(table);
        const p = prefer(request);
        const single = /application\/vnd\.pgrst\.object\+json/i.test(request.headers.get("accept") ?? "");
        const counted = ["exact", "planned", "estimated"].includes(p.get("count") ?? "");
        const select = parseSelect(url.searchParams.get("select") ?? "*");
        if (embeds(select) > MAX_EMBEDS)
            throw unsupported(`more than ${MAX_EMBEDS} embeds in one select`);
        budget.set(select, config.data.maxRows * EMBED_ROWS);
        const q = parseQuery(desc, url.searchParams);
        if (method === "GET" || method === "HEAD") {
            const range = /^(\d{1,9})-(\d{0,9})$/.exec(request.headers.get("range") ?? "");
            const offset = q.offset ?? (range ? Number(range[1]) : 0);
            const limit = q.limit ?? (range && range[2] ? Number(range[2]) - Number(range[1]) + 1 : undefined);
            const rows = await db.list(table, {
                columns: await needed(db, table, desc, select),
                where: q.where,
                order: q.order,
                limit: single && limit === undefined ? 2 : limit,
                offset,
            });
            const shaped = await shape(db, table, desc, select, rows, 0);
            const total = counted ? await db.count(table, q.where) : undefined;
            const headers = { "content-range": contentRange(offset, shaped.length, total) };
            if (single)
                return object(shaped, headers, method === "HEAD");
            return json(200, shaped, headers, method === "HEAD");
        }
        const representation = p.get("return") === "representation";
        if (method === "POST") {
            let input = await body(request);
            const columns = url.searchParams.get("columns");
            if (columns) {
                const keep = split(columns).map(unquote);
                const pick = (r) => r !== null && typeof r === "object" && !Array.isArray(r) ? Object.fromEntries(keep.filter((k) => Object.hasOwn(r, k)).map((k) => [k, r[k]])) : r;
                input = Array.isArray(input) ? input.map(pick) : pick(input);
            }
            const rows = input;
            const resolution = p.get("resolution");
            const onConflict = url.searchParams.get("on_conflict");
            const result = resolution === "merge-duplicates" || resolution === "ignore-duplicates"
                ? await db.upsert(table, rows, {
                    onConflict: onConflict ? split(onConflict).map(unquote) : undefined,
                    ignoreDuplicates: resolution === "ignore-duplicates",
                    returning: representation,
                })
                : await db.create(table, rows, { returning: representation });
            return written(db, table, desc, select, result, 201, representation, single, counted);
        }
        if (method === "PATCH" || method === "DELETE") {
            if (q.limit !== undefined || q.order)
                throw unsupported("limit and order on a change");
            let result;
            try {
                // single() on a change: more than one row changes none (PostgREST rolls it back).
                result =
                    method === "PATCH"
                        ? await db.update(table, q.where, (await body(request)), { returning: representation, one: single })
                        : await db.delete(table, q.where, { returning: representation, one: single });
            }
            catch (e) {
                if (single && e instanceof AccessError && e.code === "too_many")
                    return object([{}, {}], {}, false);
                throw e;
            }
            return written(db, table, desc, select, result, representation ? 200 : 204, representation, single, counted);
        }
        throw new RestError(405, "PGRST117", `${method} is not supported`);
    }
    async function written(db, table, desc, select, result, status, representation, single, counted) {
        const headers = counted ? { "content-range": `*/${result.count}` } : {};
        if (!representation)
            return json(status === 201 ? 201 : 204, undefined, headers);
        const shaped = await shape(db, table, desc, select, result.rows ?? [], 0);
        if (single)
            return object(shaped, headers, false, status);
        return json(status, shaped, headers);
    }
    function object(rows, headers, head, status = 200) {
        if (rows.length !== 1) {
            return json(406, {
                code: "PGRST116",
                message: "JSON object requested, multiple (or no) rows returned",
                details: `The result contains ${rows.length} rows`,
                hint: null,
            });
        }
        return json(status, rows[0], headers, head);
    }
    async function rpc(request, url, name, db, auth) {
        const entry = isName(name) && config.rpc && Object.hasOwn(config.rpc, name) ? config.rpc[name] : undefined;
        if (!entry)
            throw new RestError(404, "PGRST202", `Could not find the function public.${name} in the schema cache`);
        const fn = typeof entry === "function" ? entry : entry.handler;
        let args;
        if (request.method === "GET" || request.method === "HEAD") {
            if (typeof entry === "function" || !entry.get)
                throw new RestError(405, "PGRST117", `${name} takes POST`);
            args = Object.fromEntries(url.searchParams);
        }
        else if (request.method === "POST") {
            const b = await body(request);
            if (b === null || typeof b !== "object" || Array.isArray(b))
                throw new RestError(400, "PGRST102", "rpc takes an object");
            args = b;
        }
        else
            throw new RestError(405, "PGRST117", `${request.method} is not supported`);
        const result = await fn(args, { db, auth, request });
        return json(200, result === undefined ? null : result, {}, request.method === "HEAD");
    }
    // The columns to read: the ones asked for, and those an embed joins on.
    async function needed(db, table, desc, select) {
        const cols = new Set();
        for (const item of select) {
            if (item.k === "star")
                desc.columns.forEach((c) => cols.add(c.name));
            else if (item.k === "column")
                cols.add(item.name);
            else
                cols.add((await relation(db, table, desc, item)).own);
        }
        return [...cols];
    }
    const relations = new WeakMap();
    // Embedded rows a request may still read, by its select.
    const budget = new WeakMap();
    const embeds = (items) => items.reduce((n, i) => n + (i.k === "embed" ? 1 + embeds(i.items) : 0), 0);
    // The one foreign key between the table and an embedded one, either way (PGRST200, PGRST201).
    async function relation(db, table, desc, item) {
        const known = relations.get(item);
        if (known)
            return known;
        let child;
        try {
            child = await db.describe(item.table);
        }
        catch (e) {
            if (e instanceof AccessError && (e.code === "unknown_table" || e.code === "bad_name")) {
                throw new RestError(400, "PGRST200", `Could not find a relationship between '${table}' and '${item.table}' in the schema cache`);
            }
            throw e;
        }
        const found = [
            ...desc.foreignKeys
                .filter((f) => f.table === item.table && (!item.hint || f.from === item.hint))
                .map((f) => ({ child, own: f.from, theirs: f.to, many: false })),
            ...(item.table === table
                ? []
                : child.foreignKeys
                    .filter((f) => f.table === table && (!item.hint || f.from === item.hint))
                    .map((f) => ({ child, own: f.to, theirs: f.from, many: true }))),
        ];
        if (!found.length) {
            throw new RestError(400, "PGRST200", `Could not find a relationship between '${table}' and '${item.table}' in the schema cache`);
        }
        if (found.length > 1) {
            throw new RestError(300, "PGRST201", `Could not embed because more than one relationship was found for '${table}' and '${item.table}'`, `name one: ${item.table}!<column>(...)`);
        }
        relations.set(item, found[0]);
        return found[0];
    }
    // Rows as the select asks: its order, its aliases, the embeds, and Postgres' values.
    async function shape(db, table, desc, select, rows, depth, root = select) {
        const embedded = new Map();
        for (const item of select) {
            if (item.k !== "embed")
                continue;
            const r = await relation(db, table, desc, item);
            const values = [...new Set(rows.map((row) => row[r.own]).filter((v) => v !== null && v !== undefined))];
            const found = new Map();
            const childCols = new Set(await needed(db, item.table, r.child, item.items));
            childCols.add(r.theirs);
            for (let i = 0; i < values.length; i += 1000) {
                const chunk = values.slice(i, i + 1000);
                const got = await db.list(item.table, { columns: [...childCols], where: [{ column: r.theirs, op: "in", value: chunk }] });
                if (got.length >= config.data.maxRows)
                    throw new AccessError("too_many", `more than ${config.data.maxRows} ${item.table} rows to embed; filter the request`);
                const left = (budget.get(root) ?? config.data.maxRows * EMBED_ROWS) - got.length;
                if (left < 0)
                    throw new AccessError("too_many", "too many embedded rows in one request; filter it");
                budget.set(root, left);
                const shaped = await shape(db, item.table, r.child, item.items, got, depth + 1, root);
                got.forEach((g, j) => {
                    const k = g[r.theirs];
                    if (r.many) {
                        const list = found.get(k) ?? [];
                        list.push(shaped[j]);
                        found.set(k, list);
                    }
                    else
                        found.set(k, shaped[j]);
                });
            }
            embedded.set(item, found);
        }
        const value = valueOf(desc);
        return rows.map((row) => {
            const out = {};
            for (const item of select) {
                if (item.k === "star")
                    for (const c of desc.columns)
                        out[c.name] = value(c.name, row[c.name]);
                else if (item.k === "column")
                    out[item.alias ?? item.name] = value(item.name, row[item.name]);
                else {
                    const r = relations.get(item);
                    const k = row[r.own];
                    const got = k === null || k === undefined ? undefined : embedded.get(item).get(k);
                    out[item.alias ?? item.table] = r.many ? (got ?? []) : (got ?? null);
                }
            }
            return out;
        });
    }
    return { handler };
}
/** A value as Postgres would answer it: BOOLEAN as true or false, JSON parsed. */
export function valueOf(desc) {
    const kinds = new Map(desc.columns.map((c) => [c.name, /BOOL/i.test(c.type) ? "bool" : /JSON/i.test(c.type) ? "json" : ""]));
    return (column, v) => {
        if (v === null || v === undefined)
            return null;
        const kind = kinds.get(column);
        if (kind === "bool")
            return v === 1 || v === true || v === "1" || v === "true";
        if (kind === "json" && typeof v === "string") {
            try {
                return JSON.parse(v);
            }
            catch {
                return v;
            }
        }
        return v;
    };
}
function contentRange(offset, n, total) {
    const t = total === undefined ? "*" : String(total);
    return n ? `${offset}-${offset + n - 1}/${t}` : `*/${t}`;
}
