import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";

import { createData, type Exec } from "../src/data.ts";
import { createGotrue } from "../src/gotrue.ts";
import { Room, type RoomSocket, type RoomState } from "../src/realtime.ts";
import { createRest } from "../src/rest.ts";
import { ORIGIN, project } from "./support/project.ts";

// supabase-js's auth, unchanged, against /auth/v1 on base: the calls Unichat makes.
const SERVICE_KEY = "service-key-for-the-server-code-only-0123456789";

function app() {
  const p = project(
    { verifyEmailBy: "code", trustedOrigins: [ORIGIN] },
    {},
  );
  p.db.exec("create table notes (id text primary key, owner text, body text)");
  const exec: Exec = async (sql, params) => p.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  const gotrue = createGotrue({ base: p.base, exec, secret: "a-test-secret-that-is-long-enough-123", serviceKey: SERVICE_KEY, checkLeakedPasswords: false });
  const data = createData({ exec, access: { tables: { notes: { list: "owner = auth.id", create: "owner = auth.id" } } } });
  const rest = createRest({ data, auth: gotrue.person, admin: gotrue.isService });
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path.startsWith("/auth/v1/")) return gotrue.handler(request);
    if (path.startsWith("/rest/v1/")) return rest.handler(request);
    return p.base.handler(request);
  };
  const browser = () =>
    createClient(ORIGIN, "unisites", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher } });
  const server = createClient(ORIGIN, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetcher } });
  const code = () => /\b(\d{6})\b/.exec(p.mail.at(-1)?.text ?? "")?.[1] ?? "";
  const link = () => /(https:\/\/\S+reset-password\/\S+)/.exec(p.mail.at(-1)?.text ?? "")?.[1] ?? "";
  return { p, gotrue, browser, server, code, link, fetcher };
}

/** Follows redirects through the app, and gives the last location's hash. */
async function follow(fetcher: (i: string) => Promise<Response>, url: string): Promise<URLSearchParams> {
  let at = url;
  for (let i = 0; i < 5; i++) {
    const res = await fetcher(at);
    const to = res.headers.get("location");
    if (!to) break;
    at = new URL(to, at).toString();
  }
  return new URLSearchParams(new URL(at).hash.slice(1));
}

