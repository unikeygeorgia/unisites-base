import { isName } from "../access.ts";
import type { Column, PgFunction, Policy, Table } from "./catalog.ts";
import { type E, type Select, Unsupported, parseExpr, parseSelect } from "./pg.ts";

// ── Postgres policies → access.json's rules ─────────────────────────────

/**
 * A rule, before it is written out: a column of the policy's own row (pcol), of a subquery's
 * table at a depth (icol), the session's field, a value, and what holds them.
 */
type R =
  | { k: "pcol"; c: string }
  | { k: "icol"; d: number; c: string }
  | { k: "auth"; f: string }
  | { k: "lit"; v: string | number | boolean | null }
  | { k: "cmp"; op: string; l: R; r: R }
  | { k: "and" | "or"; items: R[] }
  | { k: "not"; x: R }
  | { k: "in"; l: R; items: R[] }
  | { k: "exists"; table: string; d: number; where: R }
  | { k: "now" };

/** An argument of an inlined function: already a rule, in the caller's scope. */
type Bound = { k: "bound"; r: R };

/** raw: inside a SECURITY DEFINER function's body, where the tables are read without their RLS. */
type Scope = { table: string; alias?: string; d: number };
type Body = Select & { definer?: boolean };

export type RuleContext = {
  tables: Map<string, Table>;
  /** The public schema's policies. */
  policies: Policy[];
  functions: PgFunction[];
  /** Function names inlined, for the report. */
  inlined?: Set<string>;
  /** What came out narrower than Postgres (never wider), for the report. */
  narrower?: Set<string>;
};

const TRUE: R = { k: "lit", v: true };
const FALSE: R = { k: "lit", v: false };
const SIGNED_IN: R = { k: "cmp", op: "!=", l: { k: "auth", f: "id" }, r: { k: "lit", v: null } };
const SIGNED_OUT: R = { k: "cmp", op: "=", l: { k: "auth", f: "id" }, r: { k: "lit", v: null } };

function and(items: R[]): R {
  if (items.some((i) => i.k === "lit" && i.v === false)) return FALSE;
  const kept = items.filter((i) => !(i.k === "lit" && i.v === true));
  return kept.length === 0 ? TRUE : kept.length === 1 ? kept[0]! : { k: "and", items: kept };
}

function or(items: R[]): R {
  if (items.some((i) => i.k === "lit" && i.v === true)) return TRUE;
  const kept = items.filter((i) => !(i.k === "lit" && i.v === false));
  return kept.length === 0 ? FALSE : kept.length === 1 ? kept[0]! : { k: "or", items: kept };
}

/** Postgres' kinds of types, to know whether dropping a cast changes a comparison. */
function family(type: string): string {
  const t = type.replace(/\[\]$/, "");
  if (/^(text|varchar|character varying|character|char|bpchar|name|uuid|citext)$/.test(t)) return "text";
  if (/^(int2|int4|int8|smallint|integer|int|bigint|numeric|decimal|real|double precision|float4|float8)$/.test(t)) return "number";
  if (/^(bool|boolean)$/.test(t)) return "bool";
  if (/^(json|jsonb)$/.test(t)) return "json";
  if (/^(timestamptz|timestamp|timestamp with time zone|timestamp without time zone|date)$/.test(t)) return "time";
  return t;
}

const COMMANDS = { list: ["SELECT", "ALL"], create: ["INSERT", "ALL"], update: ["UPDATE", "ALL"], delete: ["DELETE", "ALL"] } as const;
type Op = keyof typeof COMMANDS;
const PRIVILEGE = { list: "select", create: "insert", update: "update", delete: "delete" } as const;

class Translator {
  depth = 0;
  /** Tables whose policies are being read, against a policy that reads its own table back. */
  open: string[] = [];
  constructor(
    readonly ctx: RuleContext,
    readonly fail: (what: string) => void,
  ) {}

  columns(table: string): Column[] | undefined {
    return this.ctx.tables.get(table)?.columns;
  }

  col(path: string[], scopes: Scope[]): R {
    const c = path[path.length - 1]!;
    const q = path.length >= 2 ? path[path.length - 2]! : undefined;
    for (let i = scopes.length - 1; i >= 0; i--) {
      const s = scopes[i]!;
      // An aliased table is known by its alias only, as in Postgres.
      const match = q ? q === (s.alias ?? s.table) : !!this.columns(s.table)?.some((x) => x.name === c);
      if (match) {
        if (!this.columns(s.table)?.some((x) => x.name === c)) throw new Unsupported(`${s.table}.${c}, which is not a column`);
        return s.d === 0 ? { k: "pcol", c } : { k: "icol", d: s.d, c };
      }
    }
    throw new Unsupported(`"${path.join(".")}", which is no column of ${scopes.map((s) => s.table).join(" or ")}`);
  }

