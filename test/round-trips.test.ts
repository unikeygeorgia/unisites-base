import { DatabaseSync } from "node:sqlite";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { createData, type Exec, type Filter } from "../src/data.ts";
import { createGotrue } from "../src/gotrue.ts";
import { createRest } from "../src/rest.ts";
import { ORIGIN, project } from "./support/project.ts";

// What a project on a Worker pays per request is round trips to D1 (~90 ms each from a Worker in Tbilisi to D1 in
// Frankfurt, Unichat, 2026-11-09) and the rows D1 reads to answer them.

describe("a statement's WHERE", () => {
  // A table with an index and rows of two tenants, NULLs included, as Unichat's messages.
  function table() {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      create table memberships (tenant_id text, user_id text);
      create table messages (id text primary key, tenant_id text not null, conversation_id text, body text, n integer, created_at text);
      create index idx_msg_conv on messages (conversation_id);
      insert into memberships values ('t1', 'u1');
    `);
    const add = db.prepare(`insert into messages values (?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 300; i++) add.run(`m${i}`, i % 2 ? "t1" : "t2", `c${i % 7}`, i % 7 ? `body ${i}` : null, i % 5 ? i : null, `2026-11-09T10:${String(i % 60).padStart(2, "0")}:00Z`);
    const statements: [string, unknown[]][] = [];
    const exec: Exec = async (sql, params) => {
      statements.push([sql, params]);
      return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    };
    const member = "exists(memberships, tenant_id = row.tenant_id && user_id = auth.id)";
    const data = createData({ exec, access: { tables: { messages: { list: member, view: member, update: member, delete: member } } } });
    /** How SQLite runs the last statement of these: its query plan's details. */
    const plan = (match: RegExp) => {
      const [sql, params] = statements.filter(([s]) => match.test(s)).at(-1)!;
      return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as { detail: string }[]).map((r) => r.detail).join(" | ");
    };
    return { db, data, plan };
  }
  const eq = (column: string, value: unknown): Filter => ({ column, op: "eq", value });

  it("looks a filtered column up in its index, for a person and for the server alike", async () => {
    const t = table();
    const rows = await t.data.as({ id: "u1" }).list("messages", { where: [eq("tenant_id", "t1"), eq("conversation_id", "c3")], order: [{ column: "created_at", ascending: false }, { column: "id", ascending: false }], limit: 101 });
    const expected = t.db.prepare(`select id from messages where tenant_id = 't1' and conversation_id = 'c3' order by created_at desc, id desc`).all() as { id: string }[];
    expect(expected.length).toBe(22);
    expect(rows.map((r) => r.id)).toEqual(expected.map((r) => r.id));
    // Was "SCAN messages": every row of every tenant read for these five.
    expect(t.plan(/^SELECT/)).toMatch(/SEARCH messages USING INDEX idx_msg_conv \(conversation_id=\?\)/);

    await t.data.admin().list("messages", { where: [eq("conversation_id", "c3")] });
    expect(t.plan(/^SELECT/)).toMatch(/SEARCH messages USING INDEX idx_msg_conv/);
    expect(await t.data.admin().count("messages", [eq("conversation_id", "c3")])).toBe(43);
    expect(t.plan(/^SELECT count/)).toMatch(/SEARCH messages USING (COVERING )?INDEX idx_msg_conv/);
  });

  it("finds a row by its key through the key, to read, change or delete it", async () => {
    const t = table();
    const me = t.data.as({ id: "u1" });
    expect((await me.get("messages", "m3"))?.body).toBe("body 3");
    expect(t.plan(/^SELECT/)).toMatch(/SEARCH messages USING INDEX sqlite_autoindex_messages_1 \(id=\?\)/);
    expect((await me.update("messages", [eq("id", "m3")], { body: "changed" }, { returning: true, one: true })).rows).toEqual([expect.objectContaining({ id: "m3", body: "changed" })]);
    expect(t.plan(/^UPDATE/)).toMatch(/SEARCH messages USING INDEX sqlite_autoindex_messages_1 \(id=\?\)/);
    expect((await me.delete("messages", [eq("id", "m3")], { one: true })).count).toBe(1);
    expect(t.plan(/^DELETE/)).toMatch(/SEARCH messages USING INDEX sqlite_autoindex_messages_1 \(id=\?\)/);
    // The rule still holds: another tenant's row is neither read, changed nor deleted.
    expect(await me.get("messages", "m4")).toBeNull();
    expect((await me.update("messages", [eq("id", "m4")], { body: "x" })).count).toBe(0);
    expect((await me.delete("messages", [eq("id", "m4")])).count).toBe(0);
  });

  it("drops a row whose condition is NULL, as before: not-equal, not, or and is", async () => {
    const t = table();
    const ids = async (where: Filter[]) => (await t.data.as({ id: "u1" }).list("messages", { where, order: [{ column: "id" }] })).map((r) => r.id);
    const all = (t.db.prepare(`select id, body, n from messages where tenant_id = 't1' order by id`).all() as { id: string; body: string | null; n: number | null }[]);
    // PostgREST's: NULL is neither equal nor not equal to anything.
    expect(await ids([{ column: "body", op: "neq", value: "body 1" }])).toEqual(all.filter((r) => r.body !== null && r.body !== "body 1").map((r) => r.id));
    expect(await ids([{ not: eq("body", "body 1") }])).toEqual(all.filter((r) => r.body !== null && r.body !== "body 1").map((r) => r.id));
    expect(await ids([{ column: "n", op: "gt", value: 290 }])).toEqual(all.filter((r) => r.n !== null && r.n > 290).map((r) => r.id));
    expect(await ids([{ or: [eq("n", 1), { column: "body", op: "is", value: null }] }])).toEqual(all.filter((r) => r.n === 1 || r.body === null).map((r) => r.id));
    expect(await ids([{ not: { or: [eq("n", 1), { column: "n", op: "is", value: null }] } }])).toEqual(all.filter((r) => r.n !== null && r.n !== 1).map((r) => r.id));
    // A change of more than one row is still refused before it changes any.
    await expect(t.data.as({ id: "u1" }).update("messages", [eq("conversation_id", "c3")], { body: "x" }, { one: true })).rejects.toThrow();
    expect((t.db.prepare(`select count(*) n from messages where body = 'x'`).get() as { n: number }).n).toBe(0);
  });
});

