import type { createBase } from "./base.ts";
import type { Auth, Exec } from "./data.ts";
/**
 * `/auth/v1/*` as Supabase Auth (GoTrue) answers it, on base's better-auth, so supabase-js's
 * `supabase.auth` works unchanged: sign-up with a code, password sign-in, Google, recovery,
 * updateUser, sign-out, and, with the service key, `auth.admin` (unisites ADR 0030).
 *
 *   const gotrue = createGotrue({ base, exec: d1(env.DB), secret: env.BASE_SECRET, serviceKey: env.SERVICE_KEY });
 *   if (url.pathname.startsWith("/auth/v1/")) return gotrue.handler(request);
 *   const rest = createRest({ data, auth: gotrue.person, admin: gotrue.isService });
 *
 * The access token is a JWT (HS256, from the secret), an hour long, and good only while its base
 * session lives: signing out everywhere, a block or a new password ends it at once. The refresh
 * token is the base session's own token. Every sign-in, sign-up and code goes through base's
 * handler, with its rate limits, Turnstile, sign-in log and letters.
 *
 * Not yet: changing the address (updateUser({ email })), phone sign-in, MFA, PKCE.
 */
export type GotrueConfig = {
    base: ReturnType<typeof createBase>;
    /** The project's database, for what a person keeps about themself (base_0004.sql). */
    exec: Exec;
    /** base's own secret (BASE_SECRET); the tokens' key is made from it. */
    secret: string;
    /** What the server's code uses as Supabase's service role key: admin() and auth.admin. */
    serviceKey?: string;
    /** Origins a redirect_to may go to besides the request's own (the app's other domains). */
    redirects?: string[];
    /** Seconds an access token lasts. */
    expiresIn?: number;
    /** A new password is checked against haveibeenpwned.com's breached passwords, as base's own forms do. */
    checkLeakedPasswords?: boolean;
    prefix?: string;
};
type Json = Record<string, unknown>;
export declare function createGotrue(config: GotrueConfig): {
    handler: (request: Request) => Promise<Response>;
    /** A token's claims (ours, live), or null. */
    verify: (token: string | null | undefined) => Promise<Json | null>;
    /** Whether a session lives and its person is not blocked: for Realtime, again and again. */
    alive: (sessionId: unknown) => Promise<boolean>;
    /** The person a request's access token is for, as data's Auth: for createRest and Realtime. */
    person: (request: Request) => Promise<Auth | null>;
    /** Whether a request carries the service key (the server's own code: admin()). */
    isService: (request: Request) => boolean;
};
export {};
