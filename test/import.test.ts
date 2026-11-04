import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { createData, type Exec } from "../src/data.ts";
import { CATALOG_SQL, type Catalog } from "../src/import/catalog.ts";
import { parseExpr } from "../src/import/pg.ts";
import bcrypt from "bcryptjs";

import { countRows, exportData } from "../src/import/data.ts";
import { buildReport, type Report } from "../src/import/report.ts";
import { project as baseProject } from "./support/project.ts";
import { defaultOf, policyRule } from "../src/import/translate.ts";
import { verifyDrafts } from "../src/import/verify.ts";

// A Supabase-shaped Postgres (test/support/supabase.sql, Unichat's own policy forms) in PGlite:
// the catalog query runs on real Postgres, and the translated rules are held against Postgres' RLS.
const U = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
const T1 = "aaaaaaaa-0000-0000-0000-000000000001";
const T2 = "aaaaaaaa-0000-0000-0000-000000000002";

let pg: PGlite;
let catalog: Catalog;
let report: Report;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(new URL("./support/supabase.sql", import.meta.url), "utf8"));
  await pg.exec(`
    grant usage on schema auth to anon, authenticated;
    insert into public.profiles (id, full_name, is_platform_admin) values
      ('${U(1)}', 'Ana', false), ('${U(2)}', 'Admin', true), ('${U(3)}', 'Gio', false);
    insert into public.tenants (id, name, custom_price) values ('${T1}', 'Shop one', 10.5), ('${T2}', 'Shop two', null);
    insert into public.memberships values ('${T1}', '${U(1)}', 'owner'), ('${T2}', '${U(3)}', 'member');
    insert into public.conversations (id, tenant_id, tags) values
      ('cccccccc-0000-0000-0000-000000000001', '${T1}', '{vip}'), ('cccccccc-0000-0000-0000-000000000002', '${T2}', '{}');
    insert into public.messages (tenant_id, conversation_id, body, direction) values
      ('${T1}', 'cccccccc-0000-0000-0000-000000000001', 'hi', 'inbound'), ('${T2}', 'cccccccc-0000-0000-0000-000000000002', 'yo', 'outbound');
    insert into public.plans values ('start', 'Start', 10, false), ('pro', 'Pro', 30, true);
    insert into public.device_tokens values ('${U(1)}', 'tok-ana'), ('${U(3)}', 'tok-gio');
    analyze;
  `);
  catalog = ((await pg.query(CATALOG_SQL)).rows[0] as { catalog: Catalog }).catalog;
  report = buildReport(catalog, { project: "fixture", verify: verifyDrafts });
});

describe("the catalog", () => {
  it("reads the tables, policies, functions, realtime, storage and sign-in", () => {
    expect(catalog.tables.map((t) => t.name)).toContain("messages");
    expect(catalog.policies.filter((p) => p.schema === "public")).toHaveLength(13);
    expect(catalog.functions.map((f) => f.name)).toEqual(["dashboard_stats", "is_platform_admin", "is_tenant_owner", "my_tenant_ids", "touch_updated_at"]);
    expect(catalog.realtime).toEqual(["conversations", "messages"]);
    expect(catalog.buckets.map((b) => [b.id, b.objects, b.bytes])).toEqual([["avatars", 1, 1200], ["media", 0, 0]]);
    expect(catalog.auth).toMatchObject({ users: 3, passwords: 2, bcrypt: 2, banned: 1, providers: { email: 1, phone: 1, google: 1 } });
  });
});

