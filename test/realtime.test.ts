import { DatabaseSync } from "node:sqlite";

import { createClient, type RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { type Access } from "../src/access.ts";
import { createData, type Change, type Exec } from "../src/data.ts";
import { Room, createRealtime, type RoomSocket, type RoomState } from "../src/realtime.ts";
import { createRest } from "../src/rest.ts";

// supabase-js's channels, unchanged, against a room: Unichat's subscriptions.
const SCHEMA = `
  create table tenants (id text primary key, name text);
  create table memberships (tenant_id text, user_id text, role text);
  create table messages (
    id text primary key, tenant_id text not null, conversation_id text, body text,
    internal_note text, seen boolean default 0, meta json text
  );
`;

const MEMBER = "exists(memberships, tenant_id = row.tenant_id && user_id = auth.id)";

const ACCESS: Access = {
  tables: {
    memberships: { list: "user_id = auth.id" },
    messages: { list: MEMBER, create: MEMBER, update: MEMBER, delete: MEMBER, hidden: ["internal_note"] },
  },
};

type Any = RealtimePostgresChangesPayload<Record<string, unknown>>;

function project(maxAge?: number) {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.exec(`
    insert into tenants values ('t1', 'one'), ('t2', 'two');
    insert into memberships values ('t1', 'ana', 'admin'), ('t1', 'beka', 'member'), ('t2', 'gio', 'admin');
    insert into messages (id, tenant_id, conversation_id, body, internal_note) values ('m1', 't1', 'c1', 'hello', 'secret');
  `);
  const exec: Exec = async (sql, params) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];

  // A Durable Object's state, in memory.
  const sockets = new Set<RoomSocket>();
  let alarm: number | null = null;
  const state: RoomState = {
    acceptWebSocket: (ws) => void sockets.add(ws),
    getWebSockets: () => [...sockets],
    storage: { getAlarm: async () => alarm, setAlarm: async (at) => void (alarm = at) },
  };
  const room = new Room(state, { data: createData({ exec, access: ACCESS }), maxAge });
  const sent: Change[][] = [];
  const data = createData({
    exec,
    access: ACCESS,
    onChange: async (c) => {
      sent.push(c);
      // As the Worker would: the changes go to the room as JSON.
      await room.broadcast(JSON.parse(JSON.stringify(c)));
    },
  });

  // A WebSocket for realtime-js whose other end is the room; the person is the URL's ?user=.
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    binaryType = "arraybuffer";
    onopen?: (e: unknown) => void;
    onmessage?: (e: { data: unknown }) => void;
    onclose?: (e: { code: number; reason: string; wasClean: boolean }) => void;
    onerror?: (e: unknown) => void;
    readonly server: RoomSocket;

    constructor(readonly url: string) {
      let attachment: unknown = null;
      const shut = (code: number, reason: string) => {
        if (this.readyState === 3) return;
        this.readyState = 3;
        sockets.delete(this.server);
        setTimeout(() => this.onclose?.({ code, reason, wasClean: true }));
      };
      this.server = {
        send: (m) => setTimeout(() => this.readyState === 1 && this.onmessage?.({ data: m })),
        close: (code = 1000, reason = "") => shut(code, reason),
        serializeAttachment: (v) => void (attachment = structuredClone(v)),
        deserializeAttachment: () => structuredClone(attachment),
      };
      const user = new URL(url).searchParams.get("user");
      setTimeout(async () => {
        await room.accept(this.server, user ? { id: user } : null);
        this.readyState = 1;
        this.onopen?.({});
      });
      this.close = (code = 1000, reason = "") => shut(code, reason);
    }

    send(m: string) {
      setTimeout(() => void room.message(this.server, m));
    }

    close: (code?: number, reason?: string) => void;
  }

  const rest = createRest({ data, auth: async (r) => (r.headers.get("x-test-user") ? { id: r.headers.get("x-test-user")! } : null) });
  const client = (user?: string) =>
    createClient("https://app.test", "unisites", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: user ? { "x-test-user": user } : {}, fetch: (input, init) => rest.handler(new Request(input, init)) },
      realtime: { transport: Socket as never, params: user ? { user } : {}, heartbeatIntervalMs: 60_000 },
    });

  const raw = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
  return { room, data, sent, sockets, client, raw, alarm: () => alarm };
}