describe("/auth/v1", () => {
  it("signs up, confirms with a code, and the session reads data under the rules", async () => {
    const { browser, code } = app();
    const sb = browser();
    const up = await sb.auth.signUp({ email: "ana@example.com", password: "A-long-password-1", options: { data: { full_name: "Ana Beridze", plan: "pro" } } });
    expect(up.error).toBeNull();
    expect(up.data.session).toBeNull();
    expect(up.data.user?.user_metadata).toMatchObject({ full_name: "Ana Beridze", plan: "pro" });
    expect((await sb.auth.signInWithPassword({ email: "ana@example.com", password: "A-long-password-1" })).error?.code).toBe("email_not_confirmed");
    const verified = await sb.auth.verifyOtp({ email: "ana@example.com", token: code(), type: "signup" });
    expect(verified.error).toBeNull();
    const user = verified.data.user!;
    expect(user.email_confirmed_at).toBeTruthy();
    const { error } = await sb.from("notes").insert({ id: "n1", owner: user.id, body: "mine" });
    expect(error).toBeNull();
    expect((await sb.from("notes").select("id")).data).toEqual([{ id: "n1" }]);
    expect((await browser().from("notes").select("id")).data).toEqual([]);
  });

  it("signs in with a password, refreshes, updates, and signs out everywhere", async () => {
    const { p, browser, server } = app();
    const now = new Date().toISOString();
    p.db.prepare(`insert into _base_user (id, name, email, emailVerified, createdAt, updatedAt) values ('u1', 'Ana', 'ana@example.com', 1, ?, ?)`).run(now, now);
    p.db.prepare(`insert into _base_account (id, accountId, providerId, userId, password, createdAt, updatedAt) values ('a1', 'u1', 'credential', 'u1', ?, ?, ?)`).run(bcrypt.hashSync("Old-password-1", 4), now, now);

    const sb = browser();
    expect((await sb.auth.signInWithPassword({ email: "ana@example.com", password: "wrong-one-1" })).error?.code).toBe("invalid_credentials");
    const signed = await sb.auth.signInWithPassword({ email: "ana@example.com", password: "Old-password-1" });
    expect(signed.error).toBeNull();
    const token = signed.data.session!.access_token;
    // The server reads the person from the browser's token, as Unichat's api/ does.
    expect((await server.auth.getUser(token)).data.user?.id).toBe("u1");

    const refreshed = await sb.auth.refreshSession();
    expect(refreshed.error).toBeNull();
    expect(refreshed.data.session!.access_token).toBeTruthy();

    const changed = await sb.auth.updateUser({ password: "New-password-22", data: { full_name: "Ana B.", must_change_password: false } });
    expect(changed.error).toBeNull();
    expect(changed.data.user?.user_metadata).toMatchObject({ full_name: "Ana B.", must_change_password: false });
    expect((await browser().auth.signInWithPassword({ email: "ana@example.com", password: "New-password-22" })).error).toBeNull();
    expect((await sb.auth.updateUser({ email: "other@example.com" })).error?.code).toBe("feature_not_available");

    await sb.auth.signOut();
    expect((await server.auth.getUser(token)).error).toBeTruthy();
  });

  it("recovers a password through base's letter, into the hash supabase-js reads", async () => {
    const { p, browser, link, fetcher } = app();
    const now = new Date().toISOString();
    p.db.prepare(`insert into _base_user (id, name, email, emailVerified, createdAt, updatedAt) values ('u1', 'Ana', 'ana@example.com', 1, ?, ?)`).run(now, now);
    const sb = browser();
    expect((await sb.auth.resetPasswordForEmail("ana@example.com", { redirectTo: `${ORIGIN}/set-password` })).error).toBeNull();
    expect((await sb.auth.resetPasswordForEmail("nobody@example.com", { redirectTo: `${ORIGIN}/set-password` })).error).toBeNull();
    const letter = link();
    const hash = await follow((u) => fetcher(u), letter);
    expect(hash.get("type")).toBe("recovery");
    const set = await sb.auth.setSession({ access_token: hash.get("access_token")!, refresh_token: hash.get("refresh_token")! });
    expect(set.error).toBeNull();
    expect((await sb.auth.updateUser({ password: "Brand-new-pass-3" })).error).toBeNull();
    expect((await browser().auth.signInWithPassword({ email: "ana@example.com", password: "Brand-new-pass-3" })).error).toBeNull();
    // The link is used once, and goes only to the app's own origin.
    expect((await follow((u) => fetcher(u), letter)).get("error_code")).toBe("otp_expired");
  });

  it("lets only the service key use auth.admin", async () => {
    const { browser, server, link, fetcher } = app();
    const made = await server.auth.admin.createUser({ email: "gio@example.com", password: "Gio-password-1", email_confirm: true, user_metadata: { full_name: "Gio" } });
    expect(made.error).toBeNull();
    const id = made.data.user!.id;
    expect((await server.auth.admin.getUserById(id)).data.user?.user_metadata.full_name).toBe("Gio");
    expect((await server.auth.admin.listUsers()).data.users.map((u) => u.email)).toContain("gio@example.com");
    expect((await server.auth.admin.updateUserById(id, { user_metadata: { role_hint: "x" } })).error).toBeNull();
    expect((await browser().auth.admin.listUsers()).error).toBeTruthy();
    const invited = await server.auth.admin.inviteUserByEmail("nino@example.com", { data: { full_name: "Nino" }, redirectTo: `${ORIGIN}/set-password` });
    expect(invited.error).toBeNull();
    expect((await follow((u) => fetcher(u), link())).get("type")).toBe("invite");
    expect((await server.auth.admin.deleteUser(id)).error).toBeNull();
    expect((await server.auth.admin.getUserById(id)).error).toBeTruthy();
    // The service key reads past the rules, as the service role does.
    expect((await server.from("notes").select("id")).error).toBeNull();
  });

  it("refuses a token that is not ours, and redirects only to the app", async () => {
    const { gotrue, fetcher } = app();
    const forged = `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ sub: "u1", exp: 9999999999 }))}.`;
    expect(await gotrue.verify(forged)).toBeNull();
    const res = await fetcher(`${ORIGIN}/auth/v1/verify?type=recovery&token=abcdefgh123&redirect_to=${encodeURIComponent("https://evil.test/x")}`);
    expect(res.headers.get("location")).toMatch(/^https:\/\/shop\.test/);
  });
});

