import { DatabaseSync } from "node:sqlite";

import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { type Access } from "../src/access.ts";
import { createData, type Exec } from "../src/data.ts";
import { createRest } from "../src/rest.ts";

// supabase-js, unchanged, against the handler: the calls Unichat's code makes.
const SCHEMA = `
  create table tenants (id text primary key, name text, secret text);
  create table memberships (tenant_id text references tenants(id), user_id text, role text);
  create table notes (
    id text primary key, tenant_id text not null references tenants(id), owner_id text, body text,
    pinned boolean default 0, meta json text, created_at text not null default '2026-01-01'
  );
  create table products (tenant_id text not null, external_id text not null, title text, price integer, unique (tenant_id, external_id));
  create table plans (id integer primary key, name text, is_active boolean, features json text);
`;

const MEMBER = "exists(memberships, tenant_id = row.tenant_id && user_id = auth.id)";

const ACCESS: Access = {
  tables: {
    tenants: { list: "exists(memberships, tenant_id = row.id && user_id = auth.id)", hidden: ["secret"] },
    memberships: { list: "user_id = auth.id" },
    notes: {
      list: MEMBER,
      create: MEMBER,
      update: "owner_id = auth.id",
      delete: "owner_id = auth.id",
      readonly: ["created_at"],
      fill: { owner_id: "auth.id" },
    },
    products: { list: MEMBER, create: MEMBER, update: MEMBER },
    plans: { list: "" },
  },
};

function project(options: { origins?: string[] } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.exec(`
    insert into tenants values ('t1', 'Shop one', 'k1'), ('t2', 'Shop two', 'k2');
    insert into memberships values ('t1', 'ana', 'admin'), ('t1', 'beka', 'member'), ('t2', 'gio', 'admin');
    insert into notes (id, tenant_id, owner_id, body, pinned, meta) values
      ('n1', 't1', 'ana', 'milk', 1, '{"tags":["a"]}'), ('n2', 't1', 'beka', 'bread', 0, null), ('n3', 't2', 'gio', 'gio note', 0, null);
    insert into products values ('t1', 'p1', 'Shirt', 10), ('t2', 'p1', 'Other shirt', 99);
    insert into plans (name, is_active, features) values ('Start', 1, '["chat"]'), ('Old', 0, null);
  `);
  const exec: Exec = async (sql, params) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  const data = createData({ exec, access: ACCESS });
  const rest = createRest({
    data,
    auth: async (request) => {
      const id = request.headers.get("x-test-user");
      return id ? { id } : null;
    },
    rpc: {
      whoami: async (args, { auth }) => ({ id: auth?.id ?? null, args }),
      plans: { get: true, handler: async () => ["Start"] },
    },
    origins: options.origins,
  });
  const client = (user?: string, headers: Record<string, string> = {}) =>
    createClient("https://app.test", "unisites", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { ...(user ? { "x-test-user": user } : {}), ...headers },
        fetch: (input, init) => rest.handler(new Request(input, init)),
      },
    });
  const raw = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
  return { rest, raw, ana: client("ana"), beka: client("beka"), gio: client("gio"), nobody: client(), client };
}

const ids = (rows: { id?: unknown }[] | null) => (rows ?? []).map((r) => r.id).sort();