/** Subscribes, and collects what arrives. */
async function listen(
  supabase: ReturnType<ReturnType<typeof project>["client"]>,
  filter: { event: "*" | "INSERT" | "UPDATE" | "DELETE"; table: string; filter?: string },
): Promise<{ got: Any[]; status: string }> {
  const got: Any[] = [];
  const status = await new Promise<string>((resolve) => {
    supabase
      .channel(`test:${Math.random()}`)
      .on("postgres_changes" as never, { schema: "public", ...filter } as never, (p: Any) => got.push(p))
      .subscribe((s: string) => {
        if (s !== "CLOSED") resolve(s);
      });
  });
  return { got, status };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("postgres_changes", () => {
  it("sends a new row to the members who may see it, without hidden columns", async () => {
    const { client, data } = project();
    const ana = client("ana");
    const gio = client("gio");
    const a = await listen(ana, { event: "INSERT", table: "messages", filter: "tenant_id=eq.t1" });
    const g = await listen(gio, { event: "*", table: "messages" });
    expect(a.status).toBe("SUBSCRIBED");
    expect(g.status).toBe("SUBSCRIBED");
    // From the server, with the hidden column: it never reaches the person.
    await data.admin().create("messages", { id: "m2", tenant_id: "t1", body: "new", internal_note: "x", meta: { a: 1 } });
    await settle();
    expect(a.got).toHaveLength(1);
    expect(a.got[0]!.eventType).toBe("INSERT");
    expect(a.got[0]!.table).toBe("messages");
    expect(a.got[0]!.new).toEqual({ id: "m2", tenant_id: "t1", conversation_id: null, body: "new", seen: false, meta: { a: 1 } });
    expect(g.got).toEqual([]);
  });

  it("filters with eq, as Unichat's conversation_id=eq.… does", async () => {
    const { client, data } = project();
    const ana = client("ana");
    const c1 = await listen(ana, { event: "*", table: "messages", filter: "conversation_id=eq.c1" });
    const c2 = await listen(ana, { event: "*", table: "messages", filter: "conversation_id=eq.c2" });
    await data.admin().create("messages", { id: "m3", tenant_id: "t1", conversation_id: "c2", body: "from the server" });
    await settle();
    expect(c1.got).toEqual([]);
    expect(c2.got.map((p) => (p.new as { id: string }).id)).toEqual(["m3"]);
  });

  it("never lets a filter reach another tenant", async () => {
    const { client, data } = project();
    const gio = client("gio");
    const g = await listen(gio, { event: "*", table: "messages", filter: "tenant_id=eq.t1" });
    expect(g.status).toBe("SUBSCRIBED");
    await data.admin().create("messages", { id: "m4", tenant_id: "t1", body: "not for gio" });
    await data.admin().update("messages", [{ column: "id", op: "eq", value: "m1" }], { body: "changed" });
    await data.admin().delete("messages", [{ column: "id", op: "eq", value: "m1" }]);
    await settle();
    expect(g.got).toEqual([]);
  });

  it("sends an UPDATE with the key as old, and a DELETE with the row it may see", async () => {
    const { client } = project();
    const ana = client("ana");
    const a = await listen(ana, { event: "*", table: "messages" });
    await ana.from("messages").update({ seen: true }).eq("id", "m1");
    await ana.from("messages").delete().eq("id", "m1");
    await settle();
    expect(a.got.map((p) => p.eventType)).toEqual(["UPDATE", "DELETE"]);
    expect(a.got[0]!.new).toMatchObject({ id: "m1", seen: true });
    expect(a.got[0]!.old).toEqual({ id: "m1" });
    expect(a.got[1]!.old).toEqual({ id: "m1", tenant_id: "t1", conversation_id: "c1", body: "hello", seen: true, meta: null });
    expect(a.got[1]!.old).not.toHaveProperty("internal_note");
  });

  it("sends nothing to someone signed out", async () => {
    const { client, data } = project();
    const n = await listen(client(), { event: "*", table: "messages" });
    expect(n.status).toBe("SUBSCRIBED");
    await data.admin().create("messages", { id: "m5", tenant_id: "t1" });
    await settle();
    expect(n.got).toEqual([]);
  });

  it("calls an upsert's rows INSERT or UPDATE", async () => {
    const { client } = project();
    const ana = client("ana");
    const a = await listen(ana, { event: "*", table: "messages" });
    await ana.from("messages").upsert([
      { id: "m1", tenant_id: "t1", body: "again" },
      { id: "m6", tenant_id: "t1", body: "first" },
    ]);
    await settle();
    expect(a.got.map((p) => [p.eventType, (p.new as { id: string }).id])).toEqual([
      ["UPDATE", "m1"],
      ["INSERT", "m6"],
    ]);
  });
});

describe("joining", () => {
  it("refuses a table not served, a hidden or missing column, and filters it does not know", async () => {
    const { client } = project();
    const ana = client("ana");
    expect((await listen(ana, { event: "*", table: "tenants" })).status).toBe("CHANNEL_ERROR");
    expect((await listen(ana, { event: "*", table: "messages", filter: "internal_note=eq.secret" })).status).toBe("CHANNEL_ERROR");
    expect((await listen(ana, { event: "*", table: "messages", filter: "nope=eq.x" })).status).toBe("CHANNEL_ERROR");
    expect((await listen(ana, { event: "*", table: "messages", filter: "body=like.h*" })).status).toBe("CHANNEL_ERROR");
    expect((await listen(ana, { event: "*", table: "messages", filter: "tenant_id=in.(t1,t2)" })).status).toBe("SUBSCRIBED");
  });

  it("answers heartbeats, and refuses broadcasts", async () => {
    const { room, sockets, client } = project();
    await listen(client("ana"), { event: "*", table: "messages" });
    const ws = [...sockets][0]!;
    const out: unknown[] = [];
    const send = ws.send;
    ws.send = (m) => void out.push(JSON.parse(m));
    await room.message(ws, JSON.stringify([null, "9", "phoenix", "heartbeat", {}]));
    await room.message(ws, JSON.stringify(["1", "10", "realtime:x", "broadcast", { event: "e", payload: {} }]));
    ws.send = send;
    expect(out).toEqual([
      [null, "9", "phoenix", "phx_reply", { status: "ok", response: {} }],
      ["1", "10", "realtime:x", "phx_reply", { status: "error", response: { reason: "broadcast is not supported" } }],
    ]);
  });

  it("keeps a socket's subscriptions within Cloudflare's 2 KB", async () => {
    const { room, sockets, client } = project();
    await listen(client("ana"), { event: "*", table: "messages" });
    const ws = [...sockets][0]!;
    const out: { status: string }[] = [];
    ws.send = (m) => void out.push(JSON.parse(m)[4]);
    const many = Array.from({ length: 10 }, () => ({ event: "*", table: "messages", filter: `conversation_id=eq.${"x".repeat(60)}` }));
    for (let i = 0; i < 5; i++) await room.message(ws, JSON.stringify(["1", String(i), `realtime:big${i}`, "phx_join", { config: { postgres_changes: many } }]));
    expect(out.map((o) => o.status)).toContain("error");
  });
});

describe("sockets", () => {
  it("closes a person's sockets on disconnect, and old ones on the alarm", async () => {
    const { room, sockets, client } = project(50);
    await listen(client("ana"), { event: "*", table: "messages" });
    await listen(client("gio"), { event: "*", table: "messages" });
    expect(sockets.size).toBe(2);
    expect(room.disconnect("ana")).toBe(1);
    expect(sockets.size).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    await room.alarm();
    expect(sockets.size).toBe(0);
  });
});

describe("the Worker's part", () => {
  function worker(origins?: string[]) {
    const forwarded: Request[] = [];
    const namespace = {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async (input: string, init?: RequestInit) => (forwarded.push(new Request(input, init)), new Response(null, { status: 204 })) }),
    } as unknown as DurableObjectNamespace;
    const realtime = createRealtime({ namespace, auth: async (r) => (r.headers.get("cookie") === "s=ana" ? { id: "ana" } : null), origins });
    return { realtime, forwarded };
  }
  const upgrade = (headers: Record<string, string> = {}) =>
    new Request("https://app.test/realtime/v1/websocket?apikey=unisites&vsn=2.0.0", { headers: { upgrade: "websocket", ...headers } });

  it("lets in only the project's own origin, and those it names", async () => {
    const { realtime } = worker(["capacitor://localhost"]);
    expect((await realtime.handler(upgrade({ origin: "https://evil.unisite.ge" }))).status).toBe(403);
    expect((await realtime.handler(upgrade({ origin: "https://app.test" }))).status).toBe(204);
    expect((await realtime.handler(upgrade({ origin: "capacitor://localhost" }))).status).toBe(204);
    expect((await realtime.handler(new Request("https://app.test/realtime/v1/websocket"))).status).toBe(426);
  });

  it("tells the room who the person is, and nothing the client said about it", async () => {
    const { realtime, forwarded } = worker();
    await realtime.handler(upgrade({ cookie: "s=ana", "x-unisites-realtime-auth": encodeURIComponent('{"id":"gio"}') }));
    await realtime.handler(upgrade({ "x-unisites-realtime-auth": encodeURIComponent('{"id":"gio"}') }));
    expect(forwarded.map((r) => decodeURIComponent(r.headers.get("x-unisites-realtime-auth")!))).toEqual(['{"id":"ana"}', "null"]);
    expect(forwarded[0]!.headers.get("cookie")).toBeNull();
  });
});