describe("Realtime with /auth/v1's token", () => {
  it("sends a row to the person the join's access_token is for, and refuses a token that is not ours", async () => {
    const { p, gotrue, browser } = app();
    const now = new Date().toISOString();
    p.db.prepare(`insert into _base_user (id, name, email, emailVerified, createdAt, updatedAt) values ('u1', 'Ana', 'ana@example.com', 1, ?, ?)`).run(now, now);
    p.db.prepare(`insert into _base_account (id, accountId, providerId, userId, password, createdAt, updatedAt) values ('a1', 'u1', 'credential', 'u1', ?, ?, ?)`).run(bcrypt.hashSync("Old-password-1", 4), now, now);
    const token = (await browser().auth.signInWithPassword({ email: "ana@example.com", password: "Old-password-1" })).data.session!.access_token;

    const exec: Exec = async (sql, params) => p.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    const sockets = new Set<RoomSocket>();
    const state: RoomState = { acceptWebSocket: (w) => void sockets.add(w), getWebSockets: () => [...sockets], storage: { getAlarm: async () => null, setAlarm: async () => undefined } };
    const room = new Room(state, { data: createData({ exec, access: { tables: { notes: { list: "owner = auth.id" } } } }), verify: gotrue.verify, alive: gotrue.alive });
    const socket = () => {
      let a: unknown = null;
      const got: unknown[][] = [];
      const ws: RoomSocket = { send: (m) => void got.push(JSON.parse(m)), close() {}, serializeAttachment: (v) => void (a = structuredClone(v)), deserializeAttachment: () => structuredClone(a) };
      return { ws, got };
    };
    const join = (ws: RoomSocket, access_token: string) =>
      room.message(ws, JSON.stringify(["1", "1", "realtime:n", "phx_join", { config: { postgres_changes: [{ event: "*", schema: "public", table: "notes" }] }, access_token }]));

    const ana = socket();
    await room.accept(ana.ws, null);
    await join(ana.ws, token);
    const forged = socket();
    await room.accept(forged.ws, null);
    await join(forged.ws, `${token.slice(0, -4)}AAAA`);
    // A token that is not ours is no one: the join works, as signed out, and sees nothing of Ana's.
    expect((forged.got[0]![4] as { status: string }).status).toBe("ok");

    await room.broadcast([{ table: "notes", type: "INSERT", record: { id: "n1", owner: "u1", body: "x" }, old: null, at: now }]);
    expect(ana.got.filter((m) => m[3] === "postgres_changes")).toHaveLength(1);
    expect(forged.got.filter((m) => m[3] === "postgres_changes")).toHaveLength(0);

    // Signed out everywhere: the next row does not come (the room asks again, at most a minute late; here at once).
    p.db.prepare("delete from _base_session").run();
    const fresh = new Room(state, { data: createData({ exec, access: { tables: { notes: { list: "owner = auth.id" } } } }), verify: gotrue.verify, alive: gotrue.alive });
    await fresh.broadcast([{ table: "notes", type: "INSERT", record: { id: "n2", owner: "u1", body: "y" }, old: null, at: now }]);
    expect(ana.got.filter((m) => m[3] === "postgres_changes")).toHaveLength(1);
  });
});