  typeOf(path: string[], scopes: Scope[]): string | undefined {
    const c = path[path.length - 1]!;
    const q = path.length >= 2 ? path[path.length - 2]! : undefined;
    for (let i = scopes.length - 1; i >= 0; i--) {
      const s = scopes[i]!;
      const col = this.columns(s.table)?.find((x) => x.name === c);
      if (q ? q === (s.alias ?? s.table) : col) return col?.category === "A" ? `${col.udt.replace(/^_/, "")}[]` : col?.udt;
    }
    return undefined;
  }

  function(name: string[]): PgFunction | undefined {
    const plain = name.length === 2 && name[0] === "public" ? name[1] : name.length === 1 ? name[0] : undefined;
    if (!plain) return undefined;
    const all = this.ctx.functions.filter((f) => f.name === plain);
    if (all.length > 1) throw new Unsupported(`${plain}(), which has more than one form`);
    return all[0]?.language === "sql" ? all[0] : undefined;
  }

  /** A SQL function's SELECT, with its arguments put in as rules of the caller's scope. */
  body(f: PgFunction, args: E[], scopes: Scope[]): Body {
    if (++this.depth > 8) throw new Unsupported(`${f.name}() calling itself`);
    const names = (f.argnames ?? []).slice(0, args.length);
    if ((f.argnames?.length ?? 0) > args.length || /\bdefault\b/i.test(f.arguments)) throw new Unsupported(`${f.name}() with an argument left to its default`);
    const bound = args.map((a) => ({ k: "bound", r: this.val(a, scopes) }) as Bound);
    let s: Select;
    try {
      s = parseSelect(f.source);
    } catch (err) {
      throw new Unsupported(`${f.name}()'s body: ${(err as Error).message}`);
    }
    // In a SQL function a column wins over an argument of the same name.
    const tables = new Set<string>();
    const collect = (x: Select) => {
      if (x.from) tables.add(x.from.table);
      x.items.forEach((i) => walkE(i.e, collect));
      if (x.where) walkE(x.where, collect);
    };
    collect(s);
    const isColumn = (n: string) => [...tables].some((t) => this.columns(t)?.some((c) => c.name === n));
    const sub = (e: E): E => {
      if (e.k === "col") {
        const arg = e.path.length === 1 ? e.path[0]! : e.path.length === 2 && e.path[0] === f.name ? e.path[1]! : undefined;
        if (arg !== undefined) {
          const n = /^\$(\d+)$/.exec(arg);
          if (n && bound[Number(n[1]) - 1]) return bound[Number(n[1]) - 1] as unknown as E;
          const i = names.indexOf(arg);
          if (i >= 0 && (e.path.length === 2 || !isColumn(arg))) return bound[i] as unknown as E;
        }
      }
      return mapE(e, sub);
    };
    this.ctx.inlined?.add(f.name);
    const out: Body = { ...mapSelect(s, sub), definer: f.definer };
    return f.definer ? markDefiner(out) : out;
  }

  /**
   * A subquery's table: under its own policies and grants, as Postgres reads it, unless the
   * subquery is inside a SECURITY DEFINER function's body (read as the owner, without RLS).
   */
  enter(s: Body, scopes: Scope[]): { inner: Scope[]; guard: R } {
    if (!s.from) throw new Unsupported("a subquery without FROM");
    if (s.from.schema && s.from.schema !== "public") throw new Unsupported(`the table ${s.from.schema}.${s.from.table}`);
    const t = this.ctx.tables.get(s.from.table);
    if (!t) throw new Unsupported(`the table ${s.from.table}, which is not served`);
    // One deeper than the scope it is in: a table's own policies start at its depth, not at 0.
    const d = (scopes.at(-1)?.d ?? -1) + 1;
    const inner = [...scopes, { table: s.from.table, alias: s.from.alias, d }];
    if (s.definer) return { inner, guard: TRUE };
    const rule = this.rule(t.name, "list", d);
    return { inner, guard: rule ?? FALSE };
  }

