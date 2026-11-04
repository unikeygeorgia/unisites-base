import { AccessError, isName } from "./access.ts";
import type { Auth, Change, Described, Filter, Row, createData } from "./data.ts";
import { parseCondition, valueOf } from "./rest.ts";

/**
 * Realtime as Supabase's realtime-js speaks it (unisites ADR 0030, step 3), so that
 * `supabase.channel(name).on("postgres_changes", { event, table, filter }, cb).subscribe()`
 * works unchanged. A room is a Durable Object with hibernating WebSockets; every write through
 * data (as or admin) tells it the rows (createData's onChange), and it sends each row only to the
 * sockets whose person list's rule lets see it, without hidden columns, through their filter.
 *
 *   // the Worker
 *   export const Realtime = createRoom((env: Env) => ({ data: createData({ exec: d1(env.DB), access }) }));
 *   const realtime = createRealtime({ namespace: env.REALTIME, auth });
 *   const data = createData({ exec: d1(env.DB), access, onChange: (c) => ctx.waitUntil(realtime.notify(c)) });
 *   if (url.pathname.startsWith("/realtime/v1/")) return realtime.handler(request);
 *
 * What it takes: postgres_changes on one table of the public schema, event INSERT, UPDATE,
 * DELETE or *, and at most one filter `column=op.value` with eq neq lt lte gt gte in (Supabase's).
 * Not yet: broadcast and presence (a join that asks for them still joins; their messages are
 * refused). Unlike Supabase, a DELETE is checked against the rules and filter like the others,
 * and its old row is the whole row the person may see.
 *
 * A socket lives at most maxAge (an hour): realtime-js then joins again, and the person's
 * session is checked again. disconnect(userId) closes a person's sockets at once (signing out
 * everywhere, a block).
 */

/** The person a socket is for, from the Worker to the room: never from the client. */
const AUTH_HEADER = "x-unisites-realtime-auth";
/** Where the socket is from, for the signed out's limit. */
const IP_HEADER = "x-unisites-realtime-ip";

const MAX_TOPICS = 20;
const MAX_BINDINGS = 10;
const MAX_MESSAGE = 64 * 1024;
/** Cloudflare keeps at most 2,048 bytes with a hibernating socket. */
const MAX_ATTACHMENT = 2000;
const OPS = new Set(["eq", "neq", "lt", "lte", "gt", "gte", "in"]);
/** Sockets of one person (or of one address, signed out). */
const MAX_SOCKETS_EACH = 10;
/** Messages a socket may send in a second. */
const MAX_RATE = 50;

type Binding = { id: number; event: string; schema?: string; table: string; filter?: string };
/** exp: when the person's access token (/auth/v1) ends, in seconds; after it they are signed out. */
type Attachment = { auth: Auth | null; exp?: number; sid?: string; ip?: string; at: number; next: number; topics: Record<string, Binding[]> };

/** The part of a hibernating WebSocket the room uses. */
export type RoomSocket = {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};

/** The part of a Durable Object's state the room uses. */
export type RoomState = {
  acceptWebSocket(ws: RoomSocket): void;
  getWebSockets(): RoomSocket[];
  storage: { getAlarm(): Promise<number | null>; setAlarm(at: number): Promise<void> };
};

export type RoomConfig = {
  /** The project's data, as for the API: the room asks it what each person may see. */
  data: ReturnType<typeof createData>;
  /** How long one socket lives, in milliseconds. */
  maxAge?: number;
  /** Sockets in the room: each change is checked once for every person among them. */
  maxSockets?: number;
  /**
   * The person an access token is for (gotrue.verify): supabase-js sends its token in each join
   * and again when it is renewed, as the browser has no cookie for /auth/v1's sessions.
   */
  verify?: (token: string) => Promise<{ sub?: unknown; email?: unknown; exp?: unknown; session_id?: unknown } | null>;
  /** Whether a token's session still lives (gotrue.alive): signing out or a block stops the rows within a minute. */
  alive?: (sessionId: string) => Promise<boolean>;
};

type Message = [string | null, string | null, string, string, unknown];

export class Room {
  readonly #state: RoomState;
  readonly #config: RoomConfig;

