import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { AccessError, checkAccess, parseRule, type Access } from "../src/access.ts";
import { createData, type Exec } from "../src/data.ts";

// A Unichat-shaped project: tenants, their members, notes inside a tenant,
// posts anyone may read once published, and a public price list.
const SCHEMA = `
  create table tenants (id text primary key, name text);
  create table memberships (tenant_id text, user_id text, role text);
  create table notes (id text primary key, tenant_id text not null, owner_id text, body text, secret_note text, created_at text default '2026-01-01');
  create table posts (id integer primary key, author text, title text, published integer default 0);
  create table plans (id integer primary key, name text, price integer);
  create table unruled (id integer primary key, x text);
  create table _base_user (id text primary key, email text, password text);
`;

const MEMBER = "exists(memberships, tenant_id = row.tenant_id && user_id = auth.id)";

const ACCESS: Access = {
  tables: {
    notes: {
      list: MEMBER,
      view: MEMBER,
      create: MEMBER,
      update: "owner_id = auth.id",
      updateCheck: `owner_id = auth.id && ${MEMBER}`,
      delete: `owner_id = auth.id || exists(memberships, tenant_id = row.tenant_id && user_id = auth.id && role = 'admin')`,
      hidden: ["secret_note"],
      readonly: ["created_at"],
      fill: { owner_id: "auth.id" },
    },
    posts: { list: "published = true || author = auth.id", create: "author = auth.id", update: "author = auth.id", delete: null },
    plans: { list: "" },
  },
};

function project() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.exec(`
    insert into tenants values ('t1', 'Shop one'), ('t2', 'Shop two');
    insert into memberships values ('t1', 'ana', 'admin'), ('t1', 'beka', 'member'), ('t2', 'gio', 'admin');
    insert into notes (id, tenant_id, owner_id, body, secret_note) values
      ('n1', 't1', 'ana', 'ana in t1', 's1'), ('n2', 't1', 'beka', 'beka in t1', 's2'), ('n3', 't2', 'gio', 'gio in t2', 's3');
    insert into posts (id, author, title, published) values (1, 'ana', 'out', 1), (2, 'ana', 'draft', 0), (3, 'gio', 'gio draft', 0);
    insert into plans (name, price) values ('Start', 10), ('Pro', 30);
    insert into _base_user values ('ana', 'ana@test', 'hash');
  `);
  const statements: string[] = [];
  const exec: Exec = async (sql, params) => {
    statements.push(sql);
    return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  };
  const data = createData({ exec, access: ACCESS });
  const raw = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
  return { data, exec, raw, statements, ana: data.as({ id: "ana" }), beka: data.as({ id: "beka" }), gio: data.as({ id: "gio" }), nobody: data.as(null) };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AccessError) return e.code;
    throw e;
  }
  return "ok";
}

const ids = (rows: Record<string, unknown>[]) => rows.map((r) => r.id).sort();