describe("GET /auth/v1/user", () => {
  const SERVICE_KEY = "service-key-for-the-server-code-only-0123456789";

  // supabase-js's auth.getUser(token) on the server, as Unichat asks it on every request, against a database whose
  // every statement takes a while, as D1 does from a Worker: how many of them are under way at once.
  async function signedIn() {
    const p = project({ verifyEmailBy: "code", trustedOrigins: [ORIGIN] });
    let inFlight = 0;
    let most = 0;
    let started = 0;
    // base.auth() makes (or reuses) better-auth: counted, to see whether a getUser needs it.
    const base = { ...p.base, auth: () => (started++, p.base.auth()) };
    const exec: Exec = async (sql, params) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return p.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    };
    const gotrue = createGotrue({ base, exec, secret: "a-test-secret-that-is-long-enough-123", serviceKey: SERVICE_KEY, checkLeakedPasswords: false });
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return new URL(request.url).pathname.startsWith("/auth/v1/") ? gotrue.handler(request) : p.base.handler(request);
    };
    const browser = createClient(ORIGIN, "unisites", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher } });
    const server = createClient(ORIGIN, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetcher } });
    await browser.auth.signUp({ email: "nino@example.test", password: "a long password 123!", options: { data: { full_name: "Nino" } } });
    const code = /\b(\d{6})\b/.exec(p.mail.at(-1)?.text ?? "")?.[1] ?? "";
    const { data } = await browser.auth.verifyOtp({ email: "nino@example.test", token: code, type: "signup" });
    const token = data.session!.access_token;
    return { p, server, browser, token, reset: () => { most = 0; started = 0; }, most: () => most, started: () => started };
  }

  it("reads the session, the person and what they keep side by side, and answers as before", async () => {
    const s = await signedIn();
    s.reset();
    const { data, error } = await s.server.auth.getUser(s.token);
    // All four together: the session, the person, their accounts, their metadata (0.9.1: one at a time).
    expect(s.most()).toBe(4);
    // And without better-auth: no instance made for it, no sqlite_master read by one.
    expect(s.started()).toBe(0);
    expect(error).toBeNull();
    // The same person as auth.admin reads them through better-auth.
    expect(data.user).toEqual((await s.server.auth.admin.getUserById(data.user!.id)).data.user);
    expect(data.user).toMatchObject({ email: "nino@example.test", user_metadata: { full_name: "Nino" }, identities: [expect.objectContaining({ provider: "email" })] });
  });

  it("answers as better-auth's own reads do for a person with a role, a picture, a phone and a second account", async () => {
    const s = await signedIn();
    const id = (await s.server.auth.getUser(s.token)).data.user!.id;
    s.p.db.prepare(`update "_base_user" set "role" = 'admin', "image" = 'https://img.test/n.png', "phoneNumber" = '+995555123456', "phoneNumberVerified" = 1 where "id" = ?`).run(id);
    s.p.db
      .prepare(`insert into "_base_account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") values (?, ?, 'google', ?, ?, ?)`)
      .run("acc-google", "google-sub-1", id, "2026-11-01T08:00:00.000Z", "2026-11-02T09:30:00.000Z");
    const mine = (await s.server.auth.getUser(s.token)).data.user!;
    expect(mine).toEqual((await s.server.auth.admin.getUserById(id)).data.user);
    expect(mine).toMatchObject({
      phone: "995555123456",
      app_metadata: { provider: "email", providers: ["email", "google"], role: "admin" },
      user_metadata: { full_name: "Nino", avatar_url: "https://img.test/n.png" },
      identities: [expect.objectContaining({ provider: "email" }), expect.objectContaining({ provider: "google", id: "google-sub-1", created_at: "2026-11-01T08:00:00.000Z" })],
    });
    expect(mine.phone_confirmed_at).not.toBeNull();
  });

  it("still refuses a token whose session is over, a forged one, and a person who is gone", async () => {
    const s = await signedIn();
    const forged = `${s.token.slice(0, -4)}AAAA`;
    expect((await s.server.auth.getUser(forged)).error?.status).toBe(401);
    s.p.db.prepare(`update "_base_session" set "expiresAt" = ?`).run(new Date(Date.now() - 1000).toISOString());
    expect((await s.server.auth.getUser(s.token)).error?.status).toBe(401);
    s.p.db.prepare(`update "_base_session" set "expiresAt" = ?`).run(new Date(Date.now() + 3_600_000).toISOString());
    expect((await s.server.auth.getUser(s.token)).error).toBeNull();
    s.p.db.exec(`delete from "_base_user"`);
    // The session's row goes with its person in a real database; here the session stays, so the person is missing.
    const gone = await s.server.auth.getUser(s.token);
    expect(gone.error?.status === 401 || gone.error?.status === 404).toBe(true);
  });
});

