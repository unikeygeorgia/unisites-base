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
  /**
   * Every write's rows, after it is done, for Realtime (unisites-base/realtime): whole rows,
   * hidden columns too, so the room can check each person's rules. Writes through admin() too.
   */
  onChange?: (changes: Change[]) => void | Promise<void>;
};

/**
 * One row a write changed. `record` is the row after (INSERT, UPDATE), `old` the row before:
 * a DELETE's whole row, an UPDATE's key only (as Postgres sends it without REPLICA IDENTITY FULL).
 */
export type Change = { table: string; type: "INSERT" | "UPDATE" | "DELETE"; record: Row | null; old: Row | null; at: string };

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
  foreignKeys: { from: string; table: string; to: string | null }[];
};

/** A table as a person may see it: its columns (without hidden ones), key and foreign keys. */
export type Described = {
  columns: { name: string; type: string; affinity: string }[];
  key: string[];
  foreignKeys: { from: string; table: string; to: string }[];
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
  create(table: string, rows: Row | Row[], options?: { returning?: boolean }): Promise<{ count: number; rows?: Row[] }>;
  /** `one`: change at most one row, or none (supabase-js's single() on a change, as PostgREST does). */
  update(table: string, where: Filter[], patch: Row, options?: { returning?: boolean; one?: boolean }): Promise<{ count: number; rows?: Row[] }>;
  delete(table: string, where: Filter[], options?: { returning?: boolean; one?: boolean }): Promise<{ count: number; rows?: Row[] }>;
  /**
   * create(), and a row that collides with one already there changes it instead: create's rule on
   * every new row, and update's (with list and updateCheck) on each row it changes, as Postgres
   * does for INSERT ... ON CONFLICT DO UPDATE. A refused row writes nothing.
   */
  upsert(table: string, rows: Row | Row[], options?: Upsert): Promise<{ count: number; rows?: Row[] }>;
  describe(table: string): Promise<Described>;
  /**
   * The row as this person may see it (without hidden columns), or null when list's rule, or the
   * filters, keep it from them. The row need not be in the table: Realtime asks about a deleted one.
   */
  sees(table: string, row: Row, where?: Filter[]): Promise<Row | null>;
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
      const message = String((e as Error)?.message);
      if (/constraint failed|constraint violation|SQLITE_CONSTRAINT/i.test(message)) {
        throw new AccessError("conflict", "the row conflicts with another one, or with the table's own checks");
      }
      // REFUSED below: a rule that failed inside the statement stops all of it.
      if (/malformed JSON/i.test(message)) throw new AccessError("refused", "a row the rules do not allow");
      // MORE_THAN_ONE below.
      if (/integer overflow/i.test(message)) throw new AccessError("too_many", "more than one row");
      if (/does not match any PRIMARY KEY or UNIQUE/i.test(message)) throw new AccessError("bad_value", "on conflict names no key or UNIQUE index");
      throw e;
    }
  };
  const tables = new Map<string, Table>();
  const parsed = new Map<string, Node | null>();

  async function table(name: string): Promise<Table> {
    if (!isName(name)) throw new AccessError("bad_name", name);
    let t = tables.get(name);
    if (!t) {
      const info = (await exec(`PRAGMA table_info(${quote(name)})`, [])) as { name: string; pk: number; type: string; dflt_value: string | null }[];
      if (!info.length) throw new AccessError("unknown_table", name);
      const key = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      const fks = (await exec(`PRAGMA foreign_key_list(${quote(name)})`, [])) as { id: number; table: string; from: string; to: string | null }[];
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

    const fromTable = (name: string) => (column: string): Sql => ({ sql: `${quote(name)}.${quote(column)}`, params: [] });

    // ref: where a column's value is; the table's row, or a row given as parameters (sees()).
    function filterSql(name: string, t: Table, rules: TableAccess, f: Filter, depth = 0, ref = fromTable(name)): Sql {
      if (depth > 8) throw new AccessError("bad_value", "filters nest too deep");
      if (f === null || typeof f !== "object" || Array.isArray(f)) throw new AccessError("bad_value", "a filter is an object");
      if ("or" in f || "and" in f) {
        const items = ("or" in f ? f.or : f.and).map((x) => filterSql(name, t, rules, x, depth + 1, ref));
        if (!items.length) return { sql: "or" in f ? "0" : "1", params: [] };
        return { sql: `(${items.map((i) => i.sql).join("or" in f ? " OR " : " AND ")})`, params: items.flatMap((i) => i.params) };
      }
      if ("not" in f) {
        const x = filterSql(name, t, rules, f.not, depth + 1, ref);
        return { sql: `(NOT coalesce(${x.sql}, 0))`, params: x.params };
      }
      columnsFor(name, t, rules, [f.column], "read");
      const c = ref(f.column);
      const col = c.sql;
      const at = (sql: string, params: unknown[] = []): Sql => ({ sql, params: [...c.params, ...params] });
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
          return at(`(${col} ${op} ?)`, [scalar(f.value)]);
        }
        case "in": {
          if (!Array.isArray(f.value)) throw new AccessError("bad_value", `${f.column}: in takes a list`);
          if (f.value.length > MAX_IN) throw new AccessError("too_many", `${f.column}: in takes at most ${MAX_IN}`);
          if (!f.value.length) return { sql: "0", params: [] };
          // One parameter for the whole list: D1 takes at most 100 in a statement.
          return at(`(${col} IN (SELECT value FROM json_each(?)))`, [json(f.value.map(scalar))]);
        }
        case "is": {
          if (f.value === null) return at(`(${col} IS NULL)`);
          if (f.value === true || f.value === false) return at(`(${col} IS ?)`, [f.value ? 1 : 0]);
          throw new AccessError("bad_value", `${f.column}: is takes null, true or false`);
        }
        case "like":
        case "ilike": {
          if (typeof f.value !== "string") throw new AccessError("bad_value", `${f.column}: like takes text`);
          // PostgREST's patterns: % or * any text, _ one character. like is case-sensitive (GLOB),
          // ilike is not (LIKE, for ASCII; Georgian has no case).
          if (f.op === "like") {
            const glob = [...f.value].map((ch) => (ch === "%" || ch === "*" ? "*" : ch === "_" ? "?" : /[[\]?]/.test(ch) ? `[${ch}]` : ch)).join("");
            return at(`(${col} GLOB ?)`, [glob]);
          }
          const like = [...f.value].map((ch) => (ch === "*" ? "%" : ch === "\\" ? "\\\\" : ch)).join("");
          return at(`(${col} LIKE ? ESCAPE '\\')`, [like]);
        }
        default:
          throw new AccessError("bad_value", `unknown filter ${String((f as { op: unknown }).op)}`);
      }
    }

    function whereSql(name: string, t: Table, rules: TableAccess, where: Filter[] | undefined, ref = fromTable(name)): Sql {
      if (where !== undefined && !Array.isArray(where)) throw new AccessError("bad_value", "filters are a list");
      if (leaves(where ?? []) > MAX_FILTERS) throw new AccessError("too_many", `at most ${MAX_FILTERS} filters`);
      const parts = (where ?? []).map((f) => filterSql(name, t, rules, f, 0, ref));
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

    // A failed check inside the statement: json() of text that is not JSON stops the statement,
    // and SQLite undoes all of it (exec turns the error into "refused"). The text depends on the
    // row, so SQLite never works it out once ahead of the rows.
    const REFUSED = (row: string) => `json('refused:' || typeof(${row}))`;

    // A change of more than one row stops the statement before it changes any: the count is
    // worked out once, at the first row, and abs() of the smallest integer is an error.
    function moreThanOne(name: string, t: Table, cond: Sql): Sql {
      const row = `${quote(name)}.${quote(t.columns[0]!)}`;
      return {
        sql: `(CASE WHEN (SELECT count(*) FROM ${quote(name)} WHERE ${cond.sql}) > 1 THEN abs(CASE WHEN typeof(${row}) IS NULL THEN 0 ELSE -9223372036854775807 - 1 END) ELSE 1 END)`,
        params: cond.params,
      };
    }

    const pick = (row: Row, cols: string[]): Row => Object.fromEntries(cols.map((c) => [c, row[c] ?? null]));

    // What a statement returns: the caller's columns, or every column when Realtime wants the rows.
    function returned(t: Table, rules: TableAccess, returning: boolean | undefined): { sql: string; cols: string[] } {
      const cols = config.onChange ? t.columns : returning ? visible(t, rules) : [];
      return { sql: cols.length ? cols.map(quote).join(", ") : "1 AS _", cols: returning ? visible(t, rules) : [] };
    }

    async function emit(changes: Change[]): Promise<void> {
      if (!config.onChange || !changes.length) return;
      try {
        await config.onChange(changes);
      } catch (e) {
        // The write is done; a room that could not be told must not undo it in the caller's eyes.
        console.error("onChange:", e);
      }
    }

    async function insert(name: string, input: Row | Row[], options: { returning?: boolean }, conflict?: Upsert) {
      const rules = rulesOf(name);
      const t = await table(name);
      const rows = Array.isArray(input) ? input : [input];
      if (!rows.length) return { count: 0, ...(options.returning ? { rows: [] } : {}) };
      if (rows.length > maxRows) throw new AccessError("too_many", `at most ${maxRows} rows`);
      for (const r of rows) if (r === null || typeof r !== "object" || Array.isArray(r)) throw new AccessError("bad_value", "a row is an object");
      const given = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      columnsFor(name, t, rules, given, "create");
      const fill = admin ? {} : (rules.fill ?? {});
      for (const c of Object.keys(fill)) if (!t.columns.includes(c)) throw new AccessError("unknown_column", `${name}.${c}`);
      if (!given.length && !Object.keys(fill).length) throw new AccessError("bad_value", "a row needs a column");
      // Every column with a default goes in too, worked out once ("$v" is MATERIALIZED), so the
      // rules see the value the table keeps and not a NULL it never stores.
      const named = [...given, ...Object.keys(fill)];
      const cols = [...named, ...t.columns.filter((c) => t.defaults.get(c) != null && !named.includes(c))];
      // The rows go in as one JSON parameter (D1 takes at most 100), an object per row. A column
      // one row leaves out takes the column's default in it, and the rules see that default.
      const payload = json(
        rows.map((r) => {
          const o: Row = {};
          for (const c of given) if (Object.hasOwn(r, c) && r[c] !== undefined) o[c] = stored(t, c, r[c]);
          for (const [c, from] of Object.entries(fill)) o[c] = stored(t, c, auth?.[from.slice(5)]);
          return o;
        }),
      );
      const picked = (c: string) =>
        `CASE WHEN json_type(value, '$.${c}') IS NULL THEN ${t.defaults.get(c) ?? "NULL"} ELSE json_extract(value, '$.${c}') END AS ${quote(`c_${c}`)}`;
      const vName = (c: string) => `"$v".${quote(`c_${c}`)}`;
      const fromNew = (c: string): Sql => (cols.includes(c) ? { sql: vName(c), params: [] } : { sql: "NULL", params: [] });
      const checks = [await ruleSql(name, rules, "create", fromNew)];
      if (options.returning) checks.push(await ruleSql(name, rules, "list", fromNew));
      const allowed = and(...checks);

      let onConflict = "";
      let changed: unknown[] = [];
      let target: string[] = [];
      if (conflict) {
        target = conflict.onConflict?.length ? conflict.onConflict : t.key;
        if (target.includes("rowid")) throw new AccessError("bad_value", `${name} has no key; name the columns it may collide on`);
        columnsFor(name, t, rules, target, "read");
        if (conflict.ignoreDuplicates) onConflict = ` ON CONFLICT (${target.map(quote).join(", ")}) DO NOTHING`;
        else {
          // A colliding row is changed as update() would: never its key, nor what fill set.
          const set = given.filter((c) => !target.includes(c) && !t.key.includes(c));
          const sets = set.length ? set : [target[0]!];
          const excluded = (c: string): Sql => (set.includes(c) ? { sql: `excluded.${quote(c)}`, params: [] } : fromTable(name)(c));
          const parts = [
            await ruleSql(name, rules, "list", fromTable(name)),
            await ruleSql(name, rules, "update", fromTable(name)),
            await ruleSql(name, rules, "updateCheck", excluded),
          ];
          if (options.returning) parts.push(await ruleSql(name, rules, "list", excluded));
          const cond = and(...parts);
          onConflict =
            ` ON CONFLICT (${target.map(quote).join(", ")}) DO UPDATE SET ${sets.map((c) => `${quote(c)} = excluded.${quote(c)}`).join(", ")}` +
            ` WHERE CASE WHEN ${cond.sql} THEN 1 ELSE ${REFUSED(`excluded.${quote(target[0]!)}`)} END`;
          changed = cond.params;
        }
      }

      // Which rows an upsert will change rather than add, for Realtime's INSERT or UPDATE. Read
      // before the write, so a row added between the two is called an UPDATE: only the label.
      let existed = new Set<string>();
      if (config.onChange && conflict && !conflict.ignoreDuplicates) {
        const keys = json(rows.map((r) => target.map((c) => stored(t, c, r[c]))));
        // A join on the key, so its index is used rather than every row read.
        const found = await exec(
          `SELECT ${target.map((c) => `${quote(name)}.${quote(c)}`).join(", ")} FROM json_each(?) AS "$k" JOIN ${quote(name)} ON ` +
            target.map((c, i) => `${quote(name)}.${quote(c)} = json_extract("$k".value, '$[${i}]')`).join(" AND "),
          [keys],
        );
        existed = new Set(found.map((f) => JSON.stringify(target.map((c) => f[c]))));
      }

      const back = returned(t, rules, options.returning);
      const out = await exec(
        `WITH "$v" AS MATERIALIZED (SELECT ${cols.map(picked).join(", ")} FROM json_each(?)) ` +
          `INSERT OR ABORT INTO ${quote(name)} (${cols.map(quote).join(", ")}) ` +
          `SELECT ${cols.map(vName).join(", ")} FROM "$v" ` +
          `WHERE CASE WHEN NOT EXISTS (SELECT 1 FROM "$v" WHERE NOT (${allowed.sql})) THEN 1 ELSE ${REFUSED(vName(cols[0]!))} END` +
          `${onConflict} RETURNING ${back.sql}`,
        [payload, ...allowed.params, ...changed],
      );
      if (!conflict?.ignoreDuplicates && out.length !== rows.length) throw new AccessError("refused", `create on ${name}`);
      const at = new Date().toISOString();
      await emit(
        out.map((r) =>
          existed.has(JSON.stringify(target.map((c) => r[c])))
            ? { table: name, type: "UPDATE" as const, record: r, old: pick(r, t.key.filter((k) => k !== "rowid")), at }
            : { table: name, type: "INSERT" as const, record: r, old: null, at },
        ),
      );
      return { count: out.length, ...(options.returning ? { rows: out.map((r) => pick(r, back.cols)) } : {}) };
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
        const keyOf = async (other: string) => (await table(other)).key;
        const foreignKeys = [];
        for (const f of t.foreignKeys) {
          if (!shown.includes(f.from)) continue;
          const to = f.to ?? (await keyOf(f.table))[0];
          if (to && isName(f.table)) foreignKeys.push({ from: f.from, table: f.table, to });
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
        if (options.one) parts.push(moreThanOne(name, t, and(...parts)));
        const cond = and(...parts);
        const back = returned(t, rules, options.returning);
        const out = await exec(
          `UPDATE OR ABORT ${quote(name)} SET ${cols.map((c) => `${quote(c)} = ?`).join(", ")} WHERE ${cond.sql} RETURNING ${back.sql}`,
          [...cols.map((c) => next.get(c)), ...cond.params],
        );
        const at = new Date().toISOString();
        await emit(out.map((r) => ({ table: name, type: "UPDATE" as const, record: r, old: pick(r, t.key.filter((k) => k !== "rowid")), at })));
        return { count: out.length, ...(options.returning ? { rows: out.map((r) => pick(r, back.cols)) } : {}) };
      },

      async delete(name, where, options = {}) {
        const rules = rulesOf(name);
        const t = await table(name);
        if (!admin && !narrows(where)) throw new AccessError("filter_required", `delete on ${name}`);
        const parts = [
          whereSql(name, t, rules, where),
          await ruleSql(name, rules, "list", fromTable(name)),
          await ruleSql(name, rules, "delete", fromTable(name)),
        ];
        if (options.one) parts.push(moreThanOne(name, t, and(...parts)));
        const cond = and(...parts);
        const back = returned(t, rules, options.returning);
        const out = await exec(`DELETE FROM ${quote(name)} WHERE ${cond.sql} RETURNING ${back.sql}`, cond.params);
        const at = new Date().toISOString();
        await emit(out.map((r) => ({ table: name, type: "DELETE" as const, record: null, old: r, at })));
        return { count: out.length, ...(options.returning ? { rows: out.map((r) => pick(r, back.cols)) } : {}) };
      },

      async sees(name, row, where) {
        const rules = rulesOf(name);
        const t = await table(name);
        if (row === null || typeof row !== "object") return null;
        // The row's values as parameters, with the column's affinity, so that a rule compares them
        // as it compares the stored column in list() (a bare parameter has none: 7 = '7' is false).
        const fromRow = (c: string): Sql => {
          const v = t.columns.includes(c) && Object.hasOwn(row, c) ? bind(row[c]) : null;
          const a = t.affinity.get(c);
          if (typeof v === "number" && (a === "integer" || a === "real" || a === "numeric")) return { sql: "CAST(? AS NUMERIC)", params: [v] };
          if (typeof v === "string" && a === "text") return { sql: "CAST(? AS TEXT)", params: [v] };
          return { sql: "?", params: [v] };
        };
        const cond = and(whereSql(name, t, rules, where, fromRow), await ruleSql(name, rules, "list", fromRow));
        const ok = await exec(`SELECT 1 AS ok WHERE ${cond.sql}`, cond.params);
        return ok.length ? pick(row, visible(t, rules)) : null;
      },
    };
  }

  return {
    /** The data as this person may see it; null is signed out. */
    as: (auth: Auth | null): Data => open(auth, false),
    /** Everything, without rules: the project's own server code only. */
    admin: (): Data => open(null, true),
    /** Most rows one list returns. */
    maxRows,
  };
}

export { AccessError, checkAccess, parseRule, type Access, type TableAccess } from "./access.ts";