describe("reading", () => {
  it("shows a member only their tenant's rows", async () => {
    const { ana, gio } = project();
    expect(ids(await ana.list("notes"))).toEqual(["n1", "n2"]);
    expect(ids(await gio.list("notes"))).toEqual(["n3"]);
  });

  it("shows nothing to someone signed out, and refuses where no rule is", async () => {
    const { nobody, ana } = project();
    expect(await nobody.list("notes")).toEqual([]);
    expect(await code(ana.list("unruled"))).toBe("unknown_table");
    expect(await code(ana.list("_base_user"))).toBe("unknown_table");
    expect(await code(ana.list("no_such_table"))).toBe("unknown_table");
    expect(await code(ana.delete("posts", [{ column: "id", op: "eq", value: 1 }]))).toBe("forbidden");
  });

  it("lets everyone read a table whose rule is empty", async () => {
    const { nobody } = project();
    expect((await nobody.list("plans")).map((r) => r.name)).toEqual(["Start", "Pro"]);
  });

  it("compares with a signed-out person's null as false, never as a match", async () => {
    const { nobody, ana } = project();
    expect(ids(await nobody.list("posts"))).toEqual([1]);
    expect(ids(await ana.list("posts"))).toEqual([1, 2]);
  });

  it("never lets a filter open what the rule closes", async () => {
    const { gio } = project();
    const tries = [
      [{ or: [{ column: "tenant_id", op: "eq", value: "t1" }, { column: "id", op: "neq", value: "x" }] }],
      [{ not: { column: "tenant_id", op: "eq", value: "t1" } }],
      [{ column: "id", op: "in", value: ["n1", "n2", "n3"] }],
      [{ column: "tenant_id", op: "like", value: "%" }],
    ] as const;
    for (const where of tries) expect(ids(await gio.list("notes", { where: [...where] as never }))).toEqual(["n3"]);
  });

  it("keeps hidden columns out of reads, filters and order", async () => {
    const { ana } = project();
    const rows = await ana.list("notes");
    expect(rows[0]).not.toHaveProperty("secret_note");
    expect(await code(ana.list("notes", { columns: ["secret_note"] }))).toBe("hidden_column");
    expect(await code(ana.list("notes", { where: [{ column: "secret_note", op: "like", value: "s%" }] }))).toBe("hidden_column");
    expect(await code(ana.list("notes", { order: [{ column: "secret_note" }] }))).toBe("hidden_column");
    expect(await code(ana.get("notes", "n1", ["secret_note"]))).toBe("hidden_column");
  });

  it("refuses names that are not plain names", async () => {
    const { ana } = project();
    expect(await code(ana.list('notes" --'))).toBe("bad_name");
    expect(await code(ana.list("notes", { columns: ['body" from _base_user --'] }))).toBe("unknown_column");
    expect(await code(ana.list("notes", { where: [{ column: "body)) or 1 --", op: "eq", value: 1 }] }))).toBe("unknown_column");
  });

  it("gets one row by key only when view allows it", async () => {
    const { ana, gio } = project();
    expect((await ana.get("notes", "n2"))?.body).toBe("beka in t1");
    expect(await gio.get("notes", "n2")).toBeNull();
    expect(await code(ana.get("posts", 1))).toBe("forbidden");
  });

  it("takes long in-lists and patterns as values", async () => {
    const { ana } = project();
    const many = Array.from({ length: 500 }, (_, i) => `x${i}`).concat("n2");
    expect(ids(await ana.list("notes", { where: [{ column: "id", op: "in", value: many }] }))).toEqual(["n2"]);
    expect(ids(await ana.list("notes", { where: [{ column: "body", op: "like", value: "ana*" }] }))).toEqual(["n1"]);
    expect(ids(await ana.list("notes", { where: [{ column: "body", op: "like", value: "ANA%" }] }))).toEqual([]);
    expect(ids(await ana.list("notes", { where: [{ column: "body", op: "ilike", value: "ANA%" }] }))).toEqual(["n1"]);
    expect(ids(await ana.list("notes", { where: [{ column: "body", op: "like", value: "[a]*" }] }))).toEqual([]);
    expect(ids(await ana.list("notes", { where: [{ column: "body", op: "eq", value: "x' or '1'='1" }] }))).toEqual([]);
  });

  it("caps how many rows come back", async () => {
    const { exec, ana } = project();
    expect(await code(ana.list("plans", { limit: -1 }))).toBe("bad_value");
    expect(await code(ana.list("plans", { offset: 1.5 }))).toBe("bad_value");
    const small = createData({ exec, access: ACCESS, maxRows: 1 }).as({ id: "ana" });
    expect(await small.list("plans")).toHaveLength(1);
    expect(await small.list("plans", { limit: 50 })).toHaveLength(1);
    expect(await code(small.create("posts", [{ author: "ana" }, { author: "ana" }]))).toBe("too_many");
  });
});

describe("creating", () => {
  it("fills the owner from the session, and never takes it from the person", async () => {
    const { ana, raw } = project();
    await ana.create("notes", { id: "n4", tenant_id: "t1", body: "new" });
    expect(raw("select owner_id from notes where id = 'n4'")).toEqual([{ owner_id: "ana" }]);
    expect(await code(ana.create("notes", { id: "n5", tenant_id: "t1", owner_id: "beka" }))).toBe("readonly_column");
    expect(await code(ana.create("notes", { id: "n5", tenant_id: "t1", created_at: "1999" }))).toBe("readonly_column");
  });

  it("refuses a row in a tenant one is not in, and writes nothing", async () => {
    const { ana, raw } = project();
    expect(await code(ana.create("notes", { id: "n6", tenant_id: "t2" }))).toBe("refused");
    expect(raw("select id from notes where id = 'n6'")).toEqual([]);
  });

  it("writes all the rows or none", async () => {
    const { ana, raw } = project();
    const rows = [
      { id: "a1", tenant_id: "t1" },
      { id: "a2", tenant_id: "t2" },
      { id: "a3", tenant_id: "t1" },
    ];
    expect(await code(ana.create("notes", rows))).toBe("refused");
    expect(raw("select id from notes where id like 'a%'")).toEqual([]);
    await ana.create("notes", [rows[0]!, rows[2]!]);
    expect(raw("select id from notes where id like 'a%' order by id")).toEqual([{ id: "a1" }, { id: "a3" }]);
  });

  it("checks the new row against the rule: no post in someone else's name", async () => {
    const { ana, raw } = project();
    expect(await code(ana.create("posts", { author: "gio", title: "fake" }))).toBe("refused");
    expect(raw("select count(*) as n from posts")).toEqual([{ n: 3 }]);
    const made = await ana.create("posts", { author: "ana", title: "mine" }, { returning: true });
    expect(made.rows?.[0]).toMatchObject({ author: "ana", title: "mine", published: 0 });
  });

  it("returns nothing hidden", async () => {
    const { ana } = project();
    const made = await ana.create("notes", { id: "n7", tenant_id: "t1" }, { returning: true });
    expect(made.rows?.[0]).not.toHaveProperty("secret_note");
    expect(made.rows?.[0]).toMatchObject({ id: "n7", owner_id: "ana", created_at: "2026-01-01" });
  });

  it("refuses a signed-out person", async () => {
    const { nobody } = project();
    expect(await code(nobody.create("notes", { id: "n8", tenant_id: "t1" }))).toBe("refused");
  });
});