describe("rules", () => {
  it("inlines Unichat's helper functions into exists()", () => {
    const t = report.access.tables;
    expect(t.conversations!.list).toBe(
      "auth.id != null && (exists(memberships, tenant_id = row.tenant_id && user_id = auth.id) || exists(profiles, is_platform_admin = true && id = auth.id))",
    );
    expect(t.memberships!.create).toContain("exists(memberships, user_id = auth.id && tenant_id = row.tenant_id && role = 'owner')");
    expect(t.device_tokens!.list).toBe("user_id = auth.id");
    expect(t.plans!.list).toContain("auth.id != null");
  });

  it("makes column grants hidden and readonly", () => {
    expect(report.access.tables.tenants!.hidden).toEqual(["custom_price"]);
    expect(report.access.tables.tenants!.readonly).toEqual(["plan", "created_at"]);
    expect(report.access.tables.profiles!.readonly).toEqual(["is_platform_admin", "created_at"]);
  });

  it("leaves closed what it cannot translate, and a table without row level security, and says so", () => {
    expect(report.access.tables.scores).toEqual({});
    expect(report.access.tables.open_table).toBeUndefined();
    const manual = report.items.filter((i) => i.level === "manual").map((i) => `${i.area} ${i.name}`);
    expect(manual).toContain("rules scores");
    expect(manual).toContain("rules open_table");
    expect(report.markdown).toContain("the operator ~");
  });

  it("translates the forms Postgres prints", () => {
    // Tables without row level security, so a subquery reads them as they are.
    const all = { select: true, insert: true, update: true, delete: true };
    const table = (name: string, cols: [string, string][]) =>
      [name, { name, rls: false, rows: 0, bytes: 0, replica: "d", privileges: { anon: all, authenticated: all }, constraints: [], indexes: [], triggers: [],
        columns: cols.map(([n, udt]) => ({ name: n, type: udt, udt, category: "S", notnull: false, default: null, identity: null, generated: null, enum: null, grants: { anon: all, authenticated: all } })) }] as const;
    const ctx = {
      tables: new Map([table("notes", [["id", "uuid"], ["owner", "uuid"], ["tenant_id", "uuid"], ["status", "text"]]), table("m", [["tenant_id", "uuid"], ["user_id", "uuid"]])]) as never,
      policies: [],
      functions: [],
    };
    expect(policyRule("notes", "(auth.role() = 'authenticated'::text)", ctx)).toBe("auth.id != null");
    expect(policyRule("notes", "(status = ANY (ARRAY['a'::text, 'b'::text]))", ctx)).toBe("status in ['a', 'b']");
    expect(policyRule("notes", "((owner = auth.uid()) AND (status IS NOT NULL))", ctx)).toBe("owner = auth.id && status != null");
    expect(policyRule("notes", "(owner = ((auth.jwt() ->> 'sub'::text))::uuid)", ctx)).toBe("owner = auth.id");
    expect(policyRule("notes", "true", ctx)).toBe("");
    expect(policyRule("notes", "(EXISTS ( SELECT 1 FROM m WHERE ((m.tenant_id = notes.tenant_id) AND (m.user_id = auth.uid()))))", ctx)).toBe(
      "exists(m, tenant_id = row.tenant_id && user_id = auth.id)",
    );
    expect(policyRule("notes", "(owner IN ( SELECT m.user_id FROM m WHERE (m.tenant_id IN ( SELECT m2.tenant_id FROM m m2 WHERE (m2.user_id = m.user_id)))))", ctx)).toBe(
      "exists(m, user_id = row.owner && exists(m, tenant_id = up.tenant_id && user_id = up.user_id))",
    );
  });
});

