/**
 * Postgres expressions as Postgres prints them back (pg_policies, pg_get_constraintdef,
 * pg_get_expr) and SQL functions' bodies, parsed far enough to translate: comparisons, AND, OR,
 * NOT, IS, IN, ANY(ARRAY[...]), BETWEEN, LIKE, casts (dropped), function calls, EXISTS and
 * subqueries of one table. Anything else throws Unsupported with what it met, so the report says
 * so instead of guessing.
 */

export class Unsupported extends Error {}

export type Select = { items: { e: E; alias?: string }[]; from?: { schema?: string; table: string; alias?: string }; where?: E };

export type E =
  | { k: "lit"; v: string | number | boolean | null }
  | { k: "col"; path: string[] }
  | { k: "fn"; name: string[]; args: E[] }
  | { k: "bin"; op: string; l: E; r: E }
  | { k: "and" | "or"; items: E[] }
  | { k: "not"; x: E }
  | { k: "isnull"; x: E; not: boolean }
  | { k: "is"; x: E; v: boolean; not: boolean }
  | { k: "in"; x: E; list: E[]; not: boolean }
  | { k: "insub"; x: E; sub: Select; not: boolean }
  | { k: "any"; x: E; op: string; arr: E }
  | { k: "array"; items: E[] }
  | { k: "exists"; sub: Select }
  | { k: "sub"; sub: Select }
  | { k: "between"; x: E; lo: E; hi: E; not: boolean }
  | { k: "neg"; x: E }
  | { k: "cast"; x: E; type: string };

type Tok = { t: "str" | "num" | "id" | "qid" | "op"; v: string };

const OPS = ["!~~*", "~~*", "!~~", "->>", "::", "<=", ">=", "<>", "!=", "~~", "~*", "!~", "->", "||", "=", "<", ">", "(", ")", ",", ".", "[", "]", "~", "+", "-", "*", "/", ";", "%"];

function tokens(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && src[i + 1] === "-") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "'" || ((c === "E" || c === "e") && src[i + 1] === "'")) {
      const escapes = c !== "'";
      let j = escapes ? i + 2 : i + 1;
      let s = "";
      for (;;) {
        if (j >= src.length) throw new Unsupported("an unclosed string");
        if (src[j] === "'" && src[j + 1] === "'") {
          s += "'";
          j += 2;
        } else if (src[j] === "'") break;
        else if (escapes && src[j] === "\\" && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
        } else s += src[j++];
      }
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const j = src.indexOf('"', i + 1);
      if (j < 0) throw new Unsupported("an unclosed name");
      out.push({ t: "qid", v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (c === "$" && /\d/.test(src[i + 1] ?? "")) {
      const m = /^\$\d+/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0].toLowerCase() });
      i += id[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new Unsupported(`"${c}"`);
    out.push({ t: "op", v: op });
    i += op.length;
  }
  return out;
}

const TYPE_WORDS = new Set(["varying", "precision", "with", "without", "time", "zone"]);
const RESERVED = new Set(["and", "or", "not", "is", "in", "between", "like", "ilike", "from", "where", "as", "then", "else", "end", "when", "limit", "order", "group", "join", "on", "using", "union", "select"]);

class Parser {
  p = 0;
  constructor(readonly ts: Tok[]) {}

  peek(o = 0): Tok | undefined {
    return this.ts[this.p + o];
  }
  word(v: string, o = 0): boolean {
    const t = this.peek(o);
    return t?.t === "id" && t.v === v;
  }
  op(v: string, o = 0): boolean {
    const t = this.peek(o);
    return t?.t === "op" && t.v === v;
  }
  eatWord(v: string): boolean {
    if (this.word(v)) return !!++this.p;
    return false;
  }
  eatOp(v: string): boolean {
    if (this.op(v)) return !!++this.p;
    return false;
  }
  expectOp(v: string): void {
    if (!this.eatOp(v)) this.fail(`expected ${v}`);
  }
  fail(what: string): never {
    const near = this.ts.slice(this.p, this.p + 4).map((t) => t.v).join(" ");
    throw new Unsupported(`${what}${near ? ` near "${near}"` : ""}`);
  }
  done(): void {
    while (this.eatOp(";"));
    if (this.p < this.ts.length) this.fail("more than one expression");
  }