  /**
   * One command's rule for a table at a depth (0: the policy's own table), as Postgres applies
   * its policies: OR of the permissive ones for the person's role, AND of the restrictive ones,
   * and the role's grant on the table. null: closed.
   */
  rule(table: string, op: Op, d: number, which: "using" | "check" = op === "create" ? "check" : "using"): R | null {
    const t = this.ctx.tables.get(table)!;
    const grant = this.grant(t, op);
    if (grant === null) return null;
    if (!t.rls) return grant;
    // A table's policies that read the same table under the same command again never end.
    const key = `${table}\0${op}`;
    if (this.open.includes(key)) throw new Unsupported(`${table}'s policies read ${table} again (Postgres stops that as infinite recursion)`);
    this.open.push(key);
    try {
      const ps = this.ctx.policies.filter((p) => p.table === table && (COMMANDS[op] as readonly string[]).includes(p.command));
      const permissive: R[] = [];
      const restrictive: R[] = [];
      for (const p of ps) {
        const anon = p.roles.includes("public") || p.roles.includes("anon");
        const authed = p.roles.includes("public") || p.roles.includes("authenticated");
        if (!anon && !authed) {
          if (d === 0) this.ctx.narrower?.add(`${p.name} is for ${p.roles.join(", ")}: the browser never had it (the server's admin() has all)`);
          continue;
        }
        const sql = which === "check" ? (p.check ?? (p.command === "INSERT" ? null : p.using)) : p.using;
        let r: R;
        if (sql === null) {
          if (p.permissive === "PERMISSIVE") continue;
          throw new Unsupported(`the restrictive ${p.name} without ${which === "check" ? "WITH CHECK" : "USING"}`);
        }
        try {
          r = this.bool(parseExpr(sql), [{ table, d }]);
        } catch (e) {
          if (p.permissive === "RESTRICTIVE") throw e;
          // A permissive policy left out only lets fewer in.
          this.fail(`${p.name} (${which === "check" ? "WITH CHECK" : "USING"}): ${(e as Error).message} — ${sql.replace(/\s+/g, " ")}`);
          continue;
        }
        if (p.permissive === "PERMISSIVE") permissive.push(anon && authed ? r : and([anon ? SIGNED_OUT : SIGNED_IN, r]));
        // A restrictive policy for one role does not hold back the other.
        else restrictive.push(anon && authed ? r : or([anon ? SIGNED_IN : SIGNED_OUT, r]));
      }
      if (!permissive.length) return null;
      return and([grant, or(permissive), ...restrictive]);
    } finally {
      this.open.pop();
    }
  }

  /** Who of the browser's roles has the table's grant for a command: a column grant counts too. */
  grant(t: Table, op: Op): R | null {
    const has = (role: "anon" | "authenticated") => {
      if (t.privileges?.[role]?.[PRIVILEGE[op]]) return true;
      if (op === "create" || op === "update") return t.columns.some((c) => c.grants[role]?.[op === "create" ? "insert" : "update"]);
      if (op === "list") return t.columns.some((c) => c.grants[role]?.select);
      return false;
    };
    const anon = has("anon");
    const authed = has("authenticated");
    if (anon && authed) return TRUE;
    if (authed) return SIGNED_IN;
    if (anon) return SIGNED_OUT;
    return null;
  }

  /** `(SELECT flag FROM t WHERE …)` where a yes or no is asked: there is such a row, and its flag is true. */
  scalarSub(s: Body, scopes: Scope[]): R {
    const { inner, guard } = this.enter(s, scopes);
    if (s.items.length !== 1) throw new Unsupported("a subquery of more than one column");
    if (!this.unique(s)) this.ctx.narrower?.add(`(SELECT … FROM ${s.from!.table}) may find two rows, where Postgres stops with an error; the draft lets in if any is true`);
    return { k: "exists", table: s.from!.table, d: inner.at(-1)!.d, where: and([guard, this.bool(s.items[0]!.e, inner), s.where ? this.bool(s.where, inner) : TRUE]) };
  }

  /** Whether a subquery's WHERE pins a key or UNIQUE column with =, so it finds one row at most. */
  unique(s: Select): boolean {
    const t = this.ctx.tables.get(s.from!.table);
    const keys = (t?.constraints ?? []).filter((k) => (k.type === "p" || k.type === "u") && k.columns?.length === 1).map((k) => k.columns![0]!);
    const pinned = (e: E | undefined): boolean =>
      !!e &&
      ((e.k === "and" && e.items.some(pinned)) ||
        (e.k === "bin" && e.op === "=" && [e.l, e.r].some((x) => x.k === "col" && keys.includes(x.path[x.path.length - 1]!))));
    return pinned(s.where);
  }

  /**
   * Whether Postgres may answer NULL where the translation answers false: a subquery or a SQL
   * function made into exists(). Under NOT that would let in whom Postgres keeps out.
   */
  mayBeNull(e: E): boolean {
    if ((e as unknown as Bound).k === "bound") return false;
    switch (e.k) {
      case "sub":
      case "insub":
        return true;
      case "any":
        return e.arr.k === "sub" || this.mayBeNull(e.x);
      case "exists":
      case "lit":
      case "col":
        return false;
      case "fn": {
        const name = e.name.join(".");
        if (name.startsWith("auth.")) return false;
        if ((name === "coalesce" || name === "pg_catalog.coalesce") && e.args.at(-1)?.k === "lit" && (e.args.at(-1) as { v: unknown }).v !== null) return false;
        const f = this.function(e.name);
        if (!f) return true;
        const s = parseSelect(f.source);
        return !!s.from || s.items.some((i) => this.mayBeNull(i.e));
      }
      default: {
        let found = false;
        walkE(e, () => undefined, (x) => {
          if (x !== e && this.mayBeNull(x)) found = true;
        });
        return found;
      }
    }
  }

