import {
  AccessError,
  bind,
  compileRule,
  isName,
  parseRule,
  quote,
  type Access,
  type Node,
  type Operation,
  type Sql,
  type TableAccess,
} from "./access.ts";

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

export const d1 =
  (db: D1Database): Exec =>
  async (sql, params) =>
    (await db.prepare(sql).bind(...params).all<Row>()).results;

/** A Durable Object's `ctx.storage.sql`. */
export const sqlStorage =
  (storage: SqlStorage): Exec =>
  async (sql, params) =>
    storage.exec(sql, ...params).toArray() as Row[];

export type Auth = Record<string, unknown> & { id: unknown };

export type Op = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "is" | "like" | "ilike";
export type Filter = { column: string; op: Op; value: unknown } | { or: Filter[] } | { and: Filter[] } | { not: Filter };

export type Order = { column: string; ascending?: boolean; nulls?: "first" | "last" };

export type Query = { columns?: string[]; where?: Filter[]; order?: Order[]; limit?: number; offset?: number };

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

// SQLite's rules for a declared type (https://www.sqlite.org/datatype3.html, 3.1).
function affinityOf(type: string): "integer" | "text" | "blob" | "real" | "numeric" {
  const t = type.toUpperCase();
  if (t.includes("INT")) return "integer";
  if (/CHAR|CLOB|TEXT/.test(t)) return "text";
  if (t.includes("BLOB") || t === "") return "blob";
  if (/REAL|FLOA|DOUB/.test(t)) return "real";
  return "numeric";
}

export type Data = {
  list(table: string, query?: Query): Promise<Row[]>;
  get(table: string, key: unknown, columns?: string[]): Promise<Row | null>;
  create(table: string, rows: Row | Row[], options?: { returning?: boolean }): Promise<{ count: number; rows?: Row[] }>;
  update(table: string, where: Filter[], patch: Row, options?: { returning?: boolean }): Promise<{ count: number; rows?: Row[] }>;
  delete(table: string, where: Filter[], options?: { returning?: boolean }): Promise<{ count: number; rows?: Row[] }>;
};

const MAX_IN = 1000;
/** Column filters in one request: each is a parameter, and D1 takes 100 in a statement. */
const MAX_FILTERS = 30;

const among = (names: string[] | undefined, c: string) => !!names?.some((n) => n.toLowerCase() === c.toLowerCase());

function leaves(where: Filter[]): number {
  let n = 0;
  const walk = (f: Filter) => {
    if (f === null || typeof f !== "object") return;
    if ("or" in f && Array.isArray(f.or)) f.or.forEach(walk);
    else if ("and" in f && Array.isArray(f.and)) f.and.forEach(walk);
    else if ("not" in f) walk(f.not);
    else n++;
  };
  where.forEach(walk);
  return n;
}

/** A change or delete names at least one column outright, not only in or/not (safeupdate). */
function narrows(where: Filter[]): boolean {
  return Array.isArray(where) && where.some((f) => f !== null && typeof f === "object" && "column" in f);
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw new AccessError("bad_value", "a value JSON cannot carry");
  }
}

/**
 * A value as the column will store it, before any rule sees it: SQLite turns '-5' into -5 in
 * an INTEGER column, so a rule checking the text would pass what the table then keeps as a
 * number. Text goes only into text columns, numbers and booleans only into numeric ones;
 * a column without a type takes either, and keeps it as it is.
 */
function stored(t: Table, column: string, value: unknown): unknown {
  const affinity = t.affinity.get(column) ?? "blob";
  const numeric = affinity === "integer" || affinity === "real" || affinity === "numeric";
  const wrong = (what: string) => new AccessError("bad_value", `${column}: ${what} into a ${affinity} column`);
  if (value === undefined || value === null) return null;
  switch (typeof value) {
    case "string":
      if (numeric) throw wrong("text");
      return value;
    case "number":
      if (!Number.isFinite(value)) throw wrong("a number that is not finite");
      if (affinity === "text") throw wrong("a number");
      return value;
    case "boolean":
      if (affinity === "text") throw wrong("true or false");
      return value ? 1 : 0;
    case "object":
      if (numeric) throw wrong("an object");
      return json(value);
    default:
      throw wrong(typeof value);
  }
}

