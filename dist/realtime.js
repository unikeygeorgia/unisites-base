import { AccessError, isName } from "./access.js";
import { parseCondition, valueOf } from "./rest.js";
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
export class Room {
    #state;
    #config;
    constructor(state, config) {
        this.#state = state;
        this.#config = config;
    }
    get #maxAge() {
        return this.#config.maxAge ?? 60 * 60 * 1000;
    }
    /** A new socket for this person (the Worker checked who they are and where from). */
    async accept(ws, auth, ip) {
        // Every socket costs each write a check, so their number is kept: in all, and for each one.
        const others = this.#state.getWebSockets().map((w) => w.deserializeAttachment());
        const mine = others.filter((a) => (auth ? a?.auth && String(a.auth.id) === String(auth.id) : !a?.auth && a?.ip === ip));
        this.#state.acceptWebSocket(ws);
        if (others.length >= (this.#config.maxSockets ?? 2000) || mine.length >= MAX_SOCKETS_EACH) {
            ws.serializeAttachment(null);
            return close(ws, 1013, "too many sockets");
        }
        const at = Date.now();
        ws.serializeAttachment({ auth, ip, at, next: 1, topics: {} });
        const alarm = await this.#state.storage.getAlarm();
        if (alarm === null || alarm > at + this.#maxAge)
            await this.#state.storage.setAlarm(at + this.#maxAge);
    }
    #expired(a) {
        return Date.now() - a.at >= this.#maxAge;
    }
    async alarm() {
        let next = Infinity;
        for (const ws of this.#state.getWebSockets()) {
            const a = ws.deserializeAttachment();
            if (!a || this.#expired(a))
                close(ws, 4000, "expired");
            else
                next = Math.min(next, a.at + this.#maxAge);
        }
        if (next < Infinity)
            await this.#state.storage.setAlarm(next);
    }
    /** Closes every socket of this person. */
    disconnect(userId) {
        let n = 0;
        for (const ws of this.#state.getWebSockets()) {
            const a = ws.deserializeAttachment();
            if (a?.auth && String(a.auth.id) === String(userId)) {
                close(ws, 4001, "signed out");
                n++;
            }
        }
        return n;
    }
    #rate = new WeakMap();
    async message(ws, raw) {
        const a = ws.deserializeAttachment();
        if (!a || this.#expired(a))
            return close(ws, 4000, "expired");
        const second = Math.floor(Date.now() / 1000);
        const rate = this.#rate.get(ws);
        if (rate?.second === second) {
            if (++rate.n > MAX_RATE)
                return close(ws, 1008, "too many messages");
        }
        else
            this.#rate.set(ws, { second, n: 1 });
        // Binary frames are realtime-js's broadcasts, which the room does not carry.
        if (typeof raw !== "string")
            return;
        if (raw.length > MAX_MESSAGE)
            return close(ws, 1009, "message too large");
        let m;
        try {
            m = JSON.parse(raw);
        }
        catch {
            return close(ws, 1003, "not JSON");
        }
        if (!Array.isArray(m) || m.length !== 5 || typeof m[2] !== "string" || typeof m[3] !== "string")
            return close(ws, 1003, "not a message");
        const [joinRef, ref, topic, event, payload] = m;
        const reply = (status, response) => send(ws, [joinRef, ref, topic, "phx_reply", { status, response }]);
        if (topic === "phoenix" && event === "heartbeat")
            return reply("ok", {});
        if (event === "phx_leave") {
            delete a.topics[topic];
            ws.serializeAttachment(a);
            return reply("ok", {});
        }
        if (event === "access_token") {
            const ok = await this.#token(ws, payload?.access_token);
            return reply(ok ? "ok" : "error", ok ? {} : { reason: "invalid token" });
        }
        if (event === "broadcast" || event === "presence")
            return reply("error", { reason: `${event} is not supported` });
        if (event !== "phx_join")
            return reply("error", { reason: "not supported" });
        try {
            const token = payload?.access_token;
            if (token !== undefined && !(await this.#token(ws, token)))
                throw new Error("invalid token");
            if (!topic.startsWith("realtime:") || topic.length > 255)
                throw new Error("a topic is realtime:<name>");
            const asked = payload?.config?.postgres_changes ?? [];
            if (!Array.isArray(asked))
                throw new Error("postgres_changes is a list");
            if (asked.length > MAX_BINDINGS)
                throw new Error(`at most ${MAX_BINDINGS} postgres_changes in one channel`);
            const db = this.#config.data.as(ws.deserializeAttachment()?.auth ?? a.auth);
            const asking = [];
            for (const b of asked) {
                const event = b?.event;
                if (event !== "*" && event !== "INSERT" && event !== "UPDATE" && event !== "DELETE")
                    throw new Error("event is INSERT, UPDATE, DELETE or *");
                if (b.schema !== undefined && b.schema !== "public")
                    throw new Error("only the public schema");
                if (typeof b.table !== "string" || !isName(b.table))
                    throw new Error("a table is named");
                if (b.filter !== undefined && typeof b.filter !== "string")
                    throw new Error("a filter is text");
                // The table has to be served to this person, and the filter's column visible to them.
                const desc = await db.describe(b.table);
                if (b.filter)
                    where(desc, b.filter);
                asking.push({ event, schema: b.schema, table: b.table, filter: b.filter || undefined });
            }
            // Read again after the awaits above: another message on this socket may have joined meanwhile.
            const now = ws.deserializeAttachment();
            if (!now)
                return;
            let next = now.next;
            const bindings = asking.map((b) => ({ id: next++, ...b }));
            const topics = { ...now.topics, [topic]: bindings };
            if (Object.keys(topics).length > MAX_TOPICS)
                throw new Error(`at most ${MAX_TOPICS} channels on one socket`);
            const after = { ...now, next, topics };
            if (JSON.stringify(after).length > MAX_ATTACHMENT)
                throw new Error("too many subscriptions on one socket");
            ws.serializeAttachment(after);
            return reply("ok", { postgres_changes: bindings.map(({ id, event, schema, table, filter }) => ({ id, event, schema, table, filter })) });
        }
        catch (e) {
            const reason = e instanceof AccessError ? (e.code === "unknown_table" || e.code === "bad_name" ? "no such table" : e.message) : e.message;
            return reply("error", { reason });
        }
    }
    /**
     * A socket's person from its access token. The supabase-js anon key (not a JWT of ours) changes
     * nothing; a token of ours that does not verify is refused.
     */
    async #token(ws, token) {
        if (!this.#config.verify || typeof token !== "string" || token.split(".").length !== 3)
            return true;
        const claims = await this.#config.verify(token);
        const a = ws.deserializeAttachment();
        if (!a)
            return false;
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
    #alive = new Map();
    async #live(a) {
        if (!a.sid || !this.#config.alive)
            return true;
        const known = this.#alive.get(a.sid);
        if (known && Date.now() - known.at < 60_000)
            return known.ok;
        const ok = await this.#config.alive(a.sid).catch(() => false);
        this.#alive.set(a.sid, { at: Date.now(), ok });
        if (this.#alive.size > 5000)
            this.#alive.clear();
        return ok;
    }
    /** Sends each change to the sockets that may see it. */
    async broadcast(changes) {
        const sockets = this.#state.getWebSockets().map((ws) => ({ ws, a: ws.deserializeAttachment() }));
        // One answer per person and filter for each change: many sockets are the same person.
        const seen = new Map();
        const described = new Map();
        for (const [i, change] of changes.entries()) {
            for (const { ws, a } of sockets) {
                if (!a)
                    continue;
                if (this.#expired(a)) {
                    close(ws, 4000, "expired");
                    continue;
                }
                // A token that has run out, or whose session ended, is no one, until supabase-js sends a renewed one.
                const auth = (a.exp !== undefined && a.exp * 1000 <= Date.now()) || !(await this.#live(a)) ? null : a.auth;
                const who = JSON.stringify(auth);
                const db = this.#config.data.as(auth);
                for (const [topic, bindings] of Object.entries(a.topics)) {
                    const ids = [];
                    let row = null;
                    let desc = null;
                    for (const b of bindings) {
                        if (b.table !== change.table || (b.event !== "*" && b.event !== change.type))
                            continue;
                        try {
                            const dKey = `${who}\0${b.table}`;
                            if (!described.has(dKey))
                                described.set(dKey, db.describe(b.table));
                            desc = await described.get(dKey);
                            // The rule once for each person and change; the filter here, on the row in hand.
                            const key = `${who}\0${i}`;
                            if (!seen.has(key))
                                seen.set(key, db.sees(change.table, (change.type === "DELETE" ? change.old : change.record) ?? {}));
                            const visible = await seen.get(key);
                            if (visible && (!b.filter || matches(where(desc, b.filter)[0], visible))) {
                                ids.push(b.id);
                                row = visible;
                            }
                        }
                        catch {
                            // A table no longer served to them, or a filter that no longer holds: nothing.
                        }
                    }
                    if (!ids.length || !row || !desc)
                        continue;
                    const value = valueOf(desc);
                    const shown = (r) => Object.fromEntries(Object.entries(r ?? {}).map(([c, v]) => [c, value(c, v)]));
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
function pickVisible(old, visible) {
    return Object.fromEntries(Object.entries(old ?? {}).filter(([c]) => Object.hasOwn(visible, c)));
}
/**
 * A filter on a row as the table keeps it: the value was read by the column's type (rest's
 * coerce), so a number meets a number and text text; a boolean is the 1 or 0 SQLite keeps.
 */
function matches(f, row) {
    if (!("column" in f))
        return false;
    const norm = (v) => (typeof v === "boolean" ? (v ? 1 : 0) : v);
    const have = norm(row[f.column]);
    const same = (want) => have !== null && have !== undefined && typeof have === typeof norm(want);
    const want = norm(f.value);
    switch (f.op) {
        case "eq":
            return same(want) && have === want;
        case "neq":
            return same(want) && have !== want;
        case "lt":
            return same(want) && have < want;
        case "lte":
            return same(want) && have <= want;
        case "gt":
            return same(want) && have > want;
        case "gte":
            return same(want) && have >= want;
        case "in":
            return Array.isArray(f.value) && f.value.some((v) => same(v) && have === norm(v));
        default:
            return false;
    }
}
/** `column=op.value`, Supabase's one filter, as data's filters. */
function where(desc, filter) {
    const eq = filter.indexOf("=");
    if (eq < 1)
        throw new Error("a filter is column=op.value");
    const column = filter.slice(0, eq);
    const expr = filter.slice(eq + 1);
    if (!desc.columns.some((c) => c.name === column))
        throw new Error(`no such column: ${column}`);
    const op = expr.slice(0, expr.indexOf("."));
    if (!OPS.has(op))
        throw new Error(`the filter ${op} is not supported (eq neq lt lte gt gte in)`);
    return [parseCondition(desc, column, expr)];
}
function send(ws, m) {
    try {
        ws.send(JSON.stringify(m));
    }
    catch {
        // Closed meanwhile.
    }
}
function close(ws, code, reason) {
    try {
        ws.close(code, reason);
    }
    catch {
        // Closed already.
    }
}
/**
 * The room as a Durable Object class, for the project's wrangler.jsonc:
 *   "durable_objects": { "bindings": [{ "name": "REALTIME", "class_name": "Realtime" }] }
 */
export function createRoom(setup) {
    return class RealtimeRoom {
        room;
        constructor(state, env) {
            this.room = new Room(state, setup(env, state));
        }
        async fetch(request) {
            const url = new URL(request.url);
            if (request.method === "POST" && url.pathname === "/notify") {
                await this.room.broadcast((await request.json()));
                return new Response(null, { status: 204 });
            }
            if (request.method === "POST" && url.pathname === "/disconnect") {
                const { id } = (await request.json());
                return Response.json({ closed: this.room.disconnect(id) });
            }
            if (url.pathname === "/websocket" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
                const auth = JSON.parse(decodeURIComponent(request.headers.get(AUTH_HEADER) ?? "null"));
                const pair = new WebSocketPair();
                const [client, server] = Object.values(pair);
                await this.room.accept(server, auth, request.headers.get(IP_HEADER) ?? undefined);
                return new Response(null, { status: 101, webSocket: client });
            }
            return new Response("not found", { status: 404 });
        }
        webSocketMessage(ws, message) {
            return this.room.message(ws, message);
        }
        webSocketClose(ws, code, reason) {
            close(ws, code === 1005 ? 1000 : code, reason);
        }
        alarm() {
            return this.room.alarm();
        }
    };
}
export function createRealtime(config) {
    const prefix = config.prefix ?? "/realtime/v1/";
    const stub = (room) => config.namespace.get(config.namespace.idFromName(room));
    const refuse = (status, message) => new Response(message, { status, headers: { "cache-control": "no-store" } });
    return {
        async handler(request) {
            const url = new URL(request.url);
            if (url.pathname !== `${prefix}websocket`)
                return refuse(404, "not found");
            if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
                return refuse(426, "a WebSocket");
            // Another site's page may open a socket with the person's cookie: a browser always says
            // where it is from, and only the project's own pages (and the app's) are let in.
            const origin = request.headers.get("origin");
            if (origin && origin !== url.origin && !config.origins?.includes(origin))
                return refuse(403, "this origin may not connect");
            const vsn = url.searchParams.get("vsn");
            if (vsn && vsn !== "2.0.0")
                return refuse(400, "realtime-js's protocol 2.0.0 only");
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
        async notify(changes, room = "main") {
            if (!changes.length)
                return;
            await stub(room).fetch("https://room/notify", { method: "POST", body: JSON.stringify(changes) });
        },
        /** Closes a person's sockets now: after signing out everywhere, or a block. */
        async disconnect(userId, room = "main") {
            const res = await stub(room).fetch("https://room/disconnect", { method: "POST", body: JSON.stringify({ id: userId }) });
            return (await res.json()).closed;
        },
    };
}
