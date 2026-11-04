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
type User = { id: string; email: string; name: string; image?: string | null; emailVerified: boolean | number; createdAt: Date | string; updatedAt: Date | string; banned?: boolean | number | null; banExpires?: Date | string | null; phoneNumber?: string | null; phoneNumberVerified?: boolean | number | null; role?: string | null; twoFactorEnabled?: boolean | number | null };

/** A block that holds now: banned, and not past its end. */
const isBanned = (u: { banned?: unknown; banExpires?: unknown }) =>
  (u.banned === true || u.banned === 1) && (!u.banExpires || new Date(u.banExpires as string).getTime() > Date.now());

class GotrueError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export function createGotrue(config: GotrueConfig) {
  if (!config.secret || config.secret.length < 32) throw new Error("unisites-base: the secret must be at least 32 characters");
  if (config.serviceKey !== undefined && config.serviceKey.length < 32) throw new Error("unisites-base: the service key must be at least 32 characters");
  const prefix = config.prefix ?? "/auth/v1/";
  const expiresIn = config.expiresIn ?? 3600;

  // The tokens' own key, made from base's secret: never the secret itself.
  const key = (async () => {
    const raw = await crypto.subtle.importKey("raw", enc.encode(config.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const derived = await crypto.subtle.sign("HMAC", raw, enc.encode("unisites-base/gotrue/jwt"));
    return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  })();
  const context = async () => (await config.base.auth()).$context;

  async function sign(claims: Json): Promise<string> {
    const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
    const body = b64url(enc.encode(JSON.stringify(claims)));
    const sig = await crypto.subtle.sign("HMAC", await key, enc.encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(sig)}`;
  }

  /** A token's claims, if it is ours, not expired, and its session still lives. */
  async function verify(token: string | null | undefined): Promise<Json | null> {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [head, body, sig] = parts as [string, string, string];
    let claims: Json;
    try {
      const ok = await crypto.subtle.verify("HMAC", await key, fromB64url(sig), enc.encode(`${head}.${body}`));
      if (!ok) return null;
      if (JSON.parse(new TextDecoder().decode(fromB64url(head))).alg !== "HS256") return null;
      claims = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    } catch {
      return null;
    }
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
    return (await alive(claims.session_id)) ? claims : null;
  }

  /** Whether a session still lives and its person is not blocked (Unisites blocks with banned = 1 alone). */
  async function alive(sessionId: unknown): Promise<boolean> {
    if (typeof sessionId !== "string") return false;
    const rows = await config.exec(
      `select s."expiresAt" as at, u."banned" as banned, u."banExpires" as "banExpires" from "_base_session" s join "_base_user" u on u."id" = s."userId" where s."id" = ?`,
      [sessionId],
    );
    return !!rows.length && new Date(String(rows[0]!.at)).getTime() > Date.now() && !isBanned(rows[0]!);
  }

  const bearer = (request: Request) => /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim() ?? null;

  /** Constant-time comparison of the service key. */
  function isServiceKey(token: string | null): boolean {
    if (!config.serviceKey || !token) return false;
    const a = enc.encode(token);
    const b = enc.encode(config.serviceKey);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
    return diff === 0;
  }

  async function metadataOf(userId: string): Promise<Json> {
    const rows = await config.exec(`select "data" from "_base_user_metadata" where "userId" = ?`, [userId]);
    try {
      return rows.length ? (JSON.parse(String(rows[0]!.data)) as Json) : {};
    } catch {
      return {};
    }
  }

  async function saveMetadata(userId: string, data: Json): Promise<void> {
    const merged = { ...(await metadataOf(userId)), ...data };
    for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
    const text = JSON.stringify(merged);
    if (text.length > 16_000) throw new GotrueError(400, "validation_failed", "user_metadata is too large");
    await config.exec(
      `insert into "_base_user_metadata" ("userId", "data", "updatedAt") values (?, ?, ?) on conflict ("userId") do update set "data" = excluded."data", "updatedAt" = excluded."updatedAt"`,
      [userId, text, new Date().toISOString()],
    );
  }

  /** Supabase's user object. */
  async function userJson(u: User): Promise<Json> {
    const ctx = await context();
    const accounts = await ctx.internalAdapter.findAccounts(u.id);
    const providers = [...new Set(accounts.map((a) => (a.providerId === "credential" ? "email" : a.providerId)))];
    const meta = await metadataOf(u.id);
    const verified = u.emailVerified === true || u.emailVerified === 1;
    const placeholder = u.email.endsWith("@phone.invalid");
    return {
      id: u.id,
      aud: "authenticated",
      role: "authenticated",
      email: placeholder ? "" : u.email,
      email_confirmed_at: verified && !placeholder ? iso(u.updatedAt) : null,
      confirmed_at: verified ? iso(u.updatedAt) : null,
      phone: u.phoneNumber ? u.phoneNumber.replace(/^\+/, "") : "",
      phone_confirmed_at: u.phoneNumberVerified ? iso(u.updatedAt) : null,
      app_metadata: { provider: providers[0] ?? "email", providers: providers.length ? providers : ["email"], ...(u.role ? { role: u.role } : {}) },
      user_metadata: { ...meta, full_name: u.name, ...(u.image ? { avatar_url: u.image } : {}) },
      identities: accounts.map((a) => ({ id: a.accountId, user_id: u.id, provider: a.providerId === "credential" ? "email" : a.providerId, identity_data: { sub: a.accountId }, created_at: iso(a.createdAt), updated_at: iso(a.updatedAt) })),
      banned_until: u.banned ? (iso(u.banExpires) ?? "infinity") : null,
      created_at: iso(u.createdAt),
      updated_at: iso(u.updatedAt),
      is_anonymous: false,
    };
  }

  /** A session's tokens, as Supabase answers a sign-in. */
  async function session(token: string): Promise<Json> {
    const ctx = await context();
    const found = await ctx.internalAdapter.findSession(token);
    if (!found || new Date(found.session.expiresAt).getTime() <= Date.now()) throw new GotrueError(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
    const now = Math.floor(Date.now() / 1000);
    const exp = Math.min(now + expiresIn, Math.floor(new Date(found.session.expiresAt).getTime() / 1000));
    const u = found.user as unknown as User;
    if (isBanned(u)) throw new GotrueError(400, "user_banned", "User is banned");
    const access = await sign({
      aud: "authenticated",
      role: "authenticated",
      sub: u.id,
      email: u.email.endsWith("@phone.invalid") ? "" : u.email,
      phone: u.phoneNumber ?? "",
      session_id: found.session.id,
      aal: "aal1",
      is_anonymous: false,
      iat: now,
      exp,
    });
    return { access_token: access, token_type: "bearer", expires_in: exp - now, expires_at: exp, refresh_token: token, user: await userJson(u) };
  }

  /** A path of base's own, as the browser would ask it: base's limits, captcha and log apply. */
  async function call(request: Request, path: string, body: Json, captcha?: string): Promise<{ status: number; json: Json; headers: Headers }> {
    const url = new URL(request.url);
    const headers = new Headers({ "content-type": "application/json", origin: request.headers.get("origin") ?? url.origin });
    for (const h of ["cf-connecting-ip", "user-agent", "accept-language", "cookie"]) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    if (captcha) headers.set("x-captcha-response", captcha);
    const res = await config.base.handler(new Request(`${url.origin}/api/auth${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
    const json = ((await res.json().catch(() => ({}))) ?? {}) as Json;
    return { status: res.status, json, headers: res.headers };
  }

  /** A redirect only to the app's own origins. */
  function redirectTo(request: Request, to: unknown): string {
    const url = new URL(request.url);
    if (typeof to !== "string" || !to) return url.origin;
    let target: URL;
    try {
      target = new URL(to, url.origin);
    } catch {
      return url.origin;
    }
    const ok = target.origin === url.origin || (config.redirects ?? []).some((o) => o.replace(/\/$/, "") === target.origin);
    return ok && (target.protocol === "https:" || target.hostname === "localhost") ? target.toString() : url.origin;
  }

  const answer = (status: number, body: unknown, headers: HeadersInit = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

  const fail = (e: unknown) => {
    if (e instanceof GotrueError) return answer(e.status, { code: e.status, error_code: e.code, msg: e.message });
    console.error("gotrue:", e);
    return answer(500, { code: 500, error_code: "unexpected_failure", msg: "unexpected failure" });
  };

  /** better-auth's refusal as Supabase's. */
  function refused(status: number, json: Json): never {
    const code = String(json.code ?? "");
    if (code === "EMAIL_NOT_VERIFIED") throw new GotrueError(400, "email_not_confirmed", "Email not confirmed");
    if (code === "INVALID_EMAIL_OR_PASSWORD") throw new GotrueError(400, "invalid_credentials", "Invalid login credentials");
    if (code === "USER_ALREADY_EXISTS" || code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") throw new GotrueError(422, "user_already_exists", "User already registered");
    if (code === "PASSWORD_COMPROMISED") throw new GotrueError(422, "weak_password", "Password is known to be weak and easy to guess");
    if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG") throw new GotrueError(422, "weak_password", String(json.message ?? "Password should be at least 8 characters"));
    if (code === "INVALID_OTP" || code === "OTP_EXPIRED" || code === "TOO_MANY_ATTEMPTS") throw new GotrueError(403, "otp_expired", "Token has expired or is invalid");
    if (status === 429) throw new GotrueError(429, "over_request_rate_limit", "Request rate limit reached");
    if (code === "BANNED_USER") throw new GotrueError(400, "user_banned", "User is banned");
    throw new GotrueError(status >= 500 ? 500 : 400, "validation_failed", String(json.message ?? "refused"));
  }

  async function body(request: Request): Promise<Json> {
    if (Number(request.headers.get("content-length") ?? 0) > 64 * 1024) throw new GotrueError(413, "request_too_large", "request too large");
    const text = await request.text();
    if (text.length > 64 * 1024) throw new GotrueError(413, "request_too_large", "request too large");
    try {
      const b = text ? JSON.parse(text) : {};
      return b && typeof b === "object" && !Array.isArray(b) ? (b as Json) : {};
    } catch {
      throw new GotrueError(400, "bad_json", "the body is not JSON");
    }
  }

  const captchaOf = (b: Json) => ((b.gotrue_meta_security as Json | undefined)?.captcha_token as string | undefined) ?? undefined;
  const hashOf = (to: string, s: Json, type: string) =>
    `${to.split("#")[0]}#${new URLSearchParams({ access_token: String(s.access_token), expires_at: String(s.expires_at), expires_in: String(s.expires_in), refresh_token: String(s.refresh_token), token_type: "bearer", type })}`;

  /** The person a request's access token is for. */
  async function signedIn(request: Request): Promise<User> {
    const claims = await verify(bearer(request));
    if (!claims) throw new GotrueError(401, "bad_jwt", "invalid JWT: unable to parse or verify signature");
    const u = await (await context()).internalAdapter.findUserById(String(claims.sub));
    if (!u) throw new GotrueError(404, "user_not_found", "User not found");
    return Object.assign(u as unknown as User, { sessionId: claims.session_id as string });
  }

  /** Whether haveibeenpwned.com has the password (k-anonymity: only 5 characters of its SHA-1 leave). */
  async function breached(password: string): Promise<boolean> {
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-1", enc.encode(password)))].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    try {
      const res = await fetch(`https://api.pwnedpasswords.com/range/${sha.slice(0, 5)}`, { headers: { "add-padding": "true" } });
      if (!res.ok) return false;
      return (await res.text()).split("\n").some((line) => line.split(":")[0]?.trim() === sha.slice(5) && Number(line.split(":")[1]) > 0);
    } catch {
      // The service down does not stop a person from setting a password.
      return false;
    }
  }

  async function setPassword(userId: string, password: unknown, notice = true): Promise<void> {
    const ctx = await context();
    const { minPasswordLength = 8, maxPasswordLength = 128 } = (ctx.options.emailAndPassword ?? {}) as { minPasswordLength?: number; maxPasswordLength?: number };
    if (typeof password !== "string" || password.length < minPasswordLength || password.length > maxPasswordLength) {
      throw new GotrueError(422, "weak_password", `Password should be at least ${minPasswordLength} characters`);
    }
    if (config.checkLeakedPasswords !== false && (await breached(password))) throw new GotrueError(422, "weak_password", "Password is known to be weak and easy to guess, please choose a different one");
    const hash = await ctx.password.hash(password);
    if (await ctx.internalAdapter.findCredentialAccount(userId)) await ctx.internalAdapter.updatePassword(userId, hash);
    else await ctx.internalAdapter.linkAccount({ userId, providerId: "credential", accountId: userId, password: hash });
    if (notice) {
      const u = await ctx.internalAdapter.findUserById(userId);
      if (u) await config.base.notify("passwordChanged", u as never).catch(() => undefined);
    }
  }

  /** What a person (or the admin) writes about them: name and avatar to _base_user, the rest to metadata. */
  async function writeMetadata(userId: string, data: unknown): Promise<void> {
    if (data === undefined) return;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new GotrueError(400, "validation_failed", "data is an object");
    const d = { ...(data as Json) };
    const ctx = await context();
    const own: Json = {};
    if (typeof d.full_name === "string" && d.full_name.trim()) own.name = d.full_name.trim().slice(0, 200);
    if (typeof d.avatar_url === "string") own.image = d.avatar_url.slice(0, 2000);
    delete d.full_name;
    delete d.avatar_url;
    if (Object.keys(own).length) await ctx.internalAdapter.updateUser(userId, own);
    if (Object.keys(d).length) await saveMetadata(userId, d);
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.slice(prefix.length).replace(/\/$/, "");
    const method = request.method.toUpperCase();
    const ctx = await context();

    if (path === "settings" && method === "GET") return answer(200, { external: { email: true, google: true, phone: false }, disable_signup: false, mailer_autoconfirm: false });

    if (path === "token" && method === "POST") {
      const b = await body(request);
      const grant = url.searchParams.get("grant_type");
      if (grant === "password") {
        if (typeof b.email !== "string" || typeof b.password !== "string") throw new GotrueError(400, "validation_failed", "email and password");
        const r = await call(request, "/sign-in/email", { email: b.email, password: b.password }, captchaOf(b));
        if (r.status !== 200 || typeof r.json.token !== "string") {
          if (r.json.twoFactorRedirect) throw new GotrueError(400, "mfa_challenge", "a second factor is not served by /auth/v1 yet");
          refused(r.status, r.json);
        }
        return answer(200, await session(r.json.token as string));
      }
      if (grant === "refresh_token") {
        if (typeof b.refresh_token !== "string") throw new GotrueError(400, "validation_failed", "refresh_token");
        return answer(200, await session(b.refresh_token));
      }
      throw new GotrueError(400, "unsupported_grant_type", `grant_type ${grant ?? ""} is not served`);
    }

    if (path === "signup" && method === "POST") {
      const b = await body(request);
      if (typeof b.email !== "string" || typeof b.password !== "string") throw new GotrueError(400, "validation_failed", "email and password");
      const data = (b.data ?? {}) as Json;
      const name = typeof data.full_name === "string" && data.full_name.trim() ? data.full_name.trim() : b.email.split("@")[0]!;
      const r = await call(request, "/sign-up/email", { email: b.email, password: b.password, name }, captchaOf(b));
      if (r.status !== 200) refused(r.status, r.json);
      const id = (r.json.user as Json | undefined)?.id as string | undefined;
      const u = id ? await ctx.internalAdapter.findUserById(id) : null;
      // An address already there: better-auth answers with a made-up person, and so does this,
      // in the same shape, so the answer never says which addresses exist.
      if (!u) {
        const at = new Date().toISOString();
        return answer(200, { id: id ?? crypto.randomUUID(), aud: "authenticated", role: "authenticated", email: b.email.toLowerCase(), email_confirmed_at: null, confirmed_at: null, phone: "", phone_confirmed_at: null, app_metadata: { provider: "email", providers: ["email"] }, user_metadata: { ...data, full_name: name }, identities: [], banned_until: null, created_at: at, updated_at: at, is_anonymous: false });
      }
      await writeMetadata(u.id, data);
      if (typeof r.json.token === "string") return answer(200, await session(r.json.token));
      // The address is confirmed with a code (base's verifyEmailBy: "code"), as Supabase's verifyOtp asks;
      // sent by base itself, as the sign-up already passed its captcha.
      await ((await config.base.auth()).api as unknown as { sendVerificationOTP(o: { body: Json }): Promise<unknown> }).sendVerificationOTP({ body: { email: u.email, type: "email-verification" } });
      return answer(200, await userJson(u as unknown as User));
    }

    if (path === "verify" && method === "POST") {
      const b = await body(request);
      if (b.type !== "signup" && b.type !== "email") throw new GotrueError(400, "validation_failed", `verify ${String(b.type)} is not served yet`);
      if (typeof b.email !== "string" || typeof b.token !== "string") throw new GotrueError(400, "validation_failed", "email and token");
      const r = await call(request, "/email-otp/verify-email", { email: b.email, otp: b.token });
      if (r.status !== 200) refused(r.status, r.json);
      if (typeof r.json.token === "string") return answer(200, await session(r.json.token));
      throw new GotrueError(400, "validation_failed", "verified, but no session");
    }

    if (path === "resend" && method === "POST") {
      const b = await body(request);
      if (b.type !== "signup" || typeof b.email !== "string") throw new GotrueError(400, "validation_failed", "resend signup with an email");
      const r = await call(request, "/email-otp/send-verification-otp", { email: b.email, type: "email-verification" }, captchaOf(b));
      if (r.status !== 200) refused(r.status, r.json);
      return answer(200, {});
    }

    if (path === "recover" && method === "POST") {
      const b = await body(request);
      if (typeof b.email !== "string") throw new GotrueError(400, "validation_failed", "email");
      const to = redirectTo(request, url.searchParams.get("redirect_to") ?? b.redirect_to);
      const back = `${url.origin}${prefix}verify?type=recovery&redirect_to=${encodeURIComponent(to)}`;
      const r = await call(request, "/request-password-reset", { email: b.email, redirectTo: back }, captchaOf(b));
      // Whether the address exists is never said.
      if (r.status >= 500) refused(r.status, r.json);
      return answer(200, {});
    }

    // The recovery (and invitation) letter's link: a session for its person, into redirect_to's hash.
    if (path === "verify" && method === "GET") {
      const type = url.searchParams.get("type");
      const to = redirectTo(request, url.searchParams.get("redirect_to"));
      const token = url.searchParams.get("token");
      if ((type !== "recovery" && type !== "invite") || !token || !/^[A-Za-z0-9_-]{8,128}$/.test(token)) {
        return Response.redirect(`${to.split("#")[0]}#error=access_denied&error_code=otp_expired&error_description=${encodeURIComponent("Email link is invalid or has expired")}`, 303);
      }
      const v = await ctx.internalAdapter.consumeVerificationValue(`reset-password:${token}`);
      if (!v || new Date(v.expiresAt).getTime() <= Date.now()) {
        return Response.redirect(`${to.split("#")[0]}#error=access_denied&error_code=otp_expired&error_description=${encodeURIComponent("Email link is invalid or has expired")}`, 303);
      }
      const userId = v.value;
      const u = (await ctx.internalAdapter.findUserById(userId)) as unknown as User | null;
      const refuse = (code: string, text: string) =>
        Response.redirect(`${to.split("#")[0]}#error=access_denied&error_code=${code}&error_description=${encodeURIComponent(text)}`, 303);
      if (!u) return refuse("otp_expired", "Email link is invalid or has expired");
      if (isBanned(u)) return refuse("user_banned", "User is banned");
      // A link is one factor: a person with a second one signs in with it, and resets from there.
      if (u.twoFactorEnabled === true || u.twoFactorEnabled === 1) return refuse("mfa_required", "Sign in with your password and second factor");
      if (!(u.emailVerified === true || u.emailVerified === 1)) {
        // The address was never proved: a password or session already on it is someone else's, who
        // signed up with it first. Only the person who reads the letter keeps the account.
        const credential = await ctx.internalAdapter.findCredentialAccount(userId);
        if (credential) await ctx.internalAdapter.deleteAccount(credential.id);
        await ctx.internalAdapter.deleteUserSessions(userId);
      }
      await ctx.internalAdapter.updateUser(userId, { emailVerified: true });
      const s = await ctx.internalAdapter.createSession(userId);
      // As base's own sign-ins: the log of where and how.
      await config.exec(`insert into "_base_sign_in" ("id", "at", "ip", "method", "userAgent", "userId") values (?, ?, ?, ?, ?, ?)`, [
        crypto.randomUUID(), new Date().toISOString(), request.headers.get("cf-connecting-ip"), `${prefix}verify?type=${type}`, request.headers.get("user-agent"), userId,
      ]);
      return new Response(null, { status: 303, headers: { location: hashOf(to, await session(s.token), type), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    }

    if (path === "authorize" && method === "GET") {
      const provider = url.searchParams.get("provider");
      if (provider !== "google") throw new GotrueError(400, "validation_failed", `${provider ?? ""} is not served`);
      const to = redirectTo(request, url.searchParams.get("redirect_to"));
      const back = `${url.origin}${prefix}callback?redirect_to=${encodeURIComponent(to)}`;
      const r = await call(request, "/sign-in/social", { provider, callbackURL: back, errorCallbackURL: back });
      if (r.status !== 200 || typeof r.json.url !== "string") refused(r.status, r.json);
      const headers = new Headers({ location: r.json.url as string, "cache-control": "no-store" });
      for (const c of r.headers.getSetCookie()) headers.append("set-cookie", c);
      return new Response(null, { status: 302, headers });
    }

    if (path === "callback" && method === "GET") {
      const to = redirectTo(request, url.searchParams.get("redirect_to"));
      const s = await config.base.session(request);
      if (!s) return Response.redirect(`${to.split("#")[0]}#error=access_denied&error_description=${encodeURIComponent(url.searchParams.get("error") ?? "sign-in failed")}`, 303);
      return new Response(null, { status: 303, headers: { location: hashOf(to, await session(s.session.token), "signup"), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    }

    if (path === "user" && method === "GET") return answer(200, await userJson(await signedIn(request)));

    if (path === "user" && method === "PUT") {
      const u = await signedIn(request);
      const b = await body(request);
      if (b.email !== undefined && b.email !== u.email) throw new GotrueError(422, "feature_not_available", "changing the address is not served by /auth/v1 yet");
      if (b.password !== undefined) {
        await setPassword(u.id, b.password);
        // A new password ends every other session, as base does after a reset.
        const sessions = await ctx.internalAdapter.listSessions(u.id);
        const keep = (u as User & { sessionId?: string }).sessionId;
        await ctx.internalAdapter.deleteSessions(sessions.filter((x) => x.id !== keep).map((x) => x.token));
      }
      await writeMetadata(u.id, b.data);
      const fresh = await ctx.internalAdapter.findUserById(u.id);
      return answer(200, await userJson(fresh as unknown as User));
    }

    if (path === "logout" && method === "POST") {
      const claims = await verify(bearer(request));
      if (!claims) return answer(204, undefined);
      const scope = url.searchParams.get("scope") ?? "global";
      const sessions = await ctx.internalAdapter.listSessions(String(claims.sub));
      const mine = sessions.find((x) => x.id === claims.session_id);
      const gone = scope === "local" ? (mine ? [mine] : []) : scope === "others" ? sessions.filter((x) => x.id !== claims.session_id) : sessions;
      await ctx.internalAdapter.deleteSessions(gone.map((x) => x.token));
      return answer(204, undefined);
    }

    // ── auth.admin, with the service key only ──
    if (path === "invite" || path.startsWith("admin/")) {
      if (!isServiceKey(bearer(request))) throw new GotrueError(403, "not_admin", "User not allowed");
      return admin(request, url, path, method);
    }

    throw new GotrueError(404, "not_found", `${method} ${prefix}${path} is not served`);
  }

  async function admin(request: Request, url: URL, path: string, method: string): Promise<Response> {
    const ctx = await context();
    const one = /^admin\/users\/([^/]+)$/.exec(path)?.[1];
    const find = async (id: string) => {
      const u = await ctx.internalAdapter.findUserById(id);
      if (!u) throw new GotrueError(404, "user_not_found", "User not found");
      return u as unknown as User;
    };
    const create = async (b: Json, verified: boolean): Promise<User> => {
      if (typeof b.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) throw new GotrueError(400, "validation_failed", "an email");
      const email = b.email.toLowerCase();
      if (await ctx.internalAdapter.findUserByEmail(email)) throw new GotrueError(422, "email_exists", "A user with this email address has already been registered");
      const meta = ((b.user_metadata ?? b.data ?? {}) as Json) || {};
      const name = typeof meta.full_name === "string" && meta.full_name.trim() ? meta.full_name.trim() : email.split("@")[0]!;
      const u = (await ctx.internalAdapter.createUser({ email, name, emailVerified: verified }, { method: "admin" })) as unknown as User;
      if (b.password !== undefined) await setPassword(u.id, b.password, false);
      await writeMetadata(u.id, meta);
      return u;
    };
    if (path === "admin/users" && method === "GET") {
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
      const per = Math.min(1000, Math.max(1, Number(url.searchParams.get("per_page") ?? 50) || 50));
      const users = (await ctx.internalAdapter.listUsers(per, (page - 1) * per)) as unknown as User[];
      return answer(200, { users: await Promise.all(users.map(userJson)), aud: "authenticated" });
    }
    if (path === "admin/users" && method === "POST") {
      const b = await body(request);
      return answer(200, await userJson(await create(b, b.email_confirm === true)));
    }
    if (one && method === "GET") return answer(200, await userJson(await find(one)));
    if (one && method === "PUT") {
      const u = await find(one);
      const b = await body(request);
      const own: Json = {};
      if (typeof b.email === "string" && b.email.toLowerCase() !== u.email) {
        if (await ctx.internalAdapter.findUserByEmail(b.email.toLowerCase())) throw new GotrueError(422, "email_exists", "A user with this email address has already been registered");
        own.email = b.email.toLowerCase();
      }
      if (b.email_confirm === true) own.emailVerified = true;
      if (typeof b.ban_duration === "string") {
        if (b.ban_duration === "none") Object.assign(own, { banned: false, banExpires: null });
        else {
          // Go's durations, as GoTrue takes them: 876600h (a century), 1h30m, 45m.
          const parts = [...b.ban_duration.matchAll(/(\d+)(h|m|s)/g)];
          if (!parts.length || parts.map((m) => m[0]).join("") !== b.ban_duration) throw new GotrueError(400, "validation_failed", "ban_duration is like 24h or 1h30m");
          const ms = parts.reduce((n, m) => n + Number(m[1]) * { h: 3_600_000, m: 60_000, s: 1000 }[m[2] as "h"], 0);
          Object.assign(own, { banned: true, banExpires: new Date(Date.now() + ms) });
          await ctx.internalAdapter.deleteUserSessions(u.id);
        }
      }
      if (Object.keys(own).length) await ctx.internalAdapter.updateUser(u.id, own);
      if (b.password !== undefined) {
        await setPassword(u.id, b.password);
        await ctx.internalAdapter.deleteUserSessions(u.id);
      }
      await writeMetadata(u.id, b.user_metadata);
      return answer(200, await userJson(await find(u.id)));
    }
    if (one && method === "DELETE") {
      await find(one);
      await ctx.internalAdapter.deleteUser(one);
      return answer(200, {});
    }
    if (path === "invite" && method === "POST") {
      const b = await body(request);
      const u = await create({ email: b.email, data: b.data }, false);
      // The letter is base's password letter; its link signs the person in to set one.
      const to = redirectTo(request, url.searchParams.get("redirect_to") ?? b.redirect_to);
      const back = `${url.origin}${prefix}verify?type=invite&redirect_to=${encodeURIComponent(to)}`;
      const r = await call(request, "/request-password-reset", { email: u.email, redirectTo: back });
      if (r.status >= 400) refused(r.status, r.json);
      return answer(200, await userJson(u));
    }
    throw new GotrueError(404, "not_found", `${method} /${path} is not served`);
  }

  return {
    handler: async (request: Request) => {
      try {
        return await handle(request);
      } catch (e) {
        return fail(e);
      }
    },
    /** A token's claims (ours, live), or null. */
    verify,
    /** Whether a session lives and its person is not blocked: for Realtime, again and again. */
    alive,
    /** The person a request's access token is for, as data's Auth: for createRest and Realtime. */
    person: async (request: Request): Promise<Auth | null> => {
      const claims = await verify(bearer(request));
      return claims ? { id: claims.sub, email: claims.email, role: "authenticated" } : null;
    },
    /** Whether a request carries the service key (the server's own code: admin()). */
    isService: (request: Request) => isServiceKey(bearer(request)),
  };
}