describe("changing and deleting", () => {
  it("changes only one's own rows", async () => {
    const { ana, beka, raw } = project();
    expect((await beka.update("notes", [{ column: "id", op: "eq", value: "n1" }], { body: "hacked" })).count).toBe(0);
    expect((await ana.update("notes", [{ column: "id", op: "eq", value: "n1" }], { body: "edited" })).count).toBe(1);
    expect(raw("select body from notes where id = 'n1'")).toEqual([{ body: "edited" }]);
  });

  it("never moves a row to where one may not have it (updateCheck)", async () => {
    const { ana, raw } = project();
    expect((await ana.update("notes", [{ column: "id", op: "eq", value: "n1" }], { tenant_id: "t2" })).count).toBe(0);
    expect(raw("select tenant_id from notes where id = 'n1'")).toEqual([{ tenant_id: "t1" }]);
  });

  it("checks the new row with the update rule when there is no updateCheck", async () => {
    const { ana, raw } = project();
    expect((await ana.update("posts", [{ column: "id", op: "eq", value: 2 }], { author: "gio" })).count).toBe(0);
    expect(raw("select author from posts where id = 2")).toEqual([{ author: "ana" }]);
  });

  it("never writes readonly, filled, key or hidden columns", async () => {
    const { ana } = project();
    const where = [{ column: "id", op: "eq", value: "n1" }] as const;
    expect(await code(ana.update("notes", [...where], { owner_id: "beka" }))).toBe("readonly_column");
    expect(await code(ana.update("notes", [...where], { created_at: "x" }))).toBe("readonly_column");
    expect(await code(ana.update("notes", [...where], { id: "n9" }))).toBe("readonly_column");
    expect(await code(ana.update("notes", [...where], { secret_note: "x" }))).toBe("hidden_column");
  });

  it("needs a filter to change or delete", async () => {
    const { ana } = project();
    expect(await code(ana.update("notes", [], { body: "all" }))).toBe("filter_required");
    expect(await code(ana.delete("notes", []))).toBe("filter_required");
  });

  it("does not let a change learn of rows one cannot see", async () => {
    const { gio, raw } = project();
    // gio may not see t1's notes: an update filtered on them changes, and counts, nothing.
    const tried = await gio.update("notes", [{ column: "tenant_id", op: "eq", value: "t1" }], { body: "x" });
    expect(tried.count).toBe(0);
    expect(raw("select count(*) as n from notes where body = 'x'")).toEqual([{ n: 0 }]);
  });

  it("returns the changed row without what is hidden", async () => {
    const { ana } = project();
    const out = await ana.update("notes", [{ column: "id", op: "eq", value: "n1" }], { body: "b" }, { returning: true });
    expect(out.rows).toEqual([{ id: "n1", tenant_id: "t1", owner_id: "ana", body: "b", created_at: "2026-01-01" }]);
  });

  it("deletes one's own rows, and a tenant admin deletes any in the tenant", async () => {
    const { ana, beka, gio, raw } = project();
    expect((await beka.delete("notes", [{ column: "id", op: "eq", value: "n1" }])).count).toBe(0);
    expect((await gio.delete("notes", [{ column: "id", op: "eq", value: "n2" }])).count).toBe(0);
    expect((await ana.delete("notes", [{ column: "id", op: "eq", value: "n2" }])).count).toBe(1);
    expect(raw("select id from notes order by id")).toEqual([{ id: "n1" }, { id: "n3" }]);
  });
});