describe("the drafts", () => {
  it("make a schema SQLite runs, with the checks, indexes and the updated_at trigger", () => {
    expect(report.items.find((i) => i.name === "schema.sql")!.level).toBe("auto");
    expect(report.schema).toContain(`CHECK (("direction" IN ('inbound', 'outbound')))`);
    expect(report.schema).toContain(`"status" TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'pending', 'closed'))`);
    expect(report.schema).toContain(`CREATE UNIQUE INDEX "messages_one_per_minute" ON "messages" ("conversation_id", "created_at") WHERE ("direction" = 'inbound')`);
    expect(report.schema).toContain(`"id" INTEGER PRIMARY KEY`);
    expect(report.schema).toContain(`REFERENCES "_base_user" ("id") ON DELETE CASCADE`);
    expect(report.schema).toContain(`CREATE TRIGGER "conversations_conversations_touch"`);
    expect(report.schema).not.toContain("conversations_search");
  });

  it("turns defaults into SQLite's", () => {
    expect(defaultOf("gen_random_uuid()", "TEXT").sql).toMatch(/randomblob/);
    expect(defaultOf("timezone('utc'::text, now())", "TEXT").sql).toBe("(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
    expect(defaultOf("'{}'::text[]", "JSON TEXT").sql).toBe("'[]'");
    expect(defaultOf("auth.uid()", "TEXT").fill).toBe("auth.id");
    expect(defaultOf("nextval('x_seq'::regclass)", "INTEGER").sql).toBeNull();
    expect(parseExpr("'it''s'::text")).toEqual({ k: "cast", x: { k: "lit", v: "it's" }, type: "text" });
  });
});

describe("the same answers as Postgres", () => {
  const PEOPLE = [null, U(1), U(2), U(3)];
  const TABLES: Record<string, string> = {
    profiles: "id",
    tenants: "id",
    memberships: "tenant_id || '/' || user_id",
    conversations: "id",
    messages: "body",
    plans: "id",
    device_tokens: "token",
  };

  async function sqlite() {
    const db = new DatabaseSync(":memory:");
    for (const f of readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
    db.exec(report.schema);
    const now = new Date().toISOString();
    for (const n of [1, 2, 3]) db.prepare(`insert into _base_user (id, name, email, emailVerified, createdAt, updatedAt) values (?, 'x', ?, 1, ?, ?)`).run(U(n), `u${n}@test`, now, now);
    const exec: Exec = async (sql, params) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    const data = createData({ exec, access: report.access });
    // The rows as Postgres has them, as the import will move them.
    for (const table of Object.keys(TABLES)) {
      const rows = (await pg.query(`select * from public.${table}`)).rows as Record<string, unknown>[];
      const real = new Set(catalog.tables.find((t) => t.name === table)!.columns.filter((c) => ["numeric", "float4", "float8"].includes(c.udt)).map((c) => c.name));
      const moved = rows.map((r) =>
        Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : real.has(k) && typeof v === "string" ? Number(v) : v])),
      );
      if (moved.length) await data.admin().create(table, moved);
    }
    return data;
  }

  it("lets each person read the same rows of every table", async () => {
    const data = await sqlite();
    for (const who of PEOPLE) {
      for (const [table, key] of Object.entries(TABLES)) {
        await pg.query("reset role");
        await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [who ?? ""]);
        await pg.query(`set role ${who ? "authenticated" : "anon"}`);
        // A refusal (no grant for the role) reads nothing, as an empty answer does.
        const theirs = ((await pg.query(`select ${key} as k from public.${table}`).catch(() => ({ rows: [] }))).rows as { k: string }[]).map((r) => r.k).sort();
        await pg.query("reset role");
        const db = data.as(who ? { id: who } : null);
        const ours = (await db.list(table)).map((r) => (table === "memberships" ? `${r.tenant_id}/${r.user_id}` : String(r[key === "body" ? "body" : key]))).sort();
        expect(ours, `${table} for ${who ?? "the signed out"}`).toEqual(theirs);
      }
    }
  });

  it("lets each person create the same rows", async () => {
    const data = await sqlite();
    const tries = [
      { table: "memberships", row: { tenant_id: T1, user_id: U(3), role: "member" } },
      { table: "memberships", row: { tenant_id: T2, user_id: U(1), role: "member" } },
      { table: "messages", row: { tenant_id: T2, body: "x", direction: "inbound" } },
      { table: "device_tokens", row: { user_id: U(3), token: "tok-new" } },
    ];
    const outcomes = new Set<boolean>();
    for (const who of PEOPLE.slice(1)) {
      for (const { table, row } of tries) {
        await pg.query("reset role");
        await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [who!]);
        await pg.query("begin");
        await pg.query("set local role authenticated");
        const cols = Object.keys(row);
        let theirs = true;
        try {
          await pg.query(`insert into public.${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
        } catch {
          theirs = false;
        }
        await pg.query("rollback");
        let ours = true;
        try {
          await data.as({ id: who }).create(table, row);
          await data.admin().delete(table, Object.entries(row).map(([column, value]) => ({ column, op: "eq" as const, value })));
        } catch {
          ours = false;
        }
        expect(ours, `${who} creating in ${table}: ${JSON.stringify(row)}`).toBe(theirs);
        outcomes.add(theirs);
      }
    }
    expect([...outcomes].sort()).toEqual([false, true]);
  });
});

// The review's cases (each a policy form that once came out wider): the draft may let in fewer
// than Postgres, never more, and where it says "auto" it lets in the same.
describe("never more than Postgres", () => {
  const BASE = readFileSync(new URL("./support/supabase.sql", import.meta.url), "utf8").split("-- A Unichat-shaped project")[0]!;
  const PEOPLE = [null, U(1), U(2), U(3)];

  async function project(sql: string) {
    const pg = new PGlite();
    await pg.exec(BASE);
    await pg.exec("grant usage on schema auth to anon, authenticated;");
    await pg.exec(sql);
    const catalog = ((await pg.query(CATALOG_SQL)).rows[0] as { catalog: Catalog }).catalog;
    const report = buildReport(catalog);
    const db = new DatabaseSync(":memory:");
    for (const f of readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
    db.exec(report.schema);
    const now = new Date().toISOString();
    for (const n of [1, 2, 3]) db.prepare(`insert into _base_user (id, name, email, emailVerified, createdAt, updatedAt) values (?, 'x', ?, 1, ?, ?)`).run(U(n), `u${n}@t`, now, now);
    const exec: Exec = async (s, p) => db.prepare(s).all(...(p as never[])) as Record<string, unknown>[];
    const data = createData({ exec, access: report.access });
    for (const t of catalog.tables) {
      const rows = (await pg.query(`select * from public.${t.name}`)).rows as Record<string, unknown>[];
      // A row the draft cannot take (a column access.json cannot name) stays behind.
      if (rows.length) await data.admin().create(t.name, rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])))).catch(() => undefined);
    }
    const as = async <T,>(who: string | null, f: () => Promise<T>) => {
      await pg.query("reset role");
      await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [who ?? ""]);
      await pg.query(`set role ${who ? "authenticated" : "anon"}`);
      try {
        return await f();
      } finally {
        await pg.query("reset role");
      }
    };
    /** Ids each person reads: Postgres', and the draft's (nothing where either refuses). */
    const reads = async (table: string) => {
      const out: { who: string | null; theirs: unknown[]; ours: unknown[] }[] = [];
      for (const who of PEOPLE) {
        const theirs = await as(who, async () => ((await pg.query(`select id from public.${table}`).catch(() => ({ rows: [] }))).rows as { id: unknown }[]).map((r) => r.id).sort());
        const ours = (await data.as(who ? { id: who } : null).list(table, { columns: ["id"] }).catch(() => [])).map((r) => r.id).sort();
        out.push({ who, theirs, ours });
      }
      return out;
    };
    const writes = async (who: string, sql: string, ours: (d: ReturnType<typeof data.as>) => Promise<{ count: number }>) => {
      await pg.query("reset role");
      await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [who]);
      await pg.query("begin");
      await pg.query("set local role authenticated");
      const theirs = await pg.query(sql).then((r) => (r.affectedRows ?? 0) > 0, () => false);
      await pg.query("rollback");
      const mine = await ours(data.as({ id: who })).then((r) => r.count > 0, () => false);
      return { theirs, mine };
    };
    return { report, reads, writes, level: (t: string) => report.items.find((i) => i.area === "rules" && i.name === t)?.level };
  }

  type Reads = { who: string | null; theirs: unknown[]; ours: unknown[] }[];
  const within = (r: Reads) => {
    for (const x of r) for (const id of x.ours) expect(x.theirs, `${String(id)} for ${x.who ?? "the signed out"}`).toContain(id);
  };
  const same = (r: Reads) => {
    for (const x of r) expect(x.ours, `for ${x.who ?? "the signed out"}`).toEqual(x.theirs);
  };

  it("keeps NOT over what may be NULL, and NOT IN, closed", async () => {
    const p = await project(`
      create table public.profiles (id uuid primary key, banned boolean);
      create table public.notes (id int primary key);
      create table public.notes2 (id int primary key);
      create table public.blocks (id int primary key, blocker uuid, blocked uuid);
      create table public.posts (id int primary key, owner uuid);
      create function public.is_banned() returns boolean language sql stable security definer as $$ select banned from public.profiles where id = auth.uid() $$;
      alter table public.notes enable row level security;
      alter table public.notes2 enable row level security;
      alter table public.posts enable row level security;
      create policy p on public.notes for select using (not public.is_banned());
      create policy p on public.notes2 for select using (not (select banned from public.profiles where id = auth.uid()));
      create policy p on public.posts for select using (auth.uid() not in (select blocked from public.blocks where blocker = posts.owner));
      grant select on all tables in schema public to anon, authenticated;
      insert into public.profiles values ('${U(1)}', false), ('${U(2)}', null);
      insert into public.notes values (1); insert into public.notes2 values (1);
      insert into public.posts values (1, '${U(1)}'), (2, '${U(2)}');
      insert into public.blocks values (1, '${U(1)}', '${U(3)}'), (2, '${U(2)}', null);
    `);
    for (const t of ["notes", "notes2", "posts"]) {
      within(await p.reads(t));
      expect(p.level(t), t).toBe("manual");
    }
  });

  it("reads an aliased self-join and a subquery's table as Postgres does", async () => {
    const p = await project(`
      create table public.memberships (tenant_id uuid, user_id uuid, role text, primary key (tenant_id, user_id));
      alter table public.memberships enable row level security;
      create policy read_own on public.memberships for select using (user_id = auth.uid());
      create policy owners_add on public.memberships for insert to authenticated with check (
        exists (select 1 from public.memberships m where m.tenant_id = memberships.tenant_id and m.user_id = auth.uid() and m.role = 'owner'));
      create table public.shares (id int primary key, doc_id int, user_id uuid);
      create table public.docs (id int primary key);
      alter table public.shares enable row level security;
      alter table public.docs enable row level security;
      create policy mine on public.shares for select using (user_id = auth.uid());
      create policy shared on public.docs for select using (exists (select 1 from public.shares where shares.doc_id = docs.id));
      grant select, insert, update on all tables in schema public to anon, authenticated;
      insert into public.memberships values ('${T1}', '${U(1)}', 'owner'), ('${T2}', '${U(3)}', 'owner');
      insert into public.docs values (1), (2);
      insert into public.shares values (1, 1, '${U(1)}'), (2, 2, '${U(3)}');
    `);
    same(await p.reads("docs"));
    for (const [who, tenant] of [[U(1), T1], [U(1), T2], [U(3), T2]] as const) {
      const w = await p.writes(who, `insert into public.memberships values ('${tenant}', '${U(2)}', 'member')`, (d) => d.create("memberships", { tenant_id: tenant, user_id: U(2), role: "member" }));
      expect(w.mine, `${who} adding to ${tenant}`).toBe(w.theirs);
    }
  });

  it("keeps NOT BETWEEN, grants per role and per command, and restrictive policies for one role", async () => {
    const p = await project(`
      create table public.scores (id int primary key, score int);
      create function public.outlier(s int) returns boolean language sql immutable as $$ select s not between 0 and 100 $$;
      alter table public.scores enable row level security;
      create policy p on public.scores for select using (public.outlier(score));
      create table public.people (id int primary key, name text, email text);
      alter table public.people enable row level security;
      create policy p on public.people for select using (true);
      grant select (id, name) on public.people to anon;
      grant select on public.people to authenticated;
      create table public.items (id int primary key, owner uuid default auth.uid(), body text);
      alter table public.items enable row level security;
      create policy p on public.items for all using (owner = auth.uid());
      grant select, update on public.items to authenticated;
      create table public.pub (id int primary key, hidden boolean);
      alter table public.pub enable row level security;
      create policy open on public.pub for select using (true);
      create policy r on public.pub as restrictive for select to authenticated using (not hidden);
      grant select on public.scores, public.pub to anon, authenticated;
      insert into public.scores values (1, 50), (2, 500);
      insert into public.people values (1, 'Ana', 'ana@x');
      insert into public.items values (1, '${U(1)}', 'mine');
      insert into public.pub values (1, true), (2, false);
    `);
    same(await p.reads("scores"));
    same(await p.reads("pub"));
    within(await p.reads("people"));
    expect(p.report.access.tables.people!.hidden).toEqual(["email"]);
    const del = await p.writes(U(1), "delete from public.items where id = 1", (d) => d.delete("items", [{ column: "id", op: "eq", value: 1 }]));
    expect(del).toEqual({ theirs: false, mine: false });
    const add = await p.writes(U(1), "insert into public.items (id, body) values (2, 'x')", (d) => d.create("items", { id: 2, body: "x" }));
    expect(add).toEqual({ theirs: false, mine: false });
  });

  it("closes an INSERT policy without WITH CHECK, and leaves out a custom role's", async () => {
    const p = await project(`
      create table public.t (id int primary key);
      alter table public.t enable row level security;
      create policy p on public.t for insert to authenticated;
      create role editor;
      create table public.c (id int primary key);
      alter table public.c enable row level security;
      create policy p on public.c for select to editor using (true);
      grant all on public.t, public.c to anon, authenticated;
      insert into public.c values (1);
    `);
    expect(p.report.access.tables.t!.create).toBeUndefined();
    within(await p.reads("c"));
    expect(p.report.items.find((i) => i.area === "rules" && i.name === "c")!.note).toMatch(/editor/);
  });

  it("reads Unichat's chains: a list's tenant's membership, a table's own policy with a subquery, coalesce and now()", async () => {
    const p = await project(`
      create table public.tenants (id uuid primary key, owner uuid);
      create table public.memberships (tenant_id uuid, user_id uuid, status text, primary key (tenant_id, user_id));
      create table public.lists (id int primary key, tenant_id uuid);
      create table public.list_members (id int primary key, list_id int);
      create table public.notes (id int primary key, tenant_id uuid);
      create table public.announcements (id int primary key, starts_at timestamptz, ends_at timestamptz);
      create function public.my_tenant_ids() returns setof uuid language sql stable security definer as $$
        select tenant_id from public.memberships where user_id = auth.uid() and coalesce(status, 'active') = 'active' $$;
      alter table public.memberships enable row level security;
      alter table public.lists enable row level security;
      alter table public.list_members enable row level security;
      alter table public.notes enable row level security;
      alter table public.announcements enable row level security;
      -- memberships' own policy has a subquery reading the membership's row: once it came out as tenant_id = tenant_id.
      create policy m on public.memberships for select using (user_id = auth.uid() or tenant_id in (select t.id from public.tenants t where t.owner = auth.uid()));
      create policy l on public.lists for select using (exists (select 1 from public.memberships m where m.tenant_id = lists.tenant_id and m.user_id = auth.uid() and coalesce(m.status, 'active') = 'active'));
      create policy lm on public.list_members for select using (exists (select 1 from public.lists l where l.id = list_members.list_id and l.tenant_id in (select public.my_tenant_ids())));
      create policy n on public.notes for select using (tenant_id in (select m.tenant_id from public.memberships m where m.user_id = auth.uid()));
      create policy a on public.announcements for select using ((starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));
      grant select on all tables in schema public to anon, authenticated;
      insert into public.tenants values ('${T1}', '${U(3)}'), ('${T2}', null);
      insert into public.memberships values ('${T1}', '${U(1)}', null), ('${T2}', '${U(1)}', 'left'), ('${T2}', '${U(2)}', 'active');
      insert into public.lists values (1, '${T1}'), (2, '${T2}');
      insert into public.list_members values (1, 1), (2, 2);
      insert into public.notes values (1, '${T1}'), (2, '${T2}');
      insert into public.announcements values (1, null, null), (2, now() + interval '1 day', null), (3, null, now() - interval '1 day');
    `);
    for (const t of ["lists", "list_members", "notes", "announcements"]) {
      same(await p.reads(t));
      expect(p.level(t), t).not.toBe("manual");
    }
    expect(p.report.access.tables.list_members!.list).toContain("up.tenant_id");
    expect(JSON.stringify(p.report.access)).not.toMatch(/\b(\w+) = \1\b/);
  });

  it("never writes a name access.json cannot read back", async () => {
    const p = await project(`
      create table public.n (id int primary key, "true || owner" uuid);
      alter table public.n enable row level security;
      create policy p on public.n for select using ("true || owner" = auth.uid());
      grant select on public.n to anon, authenticated;
      insert into public.n values (1, '${U(1)}');
    `);
    expect(p.report.access.tables.n!.list).toBeUndefined();
    within(await p.reads("n"));
  });
});

describe("moving the rows and the people", () => {
  it("moves every row exactly, and the people sign in with their old passwords", async () => {
    const pg = new PGlite();
    await pg.exec(readFileSync(new URL("./support/supabase.sql", import.meta.url), "utf8"));
    await pg.exec(`
      update auth.users set encrypted_password = '${bcrypt.hashSync("Old-password-1", 4)}' where email = 'Ana@Example.com';
      create table public.odd (id bigint primary key, price numeric(14, 2), score double precision, flag boolean, at timestamptz, day date,
        doc jsonb, tags text[], raw bytea, note text);
      insert into public.odd values
        (9007199254740993, 12345678901.25, 0.1, true, '2026-11-04 10:20:30.456+04', '2026-11-04', '{"a": [1, {"b": null}]}', '{a,"b c"}', '\\x00ff', 'it''s; -- not SQL'),
        (2, null, 'NaN', false, null, null, null, '{}', null, null);
      insert into public.tenants (id, name) values ('${T1}', 'Shop one');
      insert into public.memberships values ('${T1}', '${U(1)}', 'owner');
      insert into public.messages (tenant_id, body, direction) select '${T1}', 'm' || g, 'inbound' from generate_series(1, 23) g;
      create table public.pics (id int primary key, url text, doc jsonb);
      insert into public.pics values (1, 'https://ref.supabase.co/storage/v1/object/public/media/t/x.jpg', '{"src": "https://ref.supabase.co/storage/v1/object/public/a.png"}'), (2, 'https://elsewhere.test/a.png', null);
      insert into storage.objects (id, bucket_id, name, metadata, owner, created_at) values
        ('30000000-0000-0000-0000-000000000002', 'media', 't/${T1}/2026-11-04/x.jpg', '{"size": 9, "mimetype": "image/jpeg", "cacheControl": "max-age=3600"}', '${U(1)}', '2026-11-04 10:00:00+00');
    `);
    const catalog = ((await pg.query(CATALOG_SQL)).rows[0] as { catalog: Catalog }).catalog;
    const report = buildReport(catalog);
    const query = async (sql: string) => (await pg.query(sql)).rows as Record<string, unknown>[];
    const out = await exportData(catalog, query, { pageRows: 5, fileRows: 10, rewrite: { from: "https://ref.supabase.co/storage/v1/", to: "https://new.test/storage/v1/" } });

    const p = baseProject();
    p.db.exec(report.schema);
    for (const f of out.files) p.db.exec(`BEGIN;\n${f.sql}\nCOMMIT;`);
    // Every table has as many rows as in Postgres.
    const theirs = await countRows(catalog, query);
    for (const [table, n] of Object.entries(theirs)) expect((p.db.prepare(`select count(*) as n from "${table}"`).get() as { n: number }).n, table).toBe(n);
    expect(out.files.filter((f) => f.name.includes("messages")).length).toBe(3);

    const odd = p.db.prepare("select cast(id as text) as id, price, score, flag, at, day, doc, tags, case when raw is null then null else hex(raw) end as raw, note from odd order by id").all();
    expect(odd).toEqual([
      { id: "2", price: null, score: null, flag: 0, at: null, day: null, doc: null, tags: "[]", raw: null, note: null },
      { id: "9007199254740993", price: 12345678901.25, score: 0.1, flag: 1, at: "2026-11-04T06:20:30.456000Z", day: "2026-11-04", doc: '{"a": [1, {"b": null}]}', tags: '["a","b c"]', raw: "00FF", note: "it's; -- not SQL" },
    ]);
    expect(out.notes.join(" ")).toMatch(/odd\.score: NaN/);
    // A file's address in the rows points to the new project, in text and in JSON alike.
    expect(p.db.prepare("select url, doc from pics order by id").all()).toEqual([
      { url: "https://new.test/storage/v1/object/public/media/t/x.jpg", doc: '{"src": "https://new.test/storage/v1/object/public/a.png"}' },
      { url: "https://elsewhere.test/a.png", doc: null },
    ]);
    // The files' rows, with the folders the rules name.
    expect(p.db.prepare("select bucket_id, name, owner, folder1, folder2, folder3, size, mime_type, cache_control, created_at from storage_objects order by name").all()).toEqual([
      { bucket_id: "avatars", name: "a/1.png", owner: null, folder1: "a", folder2: null, folder3: null, size: 1200, mime_type: null, cache_control: null, created_at: expect.any(String) },
      { bucket_id: "media", name: `t/${T1}/2026-11-04/x.jpg`, owner: U(1), folder1: "t", folder2: T1, folder3: "2026-11-04", size: 9, mime_type: "image/jpeg", cache_control: "max-age=3600", created_at: "2026-11-04T10:00:00.000000Z" },
    ]);

    const users = p.db.prepare("select id, name, email, emailVerified, image, banned, phoneNumber from _base_user order by id").all();
    expect(users).toEqual([
      { id: U(1), name: "Ana Beridze", email: "ana@example.com", emailVerified: 1, image: null, banned: 0, phoneNumber: null },
      { id: U(2), name: "+995555000000", email: "995555000000@phone.invalid", emailVerified: 0, image: null, banned: 0, phoneNumber: "+995555000000" },
      { id: U(3), name: "gio", email: "gio@example.com", emailVerified: 0, image: "https://x.test/g.png", banned: 1, phoneNumber: null },
    ]);
    expect(p.db.prepare("select providerId, accountId from _base_account where userId = ? order by providerId").all(U(3))).toEqual([
      { providerId: "credential", accountId: U(3) },
      { providerId: "google", accountId: "1170000000000000000001" },
    ]);
    expect(p.db.prepare(`select userId, data from _base_user_metadata`).all()).toEqual([{ userId: U(3), data: '{"must_change_password":true}' }]);
    const signIn = await p.call("/sign-in/email", { email: "ana@example.com", password: "Old-password-1" });
    expect(signIn.response.status, JSON.stringify(signIn.body)).toBe(200);
    expect(signIn.body?.user?.id).toBe(U(1));
  });
});

describe("moving what is hard to move", () => {
  it("keeps a table that points to itself in order, leaves out whom it must, and keeps statements under 100,000 bytes", async () => {
    const pg = new PGlite();
    await pg.exec(readFileSync(new URL("./support/supabase.sql", import.meta.url), "utf8").split("-- A Unichat-shaped project")[0]!);
    await pg.exec(`
      insert into auth.users (id, email) values ('${U(4)}', null), ('${U(5)}', 'GIO@example.com');
      create table public.tree (id int primary key, parent int references public.tree(id));
      insert into public.tree values (1, 2), (2, 3), (3, null), (4, 1);
      create table public.owned (id int primary key, by uuid references auth.users(id), must uuid not null references auth.users(id));
      insert into public.owned values (1, '${U(4)}', '${U(1)}'), (2, '${U(1)}', '${U(4)}');
      create table public.loose (doc json, at timestamptz);
      insert into public.loose values ('{"a": 1}', 'infinity'), ('[1]', '-infinity'), (null, null);
      create table public.words (id int primary key, body text);
      insert into public.words select g, repeat('ქართული ', 4000) from generate_series(1, 4) g;
    `);
    const catalog = ((await pg.query(CATALOG_SQL)).rows[0] as { catalog: Catalog }).catalog;
    const report = buildReport(catalog);
    const out = await exportData(catalog, async (sql) => (await pg.query(sql)).rows as Record<string, unknown>[], { fileRows: 1 });
    const p = baseProject();
    p.db.exec(report.schema);
    // Without a transaction (defer_foreign_keys off), so the order alone has to hold.
    for (const f of out.files) p.db.exec(f.sql);
    expect(p.db.prepare("select count(*) as n from tree").get()).toEqual({ n: 4 });
    expect(p.db.prepare("select id, by, must from owned order by id").all()).toEqual([{ id: 1, by: null, must: U(1) }]);
    expect(p.db.prepare("select at from loose order by rowid").all()).toEqual([{ at: "infinity" }, { at: "-infinity" }, { at: null }]);
    expect(p.db.prepare("select count(*) as n from words").get()).toEqual({ n: 4 });
    for (const f of out.files) for (const st of f.sql.split(/;\n/)) expect(new TextEncoder().encode(st).length, f.name).toBeLessThan(100_000);
    expect(out.notes.join(" ")).toMatch(/left out/);
    expect(p.db.prepare("select email from _base_user order by email").all()).toEqual([{ email: "995555000000@phone.invalid" }, { email: "ana@example.com" }, { email: "gio@example.com" }]);
  });
});