export function createData(config: DataConfig) {
  const maxRows = config.maxRows ?? 1000;
  const raw = config.exec;
  // A UNIQUE, foreign key or CHECK failure says only that it failed: its message names the
  // columns, and the row one's value collided with may be someone else's.
  const exec: Exec = async (sql, params) => {
    try {
      return await raw(sql, params);
    } catch (e) {
      if (/constraint failed|constraint violation|SQLITE_CONSTRAINT/i.test(String((e as Error)?.message))) {
        throw new AccessError("conflict", "the row conflicts with another one, or with the table's own checks");
      }
      throw e;
    }
  };
  const tables = new Map<string, Table>();
  const parsed = new Map<string, Node | null>();

  async function table(name: string): Promise<Table> {
    if (!isName(name)) throw new AccessError("bad_name", name);
    let t = tables.get(name);
    if (!t) {
      const info = (await exec(`PRAGMA table_info(${quote(name)})`, [])) as { name: string; pk: number; type: string }[];
      if (!info.length) throw new AccessError("unknown_table", name);
      const key = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      t = { columns: info.map((c) => c.name), key: key.length ? key : ["rowid"], affinity: new Map(info.map((c) => [c.name, affinityOf(c.type ?? "")])) };
      tables.set(name, t);
    }
    return t;
  }

  function rule(name: string, rules: TableAccess, op: Operation): Node | null {
    const id = `${name}\0${op}`;
    if (!parsed.has(id)) {
      const src = op === "updateCheck" && rules.updateCheck === undefined ? rules.update : rules[op];
      parsed.set(id, src === undefined || src === null ? null : parseRule(src));
    }
    return parsed.get(id)!;
  }

  function open(auth: Auth | null, admin: boolean): Data {
    function rulesOf(name: string): TableAccess {
      if (!isName(name)) throw new AccessError("bad_name", name);
      if (admin) return {};
      const r = Object.hasOwn(config.access.tables ?? {}, name) ? config.access.tables[name] : undefined;
      if (!r) throw new AccessError("unknown_table", name);
      return r;
    }

    // Every column one writes in has to exist; a person's may not be hidden, and when
    // written, not readonly.
    function columnsFor(name: string, t: Table, rules: TableAccess, cols: string[], how: "read" | "write" | "create"): void {
      for (const c of cols) {
        // Only the table's own names, as written: never rowid, oid or _rowid_, which reach the
        // key (and hidden columns) under another name.
        if (!isName(c) || !t.columns.includes(c)) throw new AccessError("unknown_column", `${name}.${c}`);
        if (admin) continue;
        if (among(rules.hidden, c)) throw new AccessError("hidden_column", `${name}.${c}`);
        if (how === "read") continue;
        if (among(rules.readonly, c) || among(Object.keys(rules.fill ?? {}), c)) {
          throw new AccessError("readonly_column", `${name}.${c}`);
        }
        if (how === "write" && t.key.includes(c)) throw new AccessError("readonly_column", `${name}.${c}`);
      }
    }

    function visible(t: Table, rules: TableAccess): string[] {
      return t.columns.filter((c) => admin || !among(rules.hidden, c));
    }

    // A rule as SQL, for rows read from the table, or for rows about to be written.
    async function ruleSql(name: string, rules: TableAccess, op: Operation, row: (column: string) => Sql): Promise<Sql> {
      if (admin) return { sql: "1", params: [] };
      const node = rule(name, rules, op);
      if (!node) throw new AccessError("forbidden", `${op} on ${name}`);
      await preload(node);
      return compileRule(node, { auth, row, columns: (t) => (tables.get(t) ? new Set(tables.get(t)!.columns) : undefined) });
    }

    // exists() names other tables; know their columns before compiling.
    async function preload(node: Node): Promise<void> {
      if (node.k === "exists") {
        await table(node.table);
        await preload(node.where);
      } else if (node.k === "and" || node.k === "or") for (const i of node.items) await preload(i);
      else if (node.k === "not") await preload(node.x);
    }

    const fromTable = (name: string) => (column: string) => ({ sql: `${quote(name)}.${quote(column)}`, params: [] });

    function filterSql(name: string, t: Table, rules: TableAccess, f: Filter, depth = 0): Sql {
      if (depth > 8) throw new AccessError("bad_value", "filters nest too deep");
      if (f === null || typeof f !== "object" || Array.isArray(f)) throw new AccessError("bad_value", "a filter is an object");
      if ("or" in f || "and" in f) {
        const items = ("or" in f ? f.or : f.and).map((x) => filterSql(name, t, rules, x, depth + 1));
        if (!items.length) return { sql: "or" in f ? "0" : "1", params: [] };
        return { sql: `(${items.map((i) => i.sql).join("or" in f ? " OR " : " AND ")})`, params: items.flatMap((i) => i.params) };
      }
      if ("not" in f) {
        const x = filterSql(name, t, rules, f.not, depth + 1);
        return { sql: `(NOT coalesce(${x.sql}, 0))`, params: x.params };
      }
      columnsFor(name, t, rules, [f.column], "read");
      const col = `${quote(name)}.${quote(f.column)}`;
      const scalar = (v: unknown) => {
        if (v !== null && typeof v === "object") throw new AccessError("bad_value", `${f.column}: a value, not an object`);
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
          if (!Array.isArray(f.value)) throw new AccessError("bad_value", `${f.column}: in takes a list`);
          if (f.value.length > MAX_IN) throw new AccessError("too_many", `${f.column}: in takes at most ${MAX_IN}`);
          if (!f.value.length) return { sql: "0", params: [] };
          // One parameter for the whole list: D1 takes at most 100 in a statement.
          return { sql: `(${col} IN (SELECT value FROM json_each(?)))`, params: [json(f.value.map(scalar))] };
        }
        case "is": {
          if (f.value === null) return { sql: `(${col} IS NULL)`, params: [] };
          if (f.value === true || f.value === false) return { sql: `(${col} IS ?)`, params: [f.value ? 1 : 0] };
          throw new AccessError("bad_value", `${f.column}: is takes null, true or false`);
        }
        case "like":
        case "ilike": {
          if (typeof f.value !== "string") throw new AccessError("bad_value", `${f.column}: like takes text`);
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
          throw new AccessError("bad_value", `unknown filter ${String((f as { op: unknown }).op)}`);
      }
    }

    function whereSql(name: string, t: Table, rules: TableAccess, where: Filter[] | undefined): Sql {
      if (where !== undefined && !Array.isArray(where)) throw new AccessError("bad_value", "filters are a list");
      if (leaves(where ?? []) > MAX_FILTERS) throw new AccessError("too_many", `at most ${MAX_FILTERS} filters`);
      const parts = (where ?? []).map((f) => filterSql(name, t, rules, f));
      return { sql: parts.length ? parts.map((p) => p.sql).join(" AND ") : "1", params: parts.flatMap((p) => p.params) };
    }

    function and(...parts: Sql[]): Sql {
      return { sql: parts.map((p) => `coalesce(${p.sql}, 0)`).join(" AND "), params: parts.flatMap((p) => p.params) };
    }

    function selectList(name: string, cols: string[]): string {
      return cols.map((c) => `${quote(name)}.${quote(c)}`).join(", ");
    }

    function limitOf(n: number | undefined, fallback: number): number {
      if (n === undefined) return fallback;
      if (!Number.isInteger(n) || n < 0) throw new AccessError("bad_value", "limit");
      return Math.min(n, maxRows);
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
        if (!Number.isInteger(offset) || offset < 0) throw new AccessError("bad_value", "offset");
        return exec(
          `SELECT ${selectList(name, cols)} FROM ${quote(name)} WHERE ${where.sql}${order.length ? ` ORDER BY ${order.join(", ")}` : ""} LIMIT ? OFFSET ?`,
          [...where.params, limit, offset],
        );
      },

      async get(name, key, cols) {
        const rules = rulesOf(name);
        const t = await table(name);
        if (t.key.length !== 1) throw new AccessError("bad_value", `${name} has no single key`);
        const pick = cols?.length ? cols : visible(t, rules);
        columnsFor(name, t, rules, pick, "read");
        const where = and({ sql: `${quote(name)}.${quote(t.key[0]!)} = ?`, params: [bind(key)] }, await ruleSql(name, rules, "view", fromTable(name)));
        const rows = await exec(`SELECT ${selectList(name, pick)} FROM ${quote(name)} WHERE ${where.sql} LIMIT 1`, where.params);
        return rows[0] ?? null;
      },

      async create(name, input, options = {}) {
        const rules = rulesOf(name);
        const t = await table(name);
        const rows = Array.isArray(input) ? input : [input];
        if (!rows.length) return { count: 0, ...(options.returning ? { rows: [] } : {}) };
        if (rows.length > maxRows) throw new AccessError("too_many", `at most ${maxRows} rows`);
        for (const r of rows) if (r === null || typeof r !== "object" || Array.isArray(r)) throw new AccessError("bad_value", "a row is an object");
        // Every row has the same columns, as PostgREST does: a key one row lacks is null in it.
        const given = [...new Set(rows.flatMap((r) => Object.keys(r)))];
        columnsFor(name, t, rules, given, "create");
        const fill = admin ? {} : (rules.fill ?? {});
        for (const c of Object.keys(fill)) if (!t.columns.includes(c)) throw new AccessError("unknown_column", `${name}.${c}`);
        const cols = [...given, ...Object.keys(fill)];
        if (!cols.length) throw new AccessError("bad_value", "a row needs a column");
        const value = (r: Row, c: string) => (Object.hasOwn(fill, c) ? stored(t, c, auth?.[fill[c]!.slice(5)]) : stored(t, c, r[c]));
        // The rows go in as one JSON parameter (D1 takes at most 100), one array per row.
        const payload = json(rows.map((r) => cols.map((c) => value(r, c))));
        const vName = (c: string) => `"$v".${quote(`c_${c}`)}`;
        const fromNew = (c: string): Sql => (cols.includes(c) ? { sql: vName(c), params: [] } : { sql: "NULL", params: [] });
        const checks = [await ruleSql(name, rules, "create", fromNew)];
        if (options.returning) checks.push(await ruleSql(name, rules, "list", fromNew));
        const refused = and(...checks);
        const back = options.returning ? visible(t, rules) : [];
        const out = await exec(
          `WITH "$v" AS (SELECT ${cols.map((c, i) => `json_extract(value, '$[${i}]') AS ${quote(`c_${c}`)}`).join(", ")} FROM json_each(?)) ` +
            `INSERT OR ABORT INTO ${quote(name)} (${cols.map(quote).join(", ")}) ` +
            `SELECT ${cols.map(vName).join(", ")} FROM "$v" ` +
            `WHERE NOT EXISTS (SELECT 1 FROM "$v" WHERE NOT (${refused.sql})) ` +
            `RETURNING ${back.length ? back.map(quote).join(", ") : "1 AS _"}`,
          [payload, ...refused.params],
        );
        if (out.length !== rows.length) throw new AccessError("refused", `create on ${name}`);
        return { count: out.length, ...(options.returning ? { rows: out } : {}) };
      },

      async update(name, where, patch, options = {}) {
        const rules = rulesOf(name);
        const t = await table(name);
        if (!admin && !narrows(where)) throw new AccessError("filter_required", `update on ${name}`);
        if (patch === null || typeof patch !== "object" || Array.isArray(patch)) throw new AccessError("bad_value", "a patch is an object");
        const cols = Object.keys(patch);
        if (!cols.length) throw new AccessError("bad_value", "nothing to change");
        columnsFor(name, t, rules, cols, "write");
        const next = new Map(cols.map((c) => [c, stored(t, c, patch[c])]));
        const fromNew = (c: string): Sql => (next.has(c) ? { sql: "?", params: [next.get(c)] } : fromTable(name)(c));
        const parts = [
          whereSql(name, t, rules, where),
          await ruleSql(name, rules, "list", fromTable(name)),
          await ruleSql(name, rules, "update", fromTable(name)),
          await ruleSql(name, rules, "updateCheck", fromNew),
        ];
        if (options.returning) parts.push(await ruleSql(name, rules, "list", fromNew));
        const cond = and(...parts);
        const back = options.returning ? visible(t, rules) : [];
        const out = await exec(
          `UPDATE OR ABORT ${quote(name)} SET ${cols.map((c) => `${quote(c)} = ?`).join(", ")} WHERE ${cond.sql} ` +
            `RETURNING ${back.length ? back.map(quote).join(", ") : "1 AS _"}`,
          [...cols.map((c) => next.get(c)), ...cond.params],
        );
        return { count: out.length, ...(options.returning ? { rows: out } : {}) };
      },

      async delete(name, where, options = {}) {
        const rules = rulesOf(name);
        const t = await table(name);
        if (!admin && !narrows(where)) throw new AccessError("filter_required", `delete on ${name}`);
        const cond = and(
          whereSql(name, t, rules, where),
          await ruleSql(name, rules, "list", fromTable(name)),
          await ruleSql(name, rules, "delete", fromTable(name)),
        );
        const back = options.returning ? visible(t, rules) : [];
        const out = await exec(
          `DELETE FROM ${quote(name)} WHERE ${cond.sql} RETURNING ${back.length ? back.map(quote).join(", ") : "1 AS _"}`,
          cond.params,
        );
        return { count: out.length, ...(options.returning ? { rows: out } : {}) };
      },
    };
  }

  return {
    /** The data as this person may see it; null is signed out. */
    as: (auth: Auth | null): Data => open(auth, false),
    /** Everything, without rules: the project's own server code only. */
    admin: (): Data => open(null, true),
  };
}

export { AccessError, checkAccess, parseRule, type Access, type TableAccess } from "./access.ts";