  fn(e: Extract<E, { k: "fn" }>, scopes: Scope[], bool: boolean): R {
    const name = e.name.join(".");
    if (name === "auth.uid") return { k: "auth", f: "id" };
    if (name === "auth.email") return { k: "auth", f: "email" };
    if (!bool && !e.args.length && ["now", "current_timestamp", "pg_catalog.now"].includes(name)) return { k: "now" };
    if ((name === "coalesce" || name === "pg_catalog.coalesce") && bool && e.args.length === 2) {
      const [a, last] = e.args as [E, E];
      if (last.k === "lit" && last.v === false) {
        // coalesce(flag, false): false, not NULL, when the flag is NULL.
        if (a.k === "col") return and([{ k: "cmp", op: "!=", l: this.col(a.path, scopes), r: { k: "lit", v: null } }, this.bool(a, scopes)]);
        return this.bool(a, scopes);
      }
    }
    const f = this.function(e.name);
    if (f && !f.set) {
      const body = this.body(f, e.args, scopes);
      if (!body.from && body.items.length === 1) return bool ? this.bool(body.items[0]!.e, scopes) : this.val(body.items[0]!.e, scopes);
      if (body.from && bool) return this.scalarSub(body, scopes);
    }
    throw new Unsupported(`the function ${name}()`);
  }

  bool(e: E, scopes: Scope[]): R {
    if ((e as unknown as Bound).k === "bound") return (e as unknown as Bound).r;
    switch (e.k) {
      case "lit":
        if (typeof e.v === "boolean") return e;
        throw new Unsupported("a value where a yes or no is asked");
      case "col":
        return { k: "cmp", op: "=", l: this.col(e.path, scopes), r: TRUE };
      case "cast":
        if (family(e.type) !== "bool") throw new Unsupported(`a cast to ${e.type} where a yes or no is asked`);
        return this.bool(e.x, scopes);
      case "and":
        return and(e.items.map((i) => this.bool(i, scopes)));
      case "or":
        return or(e.items.map((i) => this.bool(i, scopes)));
      case "not":
        if (this.mayBeNull(e.x)) throw new Unsupported("NOT over a subquery or function Postgres may answer with NULL");
        return { k: "not", x: this.bool(e.x, scopes) };
      case "isnull":
        return { k: "cmp", op: e.not ? "!=" : "=", l: this.val(e.x, scopes), r: { k: "lit", v: null } };
      case "is": {
        // IS TRUE and IS FALSE are false, not NULL, on NULL.
        const x = this.val(e.x, scopes);
        const r = and([{ k: "cmp", op: "!=", l: x, r: { k: "lit", v: null } }, { k: "cmp", op: "=", l: x, r: { k: "lit", v: e.v } }]);
        return e.not ? { k: "not", x: r } : r;
      }
      case "fn":
        return this.fn(e, scopes, true);
      case "bin":
        return this.cmp(e, scopes);
      case "between": {
        const r = and([
          { k: "cmp", op: ">=", l: this.val(e.x, scopes), r: this.val(e.lo, scopes) },
          { k: "cmp", op: "<=", l: this.val(e.x, scopes), r: this.val(e.hi, scopes) },
        ]);
        return e.not ? { k: "not", x: r } : r;
      }
      case "in": {
        const r: R = { k: "in", l: this.val(e.x, scopes), items: e.list.map((i) => this.lit(i)) };
        return e.not ? { k: "not", x: r } : r;
      }
      case "any": {
        if (e.op !== "=") throw new Unsupported(`${e.op} ANY (...)`);
        if (e.arr.k === "array") return { k: "in", l: this.val(e.x, scopes), items: e.arr.items.map((i) => this.lit(i)) };
        if (e.arr.k === "sub") return this.insub(e.x, e.arr.sub, scopes);
        throw new Unsupported("= ANY of something other than a list");
      }
      case "insub":
        if (e.not) throw new Unsupported("NOT IN (SELECT …), which a NULL makes NULL in Postgres");
        return this.insub(e.x, e.sub, scopes);
      case "exists": {
        const { inner, guard } = this.enter(e.sub, scopes);
        return { k: "exists", table: e.sub.from!.table, d: inner.at(-1)!.d, where: and([guard, e.sub.where ? this.bool(e.sub.where, inner) : TRUE]) };
      }
      case "sub":
        return this.scalarSub(e.sub, scopes);
      default:
        throw new Unsupported(`"${e.k}" where a yes or no is asked`);
    }
  }

  /** `x IN (SELECT y FROM t WHERE …)`, or `x IN (SELECT f())` of a SQL function returning a set. */
  insub(x: E, s: Body, scopes: Scope[]): R {
    const left = this.val(x, scopes);
    if (!s.from && s.items.length === 1 && s.items[0]!.e.k === "fn") {
      const call = s.items[0]!.e as Extract<E, { k: "fn" }>;
      const f = this.function(call.name);
      if (!f?.set) throw new Unsupported(`IN (SELECT ${call.name.join(".")}())`);
      return this.insub({ k: "bound", r: left } as unknown as E, this.body(f, call.args, scopes), scopes);
    }
    if (s.items.length !== 1) throw new Unsupported("IN of a subquery of more than one column");
    const { inner, guard } = this.enter(s, scopes);
    return {
      k: "exists",
      table: s.from!.table,
      d: inner.at(-1)!.d,
      where: and([guard, { k: "cmp", op: "=", l: this.val(s.items[0]!.e, inner), r: left }, s.where ? this.bool(s.where, inner) : TRUE]),
    };
  }

