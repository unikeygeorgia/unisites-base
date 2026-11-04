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
 * `row.<column>` is the outer row). `auth.<field>` is the session's field,
 * null when signed out. Every value goes to SQL as a parameter, never as
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

export type Access = { tables: Record<string, TableAccess> };

export type Operation = "list" | "view" | "create" | "update" | "updateCheck" | "delete";
export const OPERATIONS: Operation[] = ["list", "view", "create", "update", "updateCheck", "delete"];

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isName(name: string): boolean {
  return NAME.test(name) && name.length <= 64;
}

export function quote(name: string): string {
  if (!isName(name)) throw new AccessError("bad_name", `not a name: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

export class AccessError extends Error {
  constructor(
    readonly code:
      | "bad_name"
      | "bad_rule"
      | "forbidden"
      | "refused"
      | "unknown_table"
      | "unknown_column"
      | "hidden_column"
      | "readonly_column"
      | "filter_required"
      | "too_many"
      | "bad_value"
      | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "AccessError";
  }
}

// ── The language ─────────────────────────────────────────────────────────

export type Value = string | number | boolean | null;

export type Node =
  | { k: "lit"; v: Value }
  | { k: "name"; path: string[] }
  | { k: "cmp"; op: "=" | "!=" | "<" | "<=" | ">" | ">="; l: Node; r: Node }
  | { k: "in"; l: Node; items: Node[] }
  | { k: "and" | "or"; items: Node[] }
  | { k: "not"; x: Node }
  | { k: "exists"; table: string; where: Node };

type Token = { t: "op" | "str" | "num" | "name"; v: string; at: number };

const OPS = ["&&", "||", "!=", "<=", ">=", "=", "<", ">", "!", "(", ")", "[", "]", ","];

function tokens(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      let s = "";
      let j = i + 1;
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === "\\" && j + 1 < src.length) j++;
        s += src[j];
      }
      if (j >= src.length) throw new AccessError("bad_rule", `unclosed string at ${i}: ${src}`);
      out.push({ t: "str", v: s, at: i });
      i = j + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num && (c !== "-" || !out.length || out[out.length - 1]!.t === "op")) {
      out.push({ t: "num", v: num[0], at: i });
      i += num[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i));
    if (name) {
      out.push({ t: "name", v: name[0], at: i });
      i += name[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new AccessError("bad_rule", `unexpected ${JSON.stringify(c)} at ${i}: ${src}`);
    out.push({ t: "op", v: op, at: i });
    i += op.length;
  }
  return out;
}

/** Parses a rule; "" is everyone, and is the literal true. */
export function parseRule(src: string): Node {
  if (src.trim() === "") return { k: "lit", v: true };
  const ts = tokens(src);
  let p = 0;
  const peek = () => ts[p];
  const fail = (what: string): never => {
    throw new AccessError("bad_rule", `${what} at ${peek()?.at ?? src.length}: ${src}`);
  };
  const eat = (v: string) => {
    if (peek()?.t === "op" && peek()!.v === v) {
      p++;
      return true;
    }
    return false;
  };
  const expect = (v: string) => eat(v) || fail(`expected ${v}`);

  function or(): Node {
    const items = [and()];
    while (eat("||")) items.push(and());
    return items.length === 1 ? items[0]! : { k: "or", items };
  }
  function and(): Node {
    const items = [not()];
    while (eat("&&")) items.push(not());
    return items.length === 1 ? items[0]! : { k: "and", items };
  }
  function not(): Node {
    if (eat("!")) return { k: "not", x: not() };
    return cmp();
  }
  function cmp(): Node {
    const l = operand();
    const t = peek();
    if (t?.t === "op" && ["=", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      p++;
      return { k: "cmp", op: t.v as "=", l, r: operand() };
    }
    if (t?.t === "name" && t.v === "in") {
      p++;
      expect("[");
      const items: Node[] = [];
      if (!eat("]")) {
        do items.push(operand());
        while (eat(","));
        expect("]");
      }
      return { k: "in", l, items };
    }
    return l;
  }
  function operand(): Node {
    const t = peek() ?? fail("unexpected end");
    if (t.t === "op" && t.v === "(") {
      p++;
      const x = or();
      expect(")");
      return x;
    }
    p++;
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "num") return { k: "lit", v: Number(t.v) };
    if (t.t === "name") {
      if (t.v === "true") return { k: "lit", v: true };
      if (t.v === "false") return { k: "lit", v: false };
      if (t.v === "null") return { k: "lit", v: null };
      if (t.v === "exists") {
        expect("(");
        const table = peek();
        if (table?.t !== "name" || !isName(table.v)) fail("expected a table");
        p++;
        expect(",");
        const where = or();
        expect(")");
        return { k: "exists", table: table!.v, where };
      }
      const path = t.v.split(".");
      if (path.length > 2 || (path.length === 2 && path[0] !== "auth" && path[0] !== "row")) fail(`unknown name ${t.v}`);
      return { k: "name", path };
    }
    return fail(`unexpected ${t.v}`);
  }

  const node = or();
  if (p < ts.length) fail("unexpected");
  return node;
}

// ── Into SQL ─────────────────────────────────────────────────────────────

export type Sql = { sql: string; params: unknown[] };

/** Where a column of the rule's own row comes from: the table, or a value about to be written. */
export type RowSource = (column: string) => Sql;

export type Compile = {
  auth: Record<string, unknown> | null;
  row: RowSource;
  /** Columns that exist, per table (for exists()); a missing table is unknown. */
  columns?: (table: string) => Set<string> | undefined;
};

export function bind(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

export function compileRule(node: Node, c: Compile): Sql {
  let alias = 0;
  const params: unknown[] = [];

  function walk(n: Node, inner: { alias: string; table: string } | null): string {
    switch (n.k) {
      case "lit":
        if (n.v === null) return "NULL";
        params.push(bind(n.v));
        return "?";
      case "name": {
        if (n.path[0] === "auth" && n.path.length === 2) {
          params.push(bind(c.auth ? c.auth[n.path[1]!] : null));
          return "?";
        }
        const column = n.path.length === 2 ? n.path[1]! : n.path[0]!;
        if (n.path.length === 1 && inner) {
          const known = c.columns?.(inner.table);
          if (known && !known.has(column)) throw new AccessError("unknown_column", `${inner.table}.${column}`);
          return `"${inner.alias}".${quote(column)}`;
        }
        const from = c.row(column);
        params.push(...from.params);
        return from.sql;
      }
      case "cmp": {
        const isNull = (x: Node) => x.k === "lit" && x.v === null;
        if (isNull(n.r) || isNull(n.l)) {
          const other = isNull(n.r) ? n.l : n.r;
          if (n.op !== "=" && n.op !== "!=") throw new AccessError("bad_rule", "null compares only with = and !=");
          return `(${walk(other, inner)} IS ${n.op === "=" ? "" : "NOT "}NULL)`;
        }
        const l = walk(n.l, inner);
        const r = walk(n.r, inner);
        return `(${l} ${n.op === "!=" ? "<>" : n.op} ${r})`;
      }
      case "in": {
        if (!n.items.length) return "0";
        const l = walk(n.l, inner);
        return `(${l} IN (${n.items.map((i) => walk(i, inner)).join(", ")}))`;
      }
      case "and":
      case "or":
        return `(${n.items.map((i) => walk(i, inner)).join(n.k === "and" ? " AND " : " OR ")})`;
      case "not":
        return `(NOT ${walk(n.x, inner)})`;
      case "exists": {
        if (!c.columns?.(n.table) && c.columns) throw new AccessError("unknown_table", n.table);
        // $ is never in a table's name, so the alias cannot be one.
        const a = `$e${++alias}`;
        const where = walk(n.where, { alias: a, table: n.table });
        return `EXISTS (SELECT 1 FROM ${quote(n.table)} AS "${a}" WHERE ${where})`;
      }
    }
  }

  const sql = walk(node, null);
  return { sql, params };
}

/** Names a rule reads: its own columns, the session's fields and the tables in exists(). */
export function namesIn(node: Node): { columns: Set<string>; auth: Set<string>; tables: Set<string> } {
  const out = { columns: new Set<string>(), auth: new Set<string>(), tables: new Set<string>() };
  function walk(n: Node, inner: boolean) {
    switch (n.k) {
      case "name":
        if (n.path[0] === "auth" && n.path.length === 2) out.auth.add(n.path[1]!);
        else if (n.path.length === 2 || !inner) out.columns.add(n.path[n.path.length - 1]!);
        return;
      case "cmp":
        walk(n.l, inner);
        walk(n.r, inner);
        return;
      case "in":
        walk(n.l, inner);
        n.items.forEach((i) => walk(i, inner));
        return;
      case "and":
      case "or":
        n.items.forEach((i) => walk(i, inner));
        return;
      case "not":
        walk(n.x, inner);
        return;
      case "exists":
        out.tables.add(n.table);
        walk(n.where, true);
        return;
      case "lit":
        return;
    }
  }
  walk(node, false);
  return out;
}

/** A ! over something that reads auth.*, or auth.* compared with !=: both pass for null. */
function negatesAuth(node: Node): boolean {
  const readsAuth = (n: Node): boolean => namesIn(n).auth.size > 0;
  const guarded = (n: Node): boolean =>
    n.k === "cmp" && n.op === "!=" && ((n.l.k === "name" && n.l.path.join(".") === "auth.id" && n.r.k === "lit" && n.r.v === null) || (n.r.k === "name" && n.r.path.join(".") === "auth.id" && n.l.k === "lit" && n.l.v === null));
  const walk = (n: Node, inAnd: Node[]): boolean => {
    switch (n.k) {
      case "not":
        return readsAuth(n.x) && !inAnd.some(guarded);
      case "cmp":
        return n.op === "!=" && !guarded(n) && (readsAuth(n.l) || readsAuth(n.r)) && !inAnd.some(guarded);
      case "and":
        return n.items.some((i) => walk(i, n.items));
      case "or":
        return n.items.some((i) => walk(i, []));
      default:
        return false;
    }
  };
  return walk(node, []);
}

// ── Checking a project's rules (Supabase's splinter, for ours) ───────────

export type Finding = { level: "error" | "warning"; table: string; message: string };

/** Column names that hold secrets or personal data (splinter 0023). */
export const SENSITIVE = [
  "password", "passwd", "pwd", "passphrase", "secret", "secret_key", "private_key", "api_key", "apikey",
  "auth_key", "token", "jwt", "access_token", "refresh_token", "oauth_token", "session_token", "bearer_token",
  "auth_code", "session_id", "session_key", "session_secret", "recovery_code", "backup_code",
  "verification_code", "otp", "two_factor", "ssn", "national_id", "personal_id", "passport_number", "tax_id",
  "credit_card", "card_number", "cvv", "cvc", "bank_account", "account_number", "iban", "swift_code",
  "medical_record", "patient_id", "ssh_key", "license_key",
];

/** Session fields a person changes themself: never a reason to let them in (splinter 0015). */
export const SELF_EDITED = ["name", "image", "metadata", "user_metadata", "displayName", "username"];

/**
 * Problems in a project's rules, before anything runs: a rule that does not
 * parse, base's own tables opened, writes anyone may make, secrets left
 * readable, a rule trusting what a person writes about themself, and, with
 * the schema, names that do not exist.
 */
export function checkAccess(access: Access, schema?: Map<string, Set<string>>): Finding[] {
  const found: Finding[] = [];
  for (const [table, rules] of Object.entries(access.tables ?? {})) {
    const say = (level: Finding["level"], message: string) => found.push({ level, table, message });
    if (!isName(table)) {
      say("error", "not a table name");
      continue;
    }
    if (table.startsWith("_base_")) say("error", "base's own tables (users, sessions) are never opened to the data API");
    const columns = schema?.get(table);
    if (schema && !columns) say("error", "no such table in the migrations");
    const known = (c: string) => !columns || columns.has(c);
    for (const c of [...(rules.hidden ?? []), ...(rules.readonly ?? []), ...Object.keys(rules.fill ?? {})]) {
      if (!known(c)) say("error", `no such column: ${c}`);
    }
    for (const [c, from] of Object.entries(rules.fill ?? {})) {
      if (!/^auth\.[A-Za-z_][A-Za-z0-9_]*$/.test(from)) say("error", `fill ${c}: only auth.<field>`);
    }
    for (const op of OPERATIONS) {
      const rule = rules[op];
      if (rule === undefined || rule === null) continue;
      let node: Node;
      try {
        node = parseRule(rule);
      } catch (e) {
        say("error", `${op}: ${(e as Error).message}`);
        continue;
      }
      const names = namesIn(node);
      for (const c of names.columns) if (!known(c)) say("error", `${op}: no such column: ${c}`);
      for (const t of names.tables) if (schema && !schema.has(t)) say("error", `${op}: no such table: ${t}`);
      for (const f of names.auth) {
        if (SELF_EDITED.includes(f)) say("warning", `${op}: auth.${f} is something a person writes themself`);
      }
      if (negatesAuth(node)) {
        say("warning", `${op}: a ! or != on auth.* is true for someone signed out (add auth.id != null)`);
      }
      const open = node.k === "lit" && node.v === true;
      if (open && (op === "create" || op === "update" || op === "delete" || op === "updateCheck")) {
        say("warning", `${op}: anyone, even signed out, may do it`);
      }
    }
    if (columns) {
      const hidden = new Set(rules.hidden ?? []);
      const readable = rules.list != null || rules.view != null;
      const exposed = [...columns].filter((c) => !hidden.has(c) && SENSITIVE.includes(c.toLowerCase().replaceAll("-", "_")));
      if (readable && exposed.length) say("warning", `readable columns that look secret or personal: ${exposed.join(", ")} (add them to hidden?)`);
    }
  }
  return found;
}