describe("a browser's read", () => {
  const SESSION = /_base_session/;
  const ROWS = /^SELECT .* FROM "products"/;
  const EMBED = /^SELECT .* FROM "shops"/;
  // /rest/v1 with a person's token, through supabase-js, against a database whose statements each take a while:
  // with claims the read runs beside the session's check; without, after it. The answers are the same.
  async function shop(withClaims: boolean) {
    const p = project({ verifyEmailBy: "code", trustedOrigins: [ORIGIN] });
    p.db.exec(`
      create table shops (id text primary key, name text);
      create table products (id text primary key, shop_id text references shops (id), maker_id text references shops (id), owner text, name text);
      insert into shops values ('s1', 'Nino''s'), ('s2', 'Other');
    `);
    const log: { sql: string; start: number; end: number }[] = [];
    const exec: Exec = async (sql, params) => {
      const entry = { sql, start: performance.now(), end: Infinity };
      log.push(entry);
      await new Promise((r) => setTimeout(r, 10));
      entry.end = performance.now();
      return p.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    };
    const gotrue = createGotrue({ base: p.base, exec, secret: "a-test-secret-that-is-long-enough-123", serviceKey: "service-key-for-the-server-code-only-0123456789", checkLeakedPasswords: false });
    const data = createData({
      exec,
      access: { tables: { shops: { list: "" }, products: { list: "owner = auth.id", create: "owner = auth.id" } } },
    });
    const rest = createRest({ data, auth: gotrue.person, admin: gotrue.isService, ...(withClaims ? { claims: gotrue.claims } : {}) });
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.startsWith("/auth/v1/")) return gotrue.handler(request);
      if (path.startsWith("/rest/v1/")) return rest.handler(request);
      return p.base.handler(request);
    };
    const browser = createClient(ORIGIN, "unisites", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher } });
    await browser.auth.signUp({ email: "nino@example.test", password: "a long password 123!" });
    const code = /\b(\d{6})\b/.exec(p.mail.at(-1)?.text ?? "")?.[1] ?? "";
    const { data: s } = await browser.auth.verifyOtp({ email: "nino@example.test", token: code, type: "signup" });
    const id = s.session!.user.id;
    p.db.prepare(`insert into products values ('p1', 's1', 's2', ?, 'paint'), ('p2', 's2', 's1', ?, 'brush'), ('p3', 's1', 's1', 'someone-else', 'theirs')`).run(id, id);
    // The statements of the next request only.
    const fresh = () => { log.length = 0; };
    const first = (re: RegExp) => log.find((e) => re.test(e.sql))!;
    const all = (re: RegExp) => log.filter((e) => re.test(e.sql));
    /** The read's first statement, whatever it is (here a table's PRAGMA: this test has no schema cache). */
    const read = () => log.find((e) => !SESSION.test(e.sql))!;
    return { p, browser, id, fresh, first, all, read };
  }
  const list = (b: SupabaseClient) => b.from("products").select("id, name, shop:shops!shop_id(name), maker:shops!maker_id(name)", { count: "exact" }).order("id");

  it("runs beside the session's check, its embeds side by side, and answers as after it", async () => {
    const after = await shop(false);
    const beside = await shop(true);
    after.fresh();
    const before = await list(after.browser);
    // Without claims (0.9.4): the rows only once the session's check is back, and one embed after the other.
    expect(after.read().start).toBeGreaterThanOrEqual(after.first(SESSION).end);
    expect(after.first(ROWS).start).toBeGreaterThanOrEqual(after.first(SESSION).end);
    beside.fresh();
    const now = await list(beside.browser);
    expect(now.error).toBeNull();
    expect(now.data).toEqual(before.data);
    expect(now.count).toBe(2);
    expect(now.data).toEqual([
      { id: "p1", name: "paint", shop: { name: "Nino's" }, maker: { name: "Other" } },
      { id: "p2", name: "brush", shop: { name: "Other" }, maker: { name: "Nino's" } },
    ]);
    // With claims: the read is under way before the check comes back.
    expect(beside.read().start).toBeLessThan(beside.first(SESSION).end);
    // The two embeds overlap.
    const [a, b] = beside.all(EMBED);
    expect(b!.start).toBeLessThan(a!.end);
  });

  it("answers signed out once the session is over, and never writes as it", async () => {
    const s = await shop(true);
    expect((await s.browser.from("products").select("id").order("id")).data).toEqual([{ id: "p1" }, { id: "p2" }]);
    s.p.db.prepare(`update "_base_session" set "expiresAt" = ?`).run(new Date(Date.now() - 1000).toISOString());
    // As signed out: products' rule needs a person, so none; shops' is open to all.
    expect((await s.browser.from("products").select("id")).data).toEqual([]);
    expect((await s.browser.from("shops").select("id").order("id")).data).toEqual([{ id: "s1" }, { id: "s2" }]);
    const write = await s.browser.from("products").insert({ id: "p9", shop_id: "s1", owner: s.id, name: "sneaky" });
    expect(write.error).not.toBeNull();
    expect(s.p.db.prepare(`select count(*) as n from products where id = 'p9'`).get()).toEqual({ n: 0 });
  });
});
