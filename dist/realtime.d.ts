import type { Auth, Change, createData } from "./data.ts";
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
    storage: {
        getAlarm(): Promise<number | null>;
        setAlarm(at: number): Promise<void>;
    };
};
export type RoomConfig = {
    /** The project's data, as for the API: the room asks it what each person may see. */
    data: ReturnType<typeof createData>;
    /** How long one socket lives, in milliseconds. */
    maxAge?: number;
    /** Sockets in the room: each change is checked once for every person among them. */
    maxSockets?: number;
};
export declare class Room {
    #private;
    constructor(state: RoomState, config: RoomConfig);
    /** A new socket for this person (the Worker checked who they are and where from). */
    accept(ws: RoomSocket, auth: Auth | null, ip?: string): Promise<void>;
    alarm(): Promise<void>;
    /** Closes every socket of this person. */
    disconnect(userId: unknown): number;
    message(ws: RoomSocket, raw: string | ArrayBuffer): Promise<void>;
    /** Sends each change to the sockets that may see it. */
    broadcast(changes: Change[]): Promise<void>;
}
/**
 * The room as a Durable Object class, for the project's wrangler.jsonc:
 *   "durable_objects": { "bindings": [{ "name": "REALTIME", "class_name": "Realtime" }] }
 */
export declare function createRoom<Env>(setup: (env: Env, state: RoomState) => RoomConfig): {
    new (state: RoomState, env: Env): {
        readonly room: Room;
        fetch(request: Request): Promise<Response>;
        webSocketMessage(ws: RoomSocket, message: string | ArrayBuffer): Promise<void>;
        webSocketClose(ws: RoomSocket, code: number, reason: string): void;
        alarm(): Promise<void>;
    };
};
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
export declare function createRealtime(config: RealtimeConfig): {
    handler(request: Request): Promise<Response>;
    /** Tells the room of a write's rows (createData's onChange). */
    notify(changes: Change[], room?: string): Promise<void>;
    /** Closes a person's sockets now: after signing out everywhere, or a block. */
    disconnect(userId: unknown, room?: string): Promise<number>;
};