// What the first security review found (2026-11-04); each stays a test.
describe("the review's findings", () => {
  function shop() {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      create table items (id integer primary key, owner text, price integer, published integer default 0);
      create table profiles (id integer primary key, owner text, handle text unique on conflict replace);
      create table secrets (id integer primary key, owner text);
      create table "$v" (code text, c_code text);
      insert into items (id, owner, price) values (1, 'ana', 10), (2, 'gio', 20);
      insert into profiles (id, owner, handle) values (1, 'gio', 'gio'), (2, 'ana', 'ana');
      insert into secrets values (777, 'ana');
    `);
    const exec: Exec = async (sql, params) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    const data = createData({
      exec,
      access: {
        tables: {
          items: { list: "owner = auth.id || published = true", create: "owner = auth.id && price >= 0", update: "owner = auth.id", updateCheck: "owner = auth.id && published != true", delete: "owner = auth.id" },
          profiles: { list: "", create: "owner = auth.id", update: "owner = auth.id" },
          secrets: { list: "owner = auth.id", hidden: ["id"] },
        },
      },
    });
    const raw = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
    return { ana: data.as({ id: "ana" }), raw };
  }

  it("checks a value as the column will keep it: no '-5' past price >= 0", async () => {
    const { ana, raw } = shop();
    expect(await code(ana.create("items", { owner: "ana", price: "-5" }))).toBe("bad_value");
    expect(await code(ana.create("items", { owner: "ana", price: -5 }))).toBe("refused");
    expect(await code(ana.update("items", [{ column: "id", op: "eq", value: 1 }], { published: "1" }))).toBe("bad_value");
    expect((await ana.update("items", [{ column: "id", op: "eq", value: 1 }], { published: true })).count).toBe(0);
    expect(await code(ana.create("items", { owner: 5, price: 1 }))).toBe("bad_value");
    expect(raw("select price, published from items where id = 1")).toEqual([{ price: 10, published: 0 }]);
  });

  it("never takes rowid, oid or _rowid_ from a request", async () => {
    const { ana, raw } = shop();
    for (const name of ["rowid", "oid", "_rowid_", "ROWID"]) {
      expect(await code(ana.update("items", [{ column: "id", op: "eq", value: 1 }], { [name]: 50 }))).toBe("unknown_column");
      expect(await code(ana.list("secrets", { columns: [name] }))).toBe("unknown_column");
      expect(await code(ana.list("items", { where: [{ column: name, op: "eq", value: 1 }] }))).toBe("unknown_column");
    }
    expect(raw("select id from items order by id")).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("never lets a table's ON CONFLICT REPLACE delete someone else's row", async () => {
    const { ana, raw } = shop();
    expect(await code(ana.create("profiles", { owner: "ana", handle: "gio" }))).toBe("conflict");
    expect(await code(ana.update("profiles", [{ column: "id", op: "eq", value: 2 }], { handle: "gio" }))).toBe("conflict");
    expect(raw("select owner, handle from profiles order by id")).toEqual([{ owner: "gio", handle: "gio" }, { owner: "ana", handle: "ana" }]);
  });

  it("says only 'conflict' when a value collides, never which column or whose row", async () => {
    const { ana } = shop();
    const err = await ana.create("profiles", { owner: "ana", handle: "gio" }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toMatch(/handle|profiles|UNIQUE/);
  });

  it("needs a column filter for a change or a delete, not an empty and/or", async () => {
    const { ana } = shop();
    for (const where of [[{ and: [] }], [{ not: { or: [] } }], [{ or: [{ column: "id", op: "gt", value: 0 }] }]]) {
      expect(await code(ana.delete("items", where as never))).toBe("filter_required");
    }
  });

  it("keeps its own names apart from a project's tables", async () => {
    const { ana, raw } = shop();
    await ana.create("items", { owner: "ana", price: 3 });
    expect(raw('select count(*) as n from "$v"')).toEqual([{ n: 0 }]);
    expect(await code(ana.list("$v"))).toBe("bad_name");
  });

  it("refuses what is not a value with bad_value, not a crash", async () => {
    const { ana } = shop();
    expect(await code(ana.list("items", { where: [{ column: "id", op: "in", value: [1n] }] }))).toBe("bad_value");
    expect(await code(ana.create("items", { owner: "ana", price: 1n as never }))).toBe("bad_value");
    expect(await code(ana.list("items", { where: [null as never] }))).toBe("bad_value");
    expect(await code(ana.list("items", { where: "id=1" as never }))).toBe("bad_value");
    expect(await code(ana.create("items", { owner: "ana", price: Infinity }))).toBe("bad_value");
  });

  it("caps how many filters one request has", async () => {
    const { ana } = shop();
    const where = Array.from({ length: 31 }, () => ({ column: "id", op: "gt", value: 0 }) as const);
    expect(await code(ana.list("items", { where: [...where] }))).toBe("too_many");
  });

  it("matches hidden and readonly columns in any case", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`create table t (id integer primary key, Secret text, owner text); insert into t values (1, 's', 'ana');`);
    const exec: Exec = async (sql, params) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    const ana = createData({ exec, access: { tables: { t: { list: "owner = auth.id", update: "owner = auth.id", hidden: ["secret"], readonly: ["OWNER"] } } } }).as({ id: "ana" });
    expect(await ana.list("t")).toEqual([{ id: 1, owner: "ana" }]);
    expect(await code(ana.list("t", { columns: ["Secret"] }))).toBe("hidden_column");
    expect(await code(ana.update("t", [{ column: "id", op: "eq", value: 1 }], { owner: "gio" }))).toBe("readonly_column");
  });

  it("warns that a negated rule lets the signed-out in", () => {
    const found = checkAccess({ tables: { posts: { list: "!exists(blocks, blocker = row.owner && blocked = auth.id)", view: "auth.id != null && !exists(blocks, blocked = auth.id)" } } });
    expect(found.map((f) => f.message)).toEqual([expect.stringMatching(/^list: a ! or != on auth/)]);
  });
});

describe("admin", () => {
  it("sees and changes everything, and leaves people's rules as they were", async () => {
    const { data, gio } = project();
    const admin = data.admin();
    expect(ids(await admin.list("notes"))).toEqual(["n1", "n2", "n3"]);
    expect((await admin.list("notes", { columns: ["secret_note"] })).length).toBe(3);
    expect(ids(await admin.list("unruled"))).toEqual([]);
    // The rules a person gets are not the admin's, whichever ran first.
    expect(ids(await gio.list("notes"))).toEqual(["n3"]);
    expect(await gio.get("notes", "n1")).toBeNull();
  });
});

describe("the rule language", () => {
  it("parses what rules say", () => {
    for (const rule of [
      "",
      "author = auth.id",
      "auth.role = 'admin' || (published = true && tenant = auth.tenant)",
      MEMBER,
      "status in ['draft', 'sent'] && !(price > 10)",
      "auth.id != null && price >= -5",
    ]) {
      expect(() => parseRule(rule)).not.toThrow();
    }
  });

  it("refuses SQL and broken rules", () => {
    for (const rule of ["1; drop table notes", "author = 'x", "a.b.c = 1", "x.y = 1", "exists(notes)", "(a = 1", "a = = 1", "select * from x"]) {
      expect(() => parseRule(rule), rule).toThrow(AccessError);
    }
  });
});

describe("checking a project's rules", () => {
  it("finds what Supabase's advisor finds", () => {
    const schema = new Map([
      ["notes", new Set(["id", "tenant_id", "owner_id", "body", "api_key"])],
      ["memberships", new Set(["tenant_id", "user_id"])],
      ["_base_user", new Set(["id"])],
    ]);
    const found = checkAccess(
      {
        tables: {
          notes: { list: `${MEMBER} || auth.name = 'boss'`, update: "", delete: "nope = 1" },
          _base_user: { list: "id = auth.id" },
          missing: { list: "" },
        },
      },
      schema,
    );
    const say = found.map((f) => `${f.level} ${f.table}: ${f.message}`);
    expect(say).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^warning notes: list: auth\.name/),
        expect.stringMatching(/^warning notes: update: anyone/),
        expect.stringMatching(/^error notes: delete: no such column: nope/),
        expect.stringMatching(/^warning notes: readable columns that look secret.*api_key/),
        expect.stringMatching(/^error _base_user: base's own tables/),
        expect.stringMatching(/^error missing: no such table/),
      ]),
    );
  });

  it("finds nothing in the rules these tests use", () => {
    const schema = new Map<string, Set<string>>();
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    for (const { name } of db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]) {
      schema.set(name, new Set((db.prepare(`pragma table_info("${name}")`).all() as { name: string }[]).map((c) => c.name)));
    }
    expect(checkAccess(ACCESS, schema)).toEqual([]);
  });
});

describe("defaults", () => {
  it("lets create's rule see the default the table keeps, not NULL", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("create table t (id text primary key, approved_by text default 'system')");
    const exec: Exec = async (sql, params) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    const data = createData({ exec, access: { tables: { t: { list: "", create: "approved_by = null" } } } });
    expect(await code(data.as({ id: "u" }).create("t", { id: "a" }))).toBe("refused");
    expect(db.prepare("select count(*) n from t").all()).toEqual([{ n: 0 }]);
  });
});