  expr(): E {
    return this.or();
  }
  or(): E {
    const items = [this.and()];
    while (this.eatWord("or")) items.push(this.and());
    return items.length === 1 ? items[0]! : { k: "or", items };
  }
  and(): E {
    const items = [this.not()];
    while (this.eatWord("and")) items.push(this.not());
    return items.length === 1 ? items[0]! : { k: "and", items };
  }
  not(): E {
    if (this.eatWord("not")) return { k: "not", x: this.not() };
    return this.predicate();
  }
  predicate(): E {
    const x = this.additive();
    for (;;) {
      if (this.eatWord("is")) {
        const not = this.eatWord("not");
        if (this.eatWord("null")) return { k: "isnull", x, not };
        if (this.eatWord("true")) return { k: "is", x, v: true, not };
        if (this.eatWord("false")) return { k: "is", x, v: false, not };
        if (this.eatWord("distinct")) this.fail("IS DISTINCT FROM");
        this.fail("IS what");
      }
      const not = this.word("not") && (this.word("in", 1) || this.word("between", 1) || this.word("like", 1) || this.word("ilike", 1));
      if (not) this.p++;
      if (this.eatWord("in")) {
        this.expectOp("(");
        if (this.word("select")) {
          const sub = this.select();
          this.expectOp(")");
          return { k: "insub", x, sub, not };
        }
        const list = [this.expr()];
        while (this.eatOp(",")) list.push(this.expr());
        this.expectOp(")");
        return { k: "in", x, list, not };
      }
      if (this.eatWord("between")) {
        const lo = this.additive();
        if (!this.eatWord("and")) this.fail("BETWEEN without AND");
        return { k: "between", x, lo, hi: this.additive(), not };
      }
      if (this.word("like") || this.word("ilike")) {
        const op = (this.peek()!.v === "like" ? "~~" : "~~*").replace(/^/, not ? "!" : "");
        this.p++;
        return { k: "bin", op, l: x, r: this.additive() };
      }
      if (not) this.fail("NOT what");
      const t = this.peek();
      if (t?.t === "op" && ["=", "<>", "!=", "<", "<=", ">", ">=", "~~", "~~*", "!~~", "!~~*", "~", "~*", "!~"].includes(t.v)) {
        this.p++;
        const op = t.v === "!=" ? "<>" : t.v;
        if (this.word("any") || this.word("some") || this.word("all")) {
          if (this.word("all")) this.fail("ALL (...)");
          this.p++;
          this.expectOp("(");
          const arr = this.word("select") ? ({ k: "sub", sub: this.select() } as E) : this.expr();
          this.expectOp(")");
          return { k: "any", x, op, arr };
        }
        return { k: "bin", op, l: x, r: this.additive() };
      }
      return x;
    }
  }
  additive(): E {
    let l = this.multiplicative();
    for (;;) {
      const t = this.peek();
      if (t?.t === "op" && (t.v === "+" || t.v === "-" || t.v === "||")) {
        this.p++;
        l = { k: "bin", op: t.v, l, r: this.multiplicative() };
      } else return l;
    }
  }
  multiplicative(): E {
    let l = this.unary();
    for (;;) {
      const t = this.peek();
      if (t?.t === "op" && (t.v === "*" || t.v === "/" || t.v === "%")) {
        this.p++;
        l = { k: "bin", op: t.v, l, r: this.unary() };
      } else return l;
    }
  }
  unary(): E {
    if (this.eatOp("-")) {
      const x = this.unary();
      return x.k === "lit" && typeof x.v === "number" ? { k: "lit", v: -x.v } : { k: "neg", x };
    }
    return this.postfix();
  }
  postfix(): E {
    let x = this.primary();
    for (;;) {
      if (this.eatOp("::")) x = { k: "cast", x, type: this.type() };
      else if (this.op("->") || this.op("->>")) {
        const op = this.peek()!.v;
        this.p++;
        x = { k: "bin", op, l: x, r: this.primary() };
      } else if (this.op("[")) this.fail("an array subscript");
      else return x;
    }
  }
  /** A type after ::, as its name: "text", "uuid", "character varying", "text[]". */
  type(): string {
    const t = this.peek();
    if (t?.t !== "id" && t?.t !== "qid") this.fail("a type");
    this.p++;
    let name = t.v;
    if (this.eatOp(".")) name = this.ts[this.p++]!.v;
    while (this.peek()?.t === "id" && TYPE_WORDS.has(this.peek()!.v)) name += ` ${this.ts[this.p++]!.v}`;
    if (this.eatOp("(")) {
      while (!this.eatOp(")")) if (++this.p > this.ts.length) this.fail("a type");
    }
    while (this.op("[") && this.op("]", 1)) {
      this.p += 2;
      name += "[]";
    }
    return name;
  }
  primary(): E {
    const t = this.peek() ?? this.fail("the end");
    if (t.t === "str") {
      this.p++;
      return { k: "lit", v: t.v };
    }
    if (t.t === "num") {
      this.p++;
      return { k: "lit", v: Number(t.v) };
    }
    if (t.t === "op" && t.v === "(") {
      this.p++;
      if (this.word("select")) {
        const sub = this.select();
        this.expectOp(")");
        return { k: "sub", sub };
      }
      const x = this.expr();
      this.expectOp(")");
      return x;
    }
    if (t.t === "id" || t.t === "qid") {
      if (t.t === "id") {
        if (t.v === "true" || t.v === "false") {
          this.p++;
          return { k: "lit", v: t.v === "true" };
        }
        if (t.v === "null") {
          this.p++;
          return { k: "lit", v: null };
        }
        if (t.v === "exists") {
          this.p++;
          this.expectOp("(");
          const sub = this.select();
          this.expectOp(")");
          return { k: "exists", sub };
        }
        if (t.v === "array" && this.op("[", 1)) {
          this.p += 2;
          const items: E[] = [];
          if (!this.eatOp("]")) {
            do items.push(this.expr());
            while (this.eatOp(","));
            this.expectOp("]");
          }
          return { k: "array", items };
        }
        if (t.v === "case") this.fail("CASE");
        if (["current_timestamp", "current_date", "current_time", "localtimestamp", "current_user", "session_user"].includes(t.v)) {
          this.p++;
          return { k: "fn", name: [t.v], args: [] };
        }
        if (RESERVED.has(t.v)) this.fail(`"${t.v}"`);
      }
      const path = [t.v];
      this.p++;
      while (this.op(".") && (this.peek(1)?.t === "id" || this.peek(1)?.t === "qid")) {
        this.p++;
        path.push(this.peek()!.v);
        this.p++;
      }
      if (this.eatOp("(")) {
        const args: E[] = [];
        if (!this.eatOp(")")) {
          if (this.word("distinct")) this.fail("DISTINCT");
          do args.push(this.expr());
          while (this.eatOp(","));
          this.expectOp(")");
        }
        return { k: "fn", name: path, args };
      }
      return { k: "col", path };
    }
    return this.fail(`"${t.v}"`);
  }
  select(): Select {
    if (!this.eatWord("select")) this.fail("expected SELECT");
    const items: Select["items"] = [];
    do {
      const e = this.expr();
      let alias: string | undefined;
      if (this.eatWord("as")) alias = this.peek()!.v, this.p++;
      items.push({ e, alias });
    } while (this.eatOp(","));
    const s: Select = { items };
    if (this.eatWord("from")) {
      const a = this.peek();
      if (a?.t !== "id" && a?.t !== "qid") this.fail("a table");
      this.p++;
      let schema: string | undefined;
      let table = a.v;
      if (this.eatOp(".")) {
        schema = table;
        table = this.peek()!.v;
        this.p++;
      }
      s.from = { schema, table };
      if (this.eatWord("as")) s.from.alias = this.peek()!.v, this.p++;
      else if (this.peek()?.t === "id" && !RESERVED.has(this.peek()!.v)) s.from.alias = this.peek()!.v, this.p++;
      if (this.op(",") || this.word("join") || this.word("left") || this.word("inner") || this.word("cross")) this.fail("a join");
    }
    if (this.eatWord("where")) s.where = this.expr();
    if (this.eatWord("limit")) this.p++;
    if (this.word("group") || this.word("order") || this.word("union") || this.word("having")) this.fail(`${this.peek()!.v.toUpperCase()}`);
    return s;
  }
}

export function parseExpr(src: string): E {
  const p = new Parser(tokens(src));
  const e = p.expr();
  p.done();
  return e;
}

/** A SQL function's body: one SELECT. */
export function parseSelect(src: string): Select {
  const p = new Parser(tokens(src));
  const s = p.select();
  p.done();
  return s;
}

/** An index as pg_get_indexdef prints it. */
export function parseIndex(src: string): { unique: boolean; name: string; table: string; method: string; items: string; where?: E } {
  const m = /^CREATE (UNIQUE )?INDEX (\S+) ON (?:ONLY )?(?:"?public"?\.)?("[^"]+"|\S+) USING (\w+) \((.*?)\)(?: INCLUDE \(.*?\))?(?: WHERE (.*))?$/s.exec(src.trim());
  if (!m) throw new Unsupported("an index of another form");
  return { unique: !!m[1], name: m[2]!, table: m[3]!.replace(/"/g, ""), method: m[4]!, items: m[5]!, where: m[6] ? parseExpr(m[6]) : undefined };
}