describe("reading", () => {
  it("lists through the rules, with filters, order and limits", async () => {
    const { ana, gio, nobody } = project();
    expect(ids((await ana.from("notes").select("*")).data)).toEqual(["n1", "n2"]);
    expect(ids((await gio.from("notes").select("*")).data)).toEqual(["n3"]);
    expect((await nobody.from("notes").select("*")).data).toEqual([]);
    const { data } = await ana.from("notes").select("id, body").order("id", { ascending: false }).limit(1);
    expect(data).toEqual([{ id: "n2", body: "bread" }]);
    expect((await ana.from("notes").select("id").range(1, 1).order("id")).data).toEqual([{ id: "n2" }]);
  });

  it("takes the filters Unichat uses", async () => {
    const { ana } = project();
    const q = () => ana.from("notes").select("id");
    expect(ids((await q().eq("owner_id", "ana")).data)).toEqual(["n1"]);
    expect(ids((await q().neq("owner_id", "ana")).data)).toEqual(["n2"]);
    expect(ids((await q().in("id", ["n1", "n3"])).data)).toEqual(["n1"]);
    expect(ids((await q().is("meta", null)).data)).toEqual(["n2"]);
    expect(ids((await q().not("meta", "is", null)).data)).toEqual(["n1"]);
    expect(ids((await q().ilike("body", "%MILK%")).data)).toEqual(["n1"]);
    expect(ids((await q().like("body", "br*")).data)).toEqual(["n2"]);
    expect(ids((await q().or("body.eq.milk,owner_id.eq.beka")).data)).toEqual(["n1", "n2"]);
    expect(ids((await q().or("and(body.eq.milk,owner_id.eq.beka),id.eq.n2")).data)).toEqual(["n2"]);
    expect(ids((await q().gte("created_at", "2026-01-01").lt("id", "n2")).data)).toEqual(["n1"]);
    expect(ids((await q().eq("pinned", true)).data)).toEqual(["n1"]);
    expect(ids((await q().match({ owner_id: "beka", body: "bread" })).data)).toEqual(["n2"]);
    expect(ids((await q().in("id", ['n1,"x"', "n2"])).data)).toEqual(["n2"]);
  });

  it("never lets a filter open what the rule closes", async () => {
    const { gio } = project();
    expect(ids((await gio.from("notes").select("id").or("tenant_id.eq.t1,id.neq.x")).data)).toEqual(["n3"]);
    expect(ids((await gio.from("notes").select("id").not("tenant_id", "eq", "t1")).data)).toEqual(["n3"]);
  });

  it("counts what the person may see", async () => {
    const { ana, nobody } = project();
    const head = await ana.from("notes").select("id", { count: "exact", head: true });
    expect(head.error).toBeNull();
    expect(head.count).toBe(2);
    expect(head.data).toBeNull();
    const some = await ana.from("notes").select("id", { count: "exact" }).limit(1);
    expect(some.count).toBe(2);
    expect(some.data).toHaveLength(1);
    expect((await nobody.from("notes").select("*", { count: "exact", head: true })).count).toBe(0);
  });

  it("gives one row for single() and maybeSingle()", async () => {
    const { ana } = project();
    expect((await ana.from("notes").select("id").eq("id", "n1").single()).data).toEqual({ id: "n1" });
    expect((await ana.from("notes").select("id").eq("id", "n1").maybeSingle()).data).toEqual({ id: "n1" });
    expect((await ana.from("notes").select("id").eq("id", "n3").maybeSingle()).data).toBeNull();
    const none = await ana.from("notes").select("id").eq("id", "n3").single();
    expect(none.error?.code).toBe("PGRST116");
    expect((await ana.from("notes").select("id").single()).error?.code).toBe("PGRST116");
    expect((await ana.from("notes").select("id").maybeSingle()).error?.code).toBe("PGRST116");
  });

  it("answers BOOLEAN as true or false and JSON parsed", async () => {
    const { nobody, ana } = project();
    const { data } = await nobody.from("plans").select("name, is_active, features").order("id");
    expect(data).toEqual([
      { name: "Start", is_active: true, features: ["chat"] },
      { name: "Old", is_active: false, features: null },
    ]);
    expect((await ana.from("notes").select("meta").eq("id", "n1").single()).data).toEqual({ meta: { tags: ["a"] } });
    expect((await nobody.from("plans").select("name").eq("is_active", false)).data).toEqual([{ name: "Old" }]);
  });

  it("renames with alias:column", async () => {
    const { ana } = project();
    expect((await ana.from("notes").select("key:id, text:body").eq("id", "n1")).data).toEqual([{ key: "n1", text: "milk" }]);
  });
});