  cmp(e: Extract<E, { k: "bin" }>, scopes: Scope[]): R {
    if (!["=", "<>", "<", "<=", ">", ">="].includes(e.op)) throw new Unsupported(`the operator ${e.op}`);
    // auth.role() = 'authenticated': signed in.
    const role = (x: E) => x.k === "fn" && x.name.join(".") === "auth.role";
    if (role(e.l) || role(e.r)) {
      const v = unCast((role(e.l) ? e.r : e.l) as E);
      if (v.k !== "lit" || (e.op !== "=" && e.op !== "<>")) throw new Unsupported("auth.role() compared with something other than a name");
      const signedIn = v.v === "authenticated" ? true : v.v === "anon" ? false : null;
      if (signedIn === null) return { k: "lit", v: e.op === "<>" };
      return signedIn === (e.op === "=") ? SIGNED_IN : SIGNED_OUT;
    }
    // coalesce(x, 'a') = 'b': when x is NULL, 'a' = 'b' (worked out here); else x = 'b'.
    const co = (x: E) => x.k === "fn" && /^(pg_catalog\.)?coalesce$/.test(x.name.join(".")) && x.args.length === 2 && unCast(x.args[1]!).k === "lit";
    if (co(e.l) || co(e.r)) {
      const [c, other] = (co(e.l) ? [e.l, e.r] : [e.r, e.l]) as [Extract<E, { k: "fn" }>, E];
      const fallback = (unCast(c.args[1]!) as { v: unknown }).v;
      const v = unCast(other);
      if (v.k !== "lit" || v.v === null || fallback === null || typeof v.v !== typeof fallback) throw new Unsupported("coalesce() compared with something other than a value of its kind");
      const op = co(e.l) ? e.op : ({ "<": ">", "<=": ">=", ">": "<", ">=": "<=" } as Record<string, string>)[e.op] ?? e.op;
      const a = fallback as string | number | boolean;
      const b = v.v as string | number | boolean;
      const holds = { "=": a === b, "<>": a !== b, "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b }[op as "="];
      const x = this.val(c.args[0]!, scopes);
      const nul: R = { k: "lit", v: null };
      return or([
        and([{ k: "cmp", op: "=", l: x, r: nul }, { k: "lit", v: !!holds }]),
        and([{ k: "cmp", op: "!=", l: x, r: nul }, { k: "cmp", op: op === "<>" ? "!=" : op, l: x, r: v }]),
      ]);
    }
    // x = NULL is NULL in Postgres, not IS NULL.
    if (unCast(e.l).k === "lit" && (unCast(e.l) as { v: unknown }).v === null) throw new Unsupported("a comparison with NULL");
    if (unCast(e.r).k === "lit" && (unCast(e.r) as { v: unknown }).v === null) throw new Unsupported("a comparison with NULL");
    return { k: "cmp", op: e.op === "<>" ? "!=" : e.op, l: this.val(e.l, scopes), r: this.val(e.r, scopes) };
  }

  val(e: E, scopes: Scope[]): R {
    if ((e as unknown as Bound).k === "bound") return (e as unknown as Bound).r;
    switch (e.k) {
      case "lit":
        return e;
      case "col":
        return this.col(e.path, scopes);
      case "cast": {
        // A cast is dropped only where it changes nothing: a value, or a column of the same kind.
        const x = e.x;
        if (x.k === "lit") return x;
        if (x.k === "col") {
          const type = this.typeOf(x.path, scopes);
          if (!type || family(type) !== family(e.type)) throw new Unsupported(`a cast of ${x.path.join(".")} (${type ?? "?"}) to ${e.type}`);
          return this.col(x.path, scopes);
        }
        // A folder's text cast to uuid or text compares as the same text.
        if (family(e.type) === "text") return this.val(x, scopes);
        throw new Unsupported(`a cast to ${e.type}`);
      }
      case "index": {
        // storage.foldername(name)[n]: the file's n-th folder, storage_objects' folder1..3.
        const f = unCast(e.x);
        if (f.k === "fn" && f.name.join(".") === "storage.foldername" && f.args.length === 1 && unCast(f.args[0]!).k === "col" && e.i >= 1 && e.i <= 3) {
          return this.col([`folder${e.i}`], scopes);
        }
        throw new Unsupported("an array subscript other than storage.foldername(name)[1..3]");
      }
      case "fn":
        return this.fn(e, scopes, false);
      case "bin": {
        // auth.jwt() ->> 'email'
        const r = unCast(e.r);
        if (e.op === "->>" && e.l.k === "fn" && e.l.name.join(".") === "auth.jwt" && r.k === "lit") {
          if (r.v === "email") return { k: "auth", f: "email" };
          if (r.v === "sub") return { k: "auth", f: "id" };
        }
        throw new Unsupported(`the operator ${e.op}`);
      }
      default:
        throw new Unsupported(`"${e.k}" as a value`);
    }
  }

  lit(e: E): R {
    const x = unCast(e);
    if (x.k === "lit") return x;
    throw new Unsupported("a list of something other than values");
  }
}

const unCast = (e: E): E => (e.k === "cast" ? unCast(e.x) : e);

function mapSelect(x: Select, f: (e: E) => E): Select {
  return { ...x, items: x.items.map((i) => ({ ...i, e: f(i.e) })), where: x.where ? f(x.where) : undefined };
}

/** Every SELECT inside a SECURITY DEFINER body is read as its owner. */
function markDefiner(s: Body): Body {
  const mark = (e: E): E => {
    if (e.k === "exists" || e.k === "sub" || e.k === "insub") return { ...mapE(e, mark), sub: markDefiner(mapSelect(e.sub, mark)) } as E;
    if (e.k === "any" && e.arr.k === "sub") return { ...e, x: mark(e.x), arr: { k: "sub", sub: markDefiner(mapSelect(e.arr.sub, mark)) } };
    return mapE(e, mark);
  };
  return { ...mapSelect(s, mark), definer: true };
}

function mapE(e: E, f: (e: E) => E): E {
  const s = (x: Body): Body => ({ ...mapSelect(x, f), definer: x.definer });
  switch (e.k) {
    case "fn":
      return { ...e, args: e.args.map(f) };
    case "bin":
      return { ...e, l: f(e.l), r: f(e.r) };
    case "and":
    case "or":
      return { ...e, items: e.items.map(f) };
    case "not":
    case "neg":
    case "cast":
    case "index":
      return { ...e, x: f(e.x) };
    case "isnull":
    case "is":
      return { ...e, x: f(e.x) };
    case "in":
      return { ...e, x: f(e.x), list: e.list.map(f) };
    case "insub":
      return { ...e, x: f(e.x), sub: s(e.sub) };
    case "any":
      return { ...e, x: f(e.x), arr: f(e.arr) };
    case "array":
      return { ...e, items: e.items.map(f) };
    case "exists":
    case "sub":
      return { ...e, sub: s(e.sub) };
    case "between":
      return { ...e, x: f(e.x), lo: f(e.lo), hi: f(e.hi) };
    default:
      return e;
  }
}

/** Visits every expression under e (onExpr) and every SELECT (onSelect). */
function walkE(e: E, onSelect: (s: Select) => void, onExpr?: (e: E) => void): void {
  onExpr?.(e);
  mapE(e, (x) => {
    walkE(x, onSelect, onExpr);
    return x;
  });
  if (e.k === "exists" || e.k === "sub" || e.k === "insub") onSelect(e.sub);
  if (e.k === "any" && e.arr.k === "sub") onSelect(e.arr.sub);
}

function quoteRule(v: string | number | boolean | null): string {
  if (typeof v === "string") return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return String(v);
}

function name(n: string): string {
  if (!isName(n)) throw new Unsupported(`the name ${JSON.stringify(n)}, which access.json cannot write`);
  return n;
}

function print(r: R, d: number, top = false): string {
  switch (r.k) {
    case "pcol":
      return d > 0 ? `row.${name(r.c)}` : name(r.c);
    case "icol":
      if (r.d === d) return name(r.c);
      if (r.d === d - 1) return `up.${name(r.c)}`;
      throw new Unsupported("a column of a subquery two around the inner one (access.json reaches the row, its own table and the one around it)");
    case "now":
      return "now()";
    case "auth":
      return `auth.${name(r.f)}`;
    case "lit":
      return quoteRule(r.v);
    case "cmp":
      return `${print(r.l, d)} ${r.op} ${print(r.r, d)}`;
    case "in":
      return `${print(r.l, d)} in [${r.items.map((i) => print(i, d)).join(", ")}]`;
    case "not":
      return `!(${print(r.x, d, true)})`;
    case "and":
    case "or": {
      const s = r.items.map((i) => (i.k === "and" || i.k === "or" ? `(${print(i, d, true)})` : print(i, d))).join(r.k === "and" ? " && " : " || ");
      return top ? s : `(${s})`;
    }
    case "exists":
      return `exists(${name(r.table)}, ${print(r.where, r.d, true)})`;
  }
}

/**
 * A table's rule for one command, from its policies and grants, as access.json writes it: ""
 * lets everyone in, null is closed. fail() hears of each permissive policy left out.
 */
export function tableRule(table: string, op: Op, ctx: RuleContext, fail: (what: string) => void, which?: "using" | "check"): string | null {
  let r: R | null;
  try {
    r = new Translator(ctx, fail).rule(table, op, 0, which);
  } catch (e) {
    fail(`${op}: ${(e as Error).message}`);
    return null;
  }
  if (r === null || (r.k === "lit" && r.v === false)) return null;
  if (r.k === "lit" && r.v === true) return "";
  try {
    return print(r, 0, true);
  } catch (e) {
    fail(`${op}: ${(e as Error).message}`);
    return null;
  }
}

/** The browser's roles a command's policies and grants let in at all: whose column grants count. */
export function admitted(table: Table, op: Op, policies: Policy[]): ("anon" | "authenticated")[] {
  const t = new Translator({ tables: new Map([[table.name, table]]), policies, functions: [] }, () => undefined);
  const grant = t.grant(table, op);
  const ps = policies.filter((p) => p.table === table.name && p.permissive === "PERMISSIVE" && (COMMANDS[op] as readonly string[]).includes(p.command));
  const roles: ("anon" | "authenticated")[] = [];
  for (const role of ["anon", "authenticated"] as const) {
    const granted = grant !== null && !(grant === SIGNED_IN && role === "anon") && !(grant === SIGNED_OUT && role === "authenticated");
    if (granted && (!table.rls || ps.some((p) => p.roles.includes("public") || p.roles.includes(role)))) roles.push(role);
  }
  return roles;
}

/** One policy expression on its own, as a rule ("" when it lets everyone in); for tests. */
export function policyRule(table: string, sql: string, ctx: RuleContext): string {
  const r = new Translator(ctx, () => undefined).bool(parseExpr(sql), [{ table, d: 0 }]);
  return r.k === "lit" && r.v === true ? "" : print(r, 0, true);
}

// ── Postgres expressions → SQLite, for CHECK, indexes and defaults ───────

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";
/** A random UUID (version 4), as gen_random_uuid() makes one. */
export const UUID =
  "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || " +
  "substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))";

const quote = (n: string) => `"${n.replace(/"/g, '""')}"`;

function sqlLit(v: string | number | boolean | null): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

/** An expression in SQLite's SQL, over the table's own columns. */
export function toSqlite(e: E, columns: string[]): string {
  const w = (x: E) => toSqlite(x, columns);
  switch (e.k) {
    case "lit":
      return sqlLit(e.v);
    case "col": {
      const c = e.path[e.path.length - 1]!;
      if (!columns.includes(c)) throw new Unsupported(`"${e.path.join(".")}"`);
      return quote(c);
    }
    case "fn": {
      const name = e.name[e.name.length - 1]!;
      const args = e.args.map(w);
      if (["now", "current_timestamp", "localtimestamp", "transaction_timestamp", "statement_timestamp", "clock_timestamp"].includes(name) && !args.length) return NOW;
      if (name === "timezone" && e.args.length === 2 && e.args[1]!.k === "fn" && w(e.args[1]!) === NOW) return NOW;
      if (name === "current_date") return "(date('now'))";
      if (["gen_random_uuid", "uuid_generate_v4"].includes(name)) return UUID;
      const same: Record<string, string> = { lower: "lower", upper: "upper", length: "length", char_length: "length", character_length: "length", coalesce: "coalesce", abs: "abs", btrim: "trim", trim: "trim", round: "round" };
      if (same[name]) return `${same[name]}(${args.join(", ")})`;
      throw new Unsupported(`the function ${e.name.join(".")}()`);
    }
    case "bin": {
      const ops: Record<string, string> = { "=": "=", "<>": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">=", "~~": "LIKE", "~~*": "LIKE", "!~~": "NOT LIKE", "!~~*": "NOT LIKE", "||": "||", "+": "+", "-": "-", "*": "*", "/": "/", "%": "%" };
      if (!ops[e.op]) throw new Unsupported(`the operator ${e.op}`);
      return `(${w(e.l)} ${ops[e.op]} ${w(e.r)})`;
    }
    case "and":
    case "or":
      return `(${e.items.map(w).join(e.k === "and" ? " AND " : " OR ")})`;
    case "not":
      return `(NOT ${w(e.x)})`;
    case "neg":
      return `(-${w(e.x)})`;
    case "cast":
      return w(e.x);
    case "isnull":
      return `(${w(e.x)} IS ${e.not ? "NOT " : ""}NULL)`;
    case "is":
      return `(${w(e.x)} IS ${e.not ? "NOT " : ""}${e.v ? 1 : 0})`;
    case "in":
      return `(${w(e.x)} ${e.not ? "NOT " : ""}IN (${e.list.map(w).join(", ")}))`;
    case "any":
      if (e.op !== "=" || e.arr.k !== "array") throw new Unsupported(`${e.op} ANY (...)`);
      return `(${w(e.x)} IN (${e.arr.items.map(w).join(", ")}))`;
    case "between":
      return `(${w(e.x)} ${e.not ? "NOT " : ""}BETWEEN ${w(e.lo)} AND ${w(e.hi)})`;
    default:
      throw new Unsupported(`"${e.k}"`);
  }
}

// ── Columns ─────────────────────────────────────────────────────────────

export type Level = "auto" | "partial" | "manual";

export type ColumnPlan = {
  name: string;
  /** The SQLite declaration, without the column's name. */
  declaration: string;
  from: string;
  level: Level;
  notes: string[];
  /** fill: the session's field the column takes (a default of auth.uid()). */
  fill?: string;
  /** The column is the table's INTEGER PRIMARY KEY (identity or serial). */
  rowid?: boolean;
};

export function planColumn(c: Column, singleKey: boolean): ColumnPlan {
  const notes: string[] = [];
  let level: Level = "auto";
  const worse = (l: Level, note: string) => {
    notes.push(note);
    if (l === "manual" || (l === "partial" && level === "auto")) level = l;
  };
  let type: string;
  const udt = c.udt.replace(/^_/, "");
  if (c.category === "A") {
    type = "JSON TEXT";
    worse("partial", "an array becomes JSON text: contains/overlaps filters are not served yet");
  } else if (c.category === "E") {
    type = "TEXT";
  } else if (["uuid", "text", "varchar", "bpchar", "name", "citext", "inet", "cidr", "macaddr"].includes(udt)) {
    type = "TEXT";
    if (udt === "citext") worse("partial", "citext: comparisons are case-sensitive in SQLite unless written with lower()");
  } else if (["int2", "int4", "int8"].includes(udt)) {
    type = "INTEGER";
    if (udt === "int8") notes.push("bigint: JavaScript reads exactly up to 2^53");
  } else if (udt === "bool") type = "BOOLEAN";
  else if (["float4", "float8"].includes(udt)) type = "REAL";
  else if (udt === "numeric") {
    type = "REAL";
    worse("partial", `${c.type} becomes REAL: exact decimals (money) become binary floating point; keep cents as INTEGER if sums must be exact`);
  } else if (["json", "jsonb"].includes(udt)) type = "JSON TEXT";
  else if (["timestamptz", "timestamp", "date", "time", "timetz", "interval"].includes(udt)) {
    type = "TEXT";
    notes.push(`${c.type} as ISO text`);
  } else if (udt === "bytea") type = "BLOB";
  else if (["tsvector", "tsquery"].includes(udt)) {
    type = "TEXT";
    worse("manual", "full-text search (tsvector) has no counterpart yet: SQLite's FTS5 is a later step");
  } else {
    type = "TEXT";
    worse("manual", `the type ${c.type} has no counterpart`);
  }

  const plan: ColumnPlan = { name: c.name, declaration: type, from: c.type, level, notes };
  const parts = [type];
  // An identity or serial key is SQLite's own INTEGER PRIMARY KEY, which numbers itself.
  const serial = !!c.identity || /^nextval\(/.test(c.default ?? "");
  if (serial && type === "INTEGER" && singleKey) {
    plan.rowid = true;
    parts.push("PRIMARY KEY");
    if (c.identity === "a") notes.push("GENERATED ALWAYS: SQLite also takes a value given on create");
  } else {
    if (c.notnull) parts.push("NOT NULL");
    if (serial) worse("manual", "a sequence that is not the key: it numbers nothing in SQLite");
    else if (c.default !== null) {
      const d = defaultOf(c.default, type);
      if (d.fill) {
        plan.fill = d.fill;
        notes.push(`DEFAULT ${c.default} becomes fill: ${d.fill}`);
      } else if (d.sql !== null) parts.push(`DEFAULT ${d.sql}`);
      else worse("manual", `DEFAULT ${c.default} has no counterpart (${d.why})`);
    }
  }
  if (c.generated) worse("manual", "a generated column");
  if (c.category === "E" && c.enum?.length) parts.push(`CHECK (${quote(c.name)} IN (${c.enum.map(sqlLit).join(", ")}))`);
  plan.declaration = parts.join(" ");
  plan.level = level;
  return plan;
}

/** A column's default in SQLite, or the session's field it takes (fill). */
export function defaultOf(sql: string, type: string): { sql: string | null; fill?: string; why?: string } {
  let e: E;
  try {
    e = parseExpr(sql);
  } catch (err) {
    return { sql: null, why: (err as Error).message };
  }
  const array = e.k === "cast" && e.type.endsWith("[]");
  while (e.k === "cast") e = e.x;
  if (e.k === "fn" && e.name.join(".") === "auth.uid") return { sql: null, fill: "auth.id" };
  if (e.k === "lit") {
    // '{}'::text[] is Postgres' empty array, JSON's [] here; '{a,b}' would need its elements read.
    if (array && e.v === "{}") return { sql: "'[]'" };
    if (array) return { sql: null, why: "an array literal" };
    if (type === "BOOLEAN" && (e.v === "t" || e.v === "f" || e.v === "true" || e.v === "false")) return { sql: e.v.startsWith("t") ? "1" : "0" };
    return { sql: sqlLit(e.v) };
  }
  try {
    const s = toSqlite(e, []);
    return { sql: s.startsWith("(") ? s : `(${s})` };
  } catch (err) {
    return { sql: null, why: (err as Error).message };
  }
}

export { Unsupported, parseExpr };