  constructor(state: RoomState, config: RoomConfig) {
    this.#state = state;
    this.#config = config;
  }

  get #maxAge(): number {
    return this.#config.maxAge ?? 60 * 60 * 1000;
  }

  /** A new socket for this person (the Worker checked who they are and where from). */
  async accept(ws: RoomSocket, auth: Auth | null, ip?: string): Promise<void> {
    // Every socket costs each write a check, so their number is kept: in all, and for each one.
    const others = this.#state.getWebSockets().map((w) => w.deserializeAttachment() as Attachment | null);
    const mine = others.filter((a) => (auth ? a?.auth && String(a.auth.id) === String(auth.id) : !a?.auth && a?.ip === ip));
    this.#state.acceptWebSocket(ws);
    if (others.length >= (this.#config.maxSockets ?? 2000) || mine.length >= MAX_SOCKETS_EACH) {
      ws.serializeAttachment(null);
      return close(ws, 1013, "too many sockets");
    }
    const at = Date.now();
    ws.serializeAttachment({ auth, ip, at, next: 1, topics: {} } satisfies Attachment);
    const alarm = await this.#state.storage.getAlarm();
    if (alarm === null || alarm > at + this.#maxAge) await this.#state.storage.setAlarm(at + this.#maxAge);
  }

  #expired(a: Attachment): boolean {
    return Date.now() - a.at >= this.#maxAge;
  }

  async alarm(): Promise<void> {
    let next = Infinity;
    for (const ws of this.#state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a || this.#expired(a)) close(ws, 4000, "expired");
      else next = Math.min(next, a.at + this.#maxAge);
    }
    if (next < Infinity) await this.#state.storage.setAlarm(next);
  }

  /** Closes every socket of this person. */
  disconnect(userId: unknown): number {
    let n = 0;
    for (const ws of this.#state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.auth && String(a.auth.id) === String(userId)) {
        close(ws, 4001, "signed out");
        n++;
      }
    }
    return n;
  }

  readonly #rate = new WeakMap<RoomSocket, { second: number; n: number }>();

  async message(ws: RoomSocket, raw: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a || this.#expired(a)) return close(ws, 4000, "expired");
    const second = Math.floor(Date.now() / 1000);
    const rate = this.#rate.get(ws);
    if (rate?.second === second) {
      if (++rate.n > MAX_RATE) return close(ws, 1008, "too many messages");
    } else this.#rate.set(ws, { second, n: 1 });
    // Binary frames are realtime-js's broadcasts, which the room does not carry.
    if (typeof raw !== "string") return;
    if (raw.length > MAX_MESSAGE) return close(ws, 1009, "message too large");
    let m: Message;
    try {
      m = JSON.parse(raw);
    } catch {
      return close(ws, 1003, "not JSON");
    }
    if (!Array.isArray(m) || m.length !== 5 || typeof m[2] !== "string" || typeof m[3] !== "string") return close(ws, 1003, "not a message");
    const [joinRef, ref, topic, event, payload] = m;
    const reply = (status: "ok" | "error", response: unknown) => send(ws, [joinRef, ref, topic, "phx_reply", { status, response }]);

    if (topic === "phoenix" && event === "heartbeat") return reply("ok", {});
    if (event === "phx_leave") {
      delete a.topics[topic];
      ws.serializeAttachment(a);
      return reply("ok", {});
    }
    if (event === "access_token") {
      const ok = await this.#token(ws, (payload as { access_token?: unknown } | null)?.access_token);
      return reply(ok ? "ok" : "error", ok ? {} : { reason: "invalid token" });
    }
    if (event === "broadcast" || event === "presence") return reply("error", { reason: `${event} is not supported` });
    if (event !== "phx_join") return reply("error", { reason: "not supported" });

    try {
      const token = (payload as { access_token?: unknown } | null)?.access_token;
      if (token !== undefined && !(await this.#token(ws, token))) throw new Error("invalid token");
      if (!topic.startsWith("realtime:") || topic.length > 255) throw new Error("a topic is realtime:<name>");
      const asked = (payload as { config?: { postgres_changes?: unknown } } | null)?.config?.postgres_changes ?? [];
      if (!Array.isArray(asked)) throw new Error("postgres_changes is a list");
      if (asked.length > MAX_BINDINGS) throw new Error(`at most ${MAX_BINDINGS} postgres_changes in one channel`);
      const db = this.#config.data.as((ws.deserializeAttachment() as Attachment | null)?.auth ?? a.auth);
      const asking: Omit<Binding, "id">[] = [];
      for (const b of asked as Record<string, unknown>[]) {
        const event = b?.event;
        if (event !== "*" && event !== "INSERT" && event !== "UPDATE" && event !== "DELETE") throw new Error("event is INSERT, UPDATE, DELETE or *");
        if (b.schema !== undefined && b.schema !== "public") throw new Error("only the public schema");
        if (typeof b.table !== "string" || !isName(b.table)) throw new Error("a table is named");
        if (b.filter !== undefined && typeof b.filter !== "string") throw new Error("a filter is text");
        // The table has to be served to this person, and the filter's column visible to them.
        const desc = await db.describe(b.table);
        if (b.filter) where(desc, b.filter);
        asking.push({ event, schema: b.schema as string | undefined, table: b.table, filter: b.filter || undefined });
      }
      // Read again after the awaits above: another message on this socket may have joined meanwhile.
      const now = ws.deserializeAttachment() as Attachment | null;
      if (!now) return;
      let next = now.next;
      const bindings: Binding[] = asking.map((b) => ({ id: next++, ...b }));
      const topics = { ...now.topics, [topic]: bindings };
      if (Object.keys(topics).length > MAX_TOPICS) throw new Error(`at most ${MAX_TOPICS} channels on one socket`);
      const after: Attachment = { ...now, next, topics };
      if (JSON.stringify(after).length > MAX_ATTACHMENT) throw new Error("too many subscriptions on one socket");
      ws.serializeAttachment(after);
      return reply("ok", { postgres_changes: bindings.map(({ id, event, schema, table, filter }) => ({ id, event, schema, table, filter })) });
    } catch (e) {
      const reason = e instanceof AccessError ? (e.code === "unknown_table" || e.code === "bad_name" ? "no such table" : e.message) : (e as Error).message;
      return reply("error", { reason });
    }
  }

  /**
   * A socket's person from its access token. The supabase-js anon key (not a JWT of ours) changes
   * nothing; a token of ours that does not verify is refused.
   */
  async #token(ws: RoomSocket, token: unknown): Promise<boolean> {
    if (!this.#config.verify || typeof token !== "string" || token.split(".").length !== 3) return true;
    const claims = await this.#config.verify(token);
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) return false;
    // A token that is not ours (an old Supabase anon key, or a forged one) is no one, as signed out.
    if (!claims || typeof claims.sub !== "string") {
      ws.serializeAttachment({ ...a, auth: null, exp: undefined, sid: undefined });
      return true;
    }
    ws.serializeAttachment({
      ...a,
      auth: { id: claims.sub, ...(typeof claims.email === "string" ? { email: claims.email } : {}) },
      exp: typeof claims.exp === "number" ? claims.exp : undefined,
      sid: typeof claims.session_id === "string" ? claims.session_id : undefined,
    });
    return true;
  }

  // Sessions found alive, for a minute: a broadcast does not ask the database for each socket.
  readonly #alive = new Map<string, { at: number; ok: boolean }>();

  async #live(a: Attachment): Promise<boolean> {
    if (!a.sid || !this.#config.alive) return true;
    const known = this.#alive.get(a.sid);
    if (known && Date.now() - known.at < 60_000) return known.ok;
    const ok = await this.#config.alive(a.sid).catch(() => false);
    this.#alive.set(a.sid, { at: Date.now(), ok });
    if (this.#alive.size > 5000) this.#alive.clear();
    return ok;
  }

  /** Sends each change to the sockets that may see it. */
  async broadcast(changes: Change[]): Promise<void> {
    const sockets = this.#state.getWebSockets().map((ws) => ({ ws, a: ws.deserializeAttachment() as Attachment | null }));
    // One answer per person and filter for each change: many sockets are the same person.
    const seen = new Map<string, Promise<Row | null>>();
    const described = new Map<string, Promise<Described>>();
    for (const [i, change] of changes.entries()) {
      for (const { ws, a } of sockets) {
        if (!a) continue;
        if (this.#expired(a)) {
          close(ws, 4000, "expired");
          continue;
        }
        // A token that has run out, or whose session ended, is no one, until supabase-js sends a renewed one.
        const auth = (a.exp !== undefined && a.exp * 1000 <= Date.now()) || !(await this.#live(a)) ? null : a.auth;
        const who = JSON.stringify(auth);
        const db = this.#config.data.as(auth);
        for (const [topic, bindings] of Object.entries(a.topics)) {
          const ids: number[] = [];
          let row: Row | null = null;
          let desc: Described | null = null;
          for (const b of bindings) {
            if (b.table !== change.table || (b.event !== "*" && b.event !== change.type)) continue;
            try {
              const dKey = `${who}\0${b.table}`;
              if (!described.has(dKey)) described.set(dKey, db.describe(b.table));
              desc = await described.get(dKey)!;
              // The rule once for each person and change; the filter here, on the row in hand.
              const key = `${who}\0${i}`;
              if (!seen.has(key)) seen.set(key, db.sees(change.table, (change.type === "DELETE" ? change.old : change.record) ?? {}));
              const visible = await seen.get(key)!;
              if (visible && (!b.filter || matches(where(desc, b.filter)[0]!, visible))) {
                ids.push(b.id);
                row = visible;
              }
            } catch {
              // A table no longer served to them, or a filter that no longer holds: nothing.
            }
          }
          if (!ids.length || !row || !desc) continue;
          const value = valueOf(desc);
          const shown = (r: Row | null) => Object.fromEntries(Object.entries(r ?? {}).map(([c, v]) => [c, value(c, v)]));
          const old = change.type === "DELETE" ? row : change.type === "UPDATE" ? pickVisible(change.old, row) : {};
          send(ws, [
            null,
            null,
            topic,
            "postgres_changes",
            {
              ids,
              data: {
                schema: "public",
                table: change.table,
                commit_timestamp: change.at,
                type: change.type,
                errors: null,
                // "text" leaves the values as they are: they are already Postgres' (true, parsed JSON).
                columns: desc.columns.map((c) => ({ name: c.name, type: "text" })),
                record: change.type === "DELETE" ? {} : shown(row),
                old_record: shown(old),
              },
            },
          ]);
        }
      }
    }
  }
}

// An UPDATE's old row is its key, and only the columns the person sees.
function pickVisible(old: Row | null, visible: Row): Row {
  return Object.fromEntries(Object.entries(old ?? {}).filter(([c]) => Object.hasOwn(visible, c)));
}

/**
 * A filter on a row as the table keeps it: the value was read by the column's type (rest's
 * coerce), so a number meets a number and text text; a boolean is the 1 or 0 SQLite keeps.
 */
function matches(f: Filter, row: Row): boolean {
  if (!("column" in f)) return false;
  const norm = (v: unknown) => (typeof v === "boolean" ? (v ? 1 : 0) : v);
  const have = norm(row[f.column]);
  const same = (want: unknown) => have !== null && have !== undefined && typeof have === typeof norm(want);
  const want = norm(f.value) as number | string;
  switch (f.op) {
    case "eq":
      return same(want) && have === want;
    case "neq":
      return same(want) && have !== want;
    case "lt":
      return same(want) && (have as number | string) < want;
    case "lte":
      return same(want) && (have as number | string) <= want;
    case "gt":
      return same(want) && (have as number | string) > want;
    case "gte":
      return same(want) && (have as number | string) >= want;
    case "in":
      return Array.isArray(f.value) && f.value.some((v) => same(v) && have === norm(v));
    default:
      return false;
  }
}

/** `column=op.value`, Supabase's one filter, as data's filters. */
function where(desc: Described, filter: string): Filter[] {
  const eq = filter.indexOf("=");
  if (eq < 1) throw new Error("a filter is column=op.value");
  const column = filter.slice(0, eq);
  const expr = filter.slice(eq + 1);
  if (!desc.columns.some((c) => c.name === column)) throw new Error(`no such column: ${column}`);
  const op = expr.slice(0, expr.indexOf("."));
  if (!OPS.has(op)) throw new Error(`the filter ${op} is not supported (eq neq lt lte gt gte in)`);
  return [parseCondition(desc, column, expr)];
}

function send(ws: RoomSocket, m: Message): void {
  try {
    ws.send(JSON.stringify(m));
  } catch {
    // Closed meanwhile.
  }
}

function close(ws: RoomSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Closed already.
  }
}

/**
 * The room as a Durable Object class, for the project's wrangler.jsonc:
 *   "durable_objects": { "bindings": [{ "name": "REALTIME", "class_name": "Realtime" }] }
 */
export function createRoom<Env>(setup: (env: Env, state: RoomState) => RoomConfig) {
  return class RealtimeRoom {
    readonly room: Room;

    constructor(state: RoomState, env: Env) {
      this.room = new Room(state, setup(env, state));
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/notify") {
        await this.room.broadcast((await request.json()) as Change[]);
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST" && url.pathname === "/disconnect") {
        const { id } = (await request.json()) as { id: unknown };
        return Response.json({ closed: this.room.disconnect(id) });
      }
      if (url.pathname === "/websocket" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const auth = JSON.parse(decodeURIComponent(request.headers.get(AUTH_HEADER) ?? "null")) as Auth | null;
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
        await this.room.accept(server as unknown as RoomSocket, auth, request.headers.get(IP_HEADER) ?? undefined);
        return new Response(null, { status: 101, webSocket: client });
      }
      return new Response("not found", { status: 404 });
    }

    webSocketMessage(ws: RoomSocket, message: string | ArrayBuffer): Promise<void> {
      return this.room.message(ws, message);
    }

    webSocketClose(ws: RoomSocket, code: number, reason: string): void {
      close(ws, code === 1005 ? 1000 : code, reason);
    }

    alarm(): Promise<void> {
      return this.room.alarm();
    }
  };
}

export type RealtimeConfig = {
  /** The room's Durable Object binding. */
  namespace: DurableObjectNamespace;
  /** The person a socket is for, or null; from the session cookie, as for the API. */
  auth: (request: Request) => Promise<Auth | null>;
  /** Which room a socket joins (supabase-js's realtime params come in the URL); "main" by default. */
  room?: (request: Request, auth: Auth | null) => string | Promise<string>;
  /** Other origins that may open a socket with the person's cookie (an app's WebView). */
  origins?: string[];
  prefix?: string;
};

export function createRealtime(config: RealtimeConfig) {
  const prefix = config.prefix ?? "/realtime/v1/";
  const stub = (room: string) => config.namespace.get(config.namespace.idFromName(room));
  const refuse = (status: number, message: string) => new Response(message, { status, headers: { "cache-control": "no-store" } });

  return {
    async handler(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== `${prefix}websocket`) return refuse(404, "not found");
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return refuse(426, "a WebSocket");
      // Another site's page may open a socket with the person's cookie: a browser always says
      // where it is from, and only the project's own pages (and the app's) are let in.
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin && !config.origins?.includes(origin)) return refuse(403, "this origin may not connect");
      const vsn = url.searchParams.get("vsn");
      if (vsn && vsn !== "2.0.0") return refuse(400, "realtime-js's protocol 2.0.0 only");
      const auth = await config.auth(request);
      const room = config.room ? await config.room(request, auth) : "main";
      // A new request: nothing of the client's but the upgrade reaches the room.
      return stub(room).fetch("https://room/websocket", {
        headers: {
          upgrade: "websocket",
          [AUTH_HEADER]: encodeURIComponent(JSON.stringify(auth)),
          [IP_HEADER]: request.headers.get("cf-connecting-ip") ?? "",
        },
      });
    },

    /** Tells the room of a write's rows (createData's onChange). */
    async notify(changes: Change[], room = "main"): Promise<void> {
      if (!changes.length) return;
      await stub(room).fetch("https://room/notify", { method: "POST", body: JSON.stringify(changes) });
    },

    /** Closes a person's sockets now: after signing out everywhere, or a block. */
    async disconnect(userId: unknown, room = "main"): Promise<number> {
      const res = await stub(room).fetch("https://room/disconnect", { method: "POST", body: JSON.stringify({ id: userId }) });
      return ((await res.json()) as { closed: number }).closed;
    },
  };
}