describe("embeds", () => {
  it("embeds the row a foreign key points to, as Unichat's tenants(...) does", async () => {
    const { ana, gio } = project();
    const { data, error } = await ana.from("memberships").select("role, tenant_id, tenants(id, name)").eq("user_id", "ana");
    expect(error).toBeNull();
    expect(data).toEqual([{ role: "admin", tenant_id: "t1", tenants: { id: "t1", name: "Shop one" } }]);
    // Without the join column asked for, it is used and not shown.
    expect((await gio.from("memberships").select("role, shop:tenants(name)")).data).toEqual([{ role: "admin", shop: { name: "Shop two" } }]);
  });

  it("embeds the rows that point back, through their own rules", async () => {
    const { ana, gio } = project();
    const { data } = await ana.from("tenants").select("id, notes(id, body)");
    expect(data).toEqual([{ id: "t1", notes: [{ id: "n1", body: "milk" }, { id: "n2", body: "bread" }] }]);
    // gio sees only tenant t2 and its note.
    expect((await gio.from("tenants").select("id, notes(id)")).data).toEqual([{ id: "t2", notes: [{ id: "n3" }] }]);
  });

  it("nests, and gives null or [] where the rules show nothing", async () => {
    const { ana } = project();
    const { data } = await ana.from("notes").select("id, tenants(name, memberships(user_id))").eq("id", "n1");
    // memberships' rule shows ana only her own.
    expect(data).toEqual([{ id: "n1", tenants: { name: "Shop one", memberships: [{ user_id: "ana" }] } }]);
  });

  it("refuses a relation that is not there, or not served", async () => {
    const { ana } = project();
    expect((await ana.from("notes").select("id, plans(name)")).error?.code).toBe("PGRST200");
    expect((await ana.from("notes").select("id, nope(name)")).error?.code).toBe("PGRST200");
    expect((await ana.from("tenants").select("id, secret")).error?.code).toBe("42703");
    expect((await ana.from("notes").select("id, tenants!inner(name)")).error?.code).toBe("PGRST100");
  });
});