describe("what the review found", () => {
  function person(p: ReturnType<typeof app>["p"], verified = 1) {
    const now = new Date().toISOString();
    p.db.prepare(`insert into _base_user (id, name, email, emailVerified, createdAt, updatedAt) values ('u1', 'Ana', 'ana@example.com', ?, ?, ?)`).run(verified, now, now);
  }

  it("refuses a blocked person, at sign-in, refresh, the recovery link and every token", async () => {
    const { p, browser, link, fetcher, server } = app();
    person(p);
    const sb = browser();
    await sb.auth.resetPasswordForEmail("ana@example.com", { redirectTo: `${ORIGIN}/set-password` });
    const hash = await follow((u) => fetcher(u), link());
    const token = hash.get("access_token")!;
    expect((await server.auth.getUser(token)).data.user?.id).toBe("u1");
    // Unisites blocks with banned = 1 alone, sessions left as they are.
    p.db.prepare("update _base_user set banned = 1").run();
    expect((await server.auth.getUser(token)).error).toBeTruthy();
    expect((await sb.auth.refreshSession({ refresh_token: hash.get("refresh_token")! })).error?.code).toBe("user_banned");
    await sb.auth.resetPasswordForEmail("ana@example.com", { redirectTo: `${ORIGIN}/set-password` });
    expect((await follow((u) => fetcher(u), link())).get("error_code")).toBe("user_banned");
  });

  it("gives the account to whoever reads the letter, not to whoever signed up with the address first", async () => {
    const { p, browser, link, fetcher } = app();
    // Someone signs up with Ana's address and their own password; it is never confirmed.
    expect((await browser().auth.signUp({ email: "ana@example.com", password: "Attacker-pass-9" })).error).toBeNull();
    await browser().auth.resetPasswordForEmail("ana@example.com", { redirectTo: `${ORIGIN}/set-password` });
    const hash = await follow((u) => fetcher(u), link());
    expect(hash.get("type")).toBe("recovery");
    // The address is proved now, and the stranger's password is gone with it.
    expect((await browser().auth.signInWithPassword({ email: "ana@example.com", password: "Attacker-pass-9" })).error?.code).toBe("invalid_credentials");
    expect(p.db.prepare("select count(*) as n from _base_account where providerId = 'credential'").get()).toEqual({ n: 0 });
    expect(p.db.prepare("select count(*) as n from _base_sign_in").get()).toEqual({ n: 1 });
  });

  it("answers a sign-up the same, whether the address is taken or not", async () => {
    const { p, browser } = app();
    person(p);
    const taken = await browser().auth.signUp({ email: "ana@example.com", password: "Some-pass-1234", options: { data: { full_name: "X", k: 1 } } });
    const fresh = await browser().auth.signUp({ email: "nino@example.com", password: "Some-pass-1234", options: { data: { full_name: "X", k: 1 } } });
    expect(taken.error).toBeNull();
    expect(Object.keys(taken.data.user!).sort()).toEqual(Object.keys(fresh.data.user!).sort());
    expect(taken.data.user!.user_metadata).toEqual(fresh.data.user!.user_metadata);
  });

  it("sends the notice when a password changes, and reads ban durations as GoTrue does", async () => {
    const { p, server, browser } = app();
    const made = await server.auth.admin.createUser({ email: "gio@example.com", password: "Gio-password-1", email_confirm: true });
    const sb = browser();
    await sb.auth.signInWithPassword({ email: "gio@example.com", password: "Gio-password-1" });
    const before = p.mail.length;
    expect((await sb.auth.updateUser({ password: "Gio-password-22" })).error).toBeNull();
    expect(p.mail.length).toBe(before + 1);
    expect((await server.auth.admin.updateUserById(made.data.user!.id, { ban_duration: "1h30m" })).error).toBeNull();
    const until = p.db.prepare("select banExpires from _base_user where email = 'gio@example.com'").get() as { banExpires: string };
    expect(new Date(until.banExpires).getTime() - Date.now()).toBeGreaterThan(80 * 60_000);
    expect((await server.auth.admin.updateUserById(made.data.user!.id, { ban_duration: "forever" })).error).toBeTruthy();
  });
});

describe("with base's breached-password check on", () => {
  it("creates and changes passwords through /auth/v1 too", async () => {
    const real = globalThis.fetch;
    // haveibeenpwned.com answers that no password is known.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).startsWith("https://api.pwnedpasswords.com/") ? new Response("") : real(input, init)) as typeof fetch;
    try {
      const p = project({ verifyEmailBy: "code", trustedOrigins: [ORIGIN], checkLeakedPasswords: true }, {});
      const exec: Exec = async (sql, params) => p.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
      const gotrue = createGotrue({ base: p.base, exec, secret: "a-test-secret-that-is-long-enough-123", serviceKey: SERVICE_KEY });
      const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        return new URL(request.url).pathname.startsWith("/auth/v1/") ? gotrue.handler(request) : p.base.handler(request);
      };
      const server = createClient(ORIGIN, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetcher } });
      const made = await server.auth.admin.createUser({ email: "gio@example.com", password: "Gio-password-1", email_confirm: true });
      expect(made.error).toBeNull();
      const sb = createClient(ORIGIN, "unisites", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetcher } });
      expect((await sb.auth.signInWithPassword({ email: "gio@example.com", password: "Gio-password-1" })).error).toBeNull();
      expect((await sb.auth.updateUser({ password: "Gio-password-22" })).error).toBeNull();
    } finally {
      globalThis.fetch = real;
    }
  });
});