describe("limits", () => {
  it("keeps both of two joins sent at once", async () => {
    const { room, sockets, client, data } = project();
    await listen(client("ana"), { event: "*", table: "messages" });
    const ws = [...sockets][0]!;
    const out: unknown[] = [];
    const send = ws.send;
    ws.send = (m) => void out.push(JSON.parse(m));
    const join = (topic: string, filter: string) =>
      room.message(ws, JSON.stringify(["7", topic, `realtime:${topic}`, "phx_join", { config: { postgres_changes: [{ event: "*", table: "messages", filter }] } }]));
    await Promise.all([join("a", "conversation_id=eq.c1"), join("b", "conversation_id=eq.c2")]);
    await data.admin().create("messages", [
      { id: "x1", tenant_id: "t1", conversation_id: "c1" },
      { id: "x2", tenant_id: "t1", conversation_id: "c2" },
    ]);
    ws.send = send;
    const topics = out.filter((m) => (m as unknown[])[3] === "postgres_changes").map((m) => (m as unknown[])[2]);
    expect(topics).toContain("realtime:a");
    expect(topics).toContain("realtime:b");
  });

  it("refuses more than 10 sockets for one person", async () => {
    const { room } = project();
    const closed: number[] = [];
    let attachment: unknown;
    const fake = (): RoomSocket => ({ send() {}, close: (code) => void closed.push(code ?? 0), serializeAttachment: (v) => void (attachment = v), deserializeAttachment: () => attachment });
    const accepted: RoomSocket[] = [];
    for (let i = 0; i < 11; i++) {
      let mine: unknown;
      const ws: RoomSocket = { ...fake(), serializeAttachment: (v) => void (mine = v), deserializeAttachment: () => mine };
      await room.accept(ws, { id: "ana" });
      accepted.push(ws);
    }
    expect(closed).toEqual([1013]);
  });

  it("closes a socket that floods", async () => {
    const { room, sockets, client } = project();
    await listen(client("ana"), { event: "*", table: "messages" });
    const ws = [...sockets][0]!;
    for (let i = 0; i < 60; i++) await room.message(ws, JSON.stringify([null, String(i), "phoenix", "heartbeat", {}]));
    expect(sockets.size).toBe(0);
  });
});