describe("writing", () => {
  it("inserts with the session's own values, and returns the row on select()", async () => {
    const { ana, raw } = project();
    const { data, error, status } = await ana.from("notes").insert({ id: "n9", tenant_id: "t1", body: "new" }).select("id, owner_id, created_at, pinned").single();
    expect(error).toBeNull();
    expect(status).toBe(201);
    expect(data).toEqual({ id: "n9", owner_id: "ana", created_at: "2026-01-01", pinned: false });
    expect(raw("select owner_id from notes where id = 'n9'")).toEqual([{ owner_id: "ana" }]);
  });

  it("takes a column's default where a row leaves it out", async () => {
    const { ana, raw } = project();
    const { error } = await ana.from("notes").insert([
      { id: "a", tenant_id: "t1", body: "x", pinned: true },
      { id: "b", tenant_id: "t1" },
    ]);
    expect(error).toBeNull();
    expect(raw("select id, body, pinned, created_at from notes where id in ('a', 'b') order by id")).toEqual([
      { id: "a", body: "x", pinned: 1, created_at: "2026-01-01" },
      { id: "b", body: null, pinned: 0, created_at: "2026-01-01" },
    ]);
  });

  it("refuses a row in another tenant, and writes none of the batch", async () => {
    const { ana, raw } = project();
    const { error, status } = await ana.from("notes").insert([
      { id: "ok", tenant_id: "t1" },
      { id: "bad", tenant_id: "t2" },
    ]);
    expect(status).toBe(403);
    expect(error?.code).toBe("42501");
    expect(raw("select id from notes where id in ('ok', 'bad')")).toEqual([]);
  });

  it("refuses the session's own columns and readonly ones", async () => {
    const { ana } = project();
    expect((await ana.from("notes").insert({ id: "x", tenant_id: "t1", owner_id: "gio" })).error?.code).toBe("42501");
    expect((await ana.from("notes").update({ created_at: "2000" }).eq("id", "n1")).error?.code).toBe("42501");
  });

  it("updates and deletes only what the rules allow", async () => {
    const { ana, raw } = project();
    const mine = await ana.from("notes").update({ body: "oat milk" }).eq("id", "n1").select();
    expect(mine.data?.map((r) => r.body)).toEqual(["oat milk"]);
    const theirs = await ana.from("notes").update({ body: "mine now" }).eq("id", "n2").select();
    expect(theirs.data).toEqual([]);
    expect(raw("select body from notes where id = 'n2'")).toEqual([{ body: "bread" }]);
    const gone = await ana.from("notes").delete().in("id", ["n1", "n2", "n3"]).select("id");
    expect(gone.data).toEqual([{ id: "n1" }]);
    const plain = await ana.from("notes").delete().eq("id", "n2");
    expect(plain.status).toBe(204);
    expect(raw("select id from notes order by id")).toEqual([{ id: "n2" }, { id: "n3" }]);
  });

  it("asks a change or delete for a filter", async () => {
    const { ana } = project();
    expect((await ana.from("notes").update({ body: "all" }).or("id.eq.n1,id.eq.n2")).error?.code).toBe("21000");
    expect((await ana.from("notes").delete()).error?.code).toBe("21000");
  });

  it("upserts on a UNIQUE index: new rows in, colliding ones changed", async () => {
    const { ana, raw } = project();
    const { data, error } = await ana
      .from("products")
      .upsert(
        [
          { tenant_id: "t1", external_id: "p1", title: "Shirt v2", price: 12 },
          { tenant_id: "t1", external_id: "p2", title: "Hat", price: 5 },
        ],
        { onConflict: "tenant_id,external_id" },
      )
      .select("external_id, title");
    expect(error).toBeNull();
    expect(data).toEqual([
      { external_id: "p1", title: "Shirt v2" },
      { external_id: "p2", title: "Hat" },
    ]);
    expect(raw("select tenant_id, external_id, title from products order by tenant_id, external_id")).toEqual([
      { tenant_id: "t1", external_id: "p1", title: "Shirt v2" },
      { tenant_id: "t1", external_id: "p2", title: "Hat" },
      { tenant_id: "t2", external_id: "p1", title: "Other shirt" },
    ]);
  });

  it("leaves a collision as it is with ignoreDuplicates", async () => {
    const { ana, raw } = project();
    const { error } = await ana.from("products").upsert({ tenant_id: "t1", external_id: "p1", title: "ignored" }, { onConflict: "tenant_id,external_id", ignoreDuplicates: true });
    expect(error).toBeNull();
    expect(raw("select title from products where tenant_id = 't1'")).toEqual([{ title: "Shirt" }]);
  });

  it("refuses an upsert that would change a row one may not, and writes nothing", async () => {
    const { gio, raw } = project();
    // gio is in t2; the row in t1 is not his to change, and t1 is not his to write in.
    const { error } = await gio.from("products").upsert(
      [
        { tenant_id: "t2", external_id: "p9", title: "fine" },
        { tenant_id: "t1", external_id: "p1", title: "taken over" },
      ],
      { onConflict: "tenant_id,external_id" },
    );
    expect(error?.code).toBe("42501");
    expect(raw("select count(*) n from products")).toEqual([{ n: 2 }]);
    expect(raw("select title from products where tenant_id = 't1'")).toEqual([{ title: "Shirt" }]);
  });

  it("refuses an upsert whose change the update rule closes, though create would allow the row", async () => {
    const { gio, raw } = project();
    // gio may create in t2; the existing t2 row is fine to change, but notes' owner check stops another's note.
    const { error } = await gio.from("notes").upsert({ id: "n2", tenant_id: "t2", body: "stolen" });
    expect(error?.code).toBe("42501");
    expect(raw("select tenant_id, body from notes where id = 'n2'")).toEqual([{ tenant_id: "t1", body: "bread" }]);
  });
});

describe("the edges", () => {
  it("does not serve a table without rules, nor say whether it exists", async () => {
    const { ana } = project();
    const a = await ana.from("no_such").select("*");
    const b = await ana.from("_base_user").select("*");
    expect([a.status, a.error?.code]).toEqual([404, "PGRST205"]);
    expect([b.status, b.error?.code]).toEqual([404, "PGRST205"]);
  });

  it("answers a hidden column as a missing one", async () => {
    const { ana } = project();
    const hidden = await ana.from("tenants").select("id").eq("secret", "k1");
    const missing = await ana.from("tenants").select("id").eq("nope", "k1");
    expect(hidden.error?.message).toBe("column tenants.secret does not exist");
    expect(missing.error?.code).toBe(hidden.error?.code);
  });

  it("refuses text where the column keeps numbers", async () => {
    const { nobody } = project();
    expect((await nobody.from("plans").select("id").eq("id", "1 or 1=1")).error?.code).toBe("22P02");
    expect((await nobody.from("plans").select("id").eq("id", "1")).data).toEqual([{ id: 1 }]);
  });

  it("calls the project's own functions", async () => {
    const { ana } = project();
    expect((await ana.rpc("whoami", { x: 1 })).data).toEqual({ id: "ana", args: { x: 1 } });
    expect((await ana.rpc("nope")).error?.code).toBe("PGRST202");
  });

  it("takes writes only from the project's own origin", async () => {
    const { client, raw } = project({ origins: ["capacitor://localhost"] });
    const other = client("ana", { origin: "https://evil.test" });
    expect((await other.from("notes").delete().eq("id", "n1")).status).toBe(403);
    expect((await other.from("notes").select("id")).data).toHaveLength(2);
    expect((await client("ana", { origin: "https://app.test" }).from("notes").update({ body: "same" }).eq("id", "n1")).error).toBeNull();
    expect((await client("ana", { origin: "capacitor://localhost" }).from("notes").update({ body: "app" }).eq("id", "n1")).error).toBeNull();
    expect(raw("select body from notes where id = 'n1'")).toEqual([{ body: "app" }]);
  });

  it("refuses a body that is not JSON", async () => {
    const { rest } = project();
    const res = await rest.handler(
      new Request("https://app.test/rest/v1/notes", { method: "POST", headers: { "content-type": "text/plain", "x-test-user": "ana" }, body: '{"id":"x","tenant_id":"t1"}' }),
    );
    expect(res.status).toBe(415);
  });

  it("says what it does not support instead of guessing", async () => {
    const { ana } = project();
    expect((await ana.from("notes").select("id").contains("meta", { tags: ["a"] })).error?.code).toBe("PGRST100");
    expect((await ana.from("notes").select("id::text")).error?.code).toBe("PGRST100");
    expect((await ana.from("tenants").select("id, notes(id)").eq("notes.body", "milk")).error?.code).toBe("PGRST100");
  });

  it("runs a function from GET only when it says it changes nothing, and never for another site", async () => {
    const { rest, client } = project();
    const get = (fn: string, headers: Record<string, string> = {}) =>
      rest.handler(new Request(`https://app.test/rest/v1/rpc/${fn}`, { headers: { "x-test-user": "ana", ...headers } }));
    expect((await get("whoami")).status).toBe(405);
    expect((await get("plans")).status).toBe(200);
    expect((await get("plans", { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await client("ana", { origin: "https://evil.unisites.ge" }).rpc("whoami")).status).toBe(403);
  });

  it("keeps a request's embeds within a budget", async () => {
    const { ana } = project();
    const many = Array.from({ length: 21 }, (_, i) => `t${i}:tenants(id)`).join(",");
    expect((await ana.from("notes").select(`id,${many}`)).error?.code).toBe("PGRST100");
  });

  it("changes no row when single() would change more than one", async () => {
    const { ana, raw } = project();
    raw("update notes set owner_id = 'ana' where id = 'n2'");
    const both = await ana.from("notes").update({ body: "x" }).eq("tenant_id", "t1").select().single();
    expect(both.error?.code).toBe("PGRST116");
    const two = await ana.from("notes").delete().eq("tenant_id", "t1").select().single();
    expect(two.error?.code).toBe("PGRST116");
    expect(raw("select body from notes where tenant_id = 't1' order by id")).toEqual([{ body: "milk" }, { body: "bread" }]);
    const one = await ana.from("notes").update({ body: "only" }).eq("id", "n1").select("body").single();
    expect(one.data).toEqual({ body: "only" });
  });

  it("checks create's rule against the default a row will keep", async () => {
    const { ana, raw } = project();
    // notes' rule has no say on pinned; a rule on a defaulted column sees the default.
    const { error } = await ana.from("notes").insert({ id: "d", tenant_id: "t1" });
    expect(error).toBeNull();
    expect(raw("select pinned, created_at from notes where id = 'd'")).toEqual([{ pinned: 0, created_at: "2026-01-01" }]);
  });

  it("answers a broken path or a huge body without a crash", async () => {
    const { rest } = project();
    expect((await rest.handler(new Request("https://app.test/rest/v1/%E0"))).status).toBe(404);
    const big = await rest.handler(
      new Request("https://app.test/rest/v1/notes", { method: "POST", headers: { "content-type": "application/json", "x-test-user": "ana" }, body: `"${"x".repeat(3 * 1024 * 1024)}"` }),
    );
    expect(big.status).toBe(413);
  });
});
