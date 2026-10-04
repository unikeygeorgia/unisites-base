import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { hashPassword } from "better-auth/crypto";
import { admin, captcha, emailOTP, haveIBeenPwned, phoneNumber, twoFactor } from "better-auth/plugins";

import { messagesFrom, render, type Locale, type Messages, type NoticeKind, type TemplateKind } from "./messages.ts";
import { isBcrypt, passwords } from "./passwords.ts";
import { isE164, isPlaceholderEmail, placeholderEmail } from "./phone.ts";
import type { MailSender, SmsSender } from "./senders.ts";
import {
  ALL_ON,
  logMessage,
  noteCapabilities,
  readCapabilities,
  readSwitches,
  readTemplates,
  type LogLine,
  type SettingsDatabase,
  NOTICES_DEFAULT,
  readNotices,
  type Notices,
  type Switches,
  type Templates,
  run,
} from "./settings.ts";

/**
 * A Unisites project's sign-in (ADR 0021, 0022): better-auth on the
 * project's own D1, in the project's own Worker. Its tables are _base_*
 * (migrations/), its cookie is __Host-, SMS and mail go through the
 * project's own senders in the person's language, every sign-in is
 * written down, and the project's admins can turn on a second factor.
 *
 * Unisites' "Users" page reads and changes the same tables through D1, so
 * a project needs no admin endpoint: blocking someone is `banned = 1`,
 * signing them out everywhere is deleting their sessions.
 *
 * The instance is made for each request (it is cheap), so the language and
 * the address are that request's.
 */

export type BaseConfig = {
  /** The name people see in SMS and mail: "Multicolor". */
  app: string;
  /** Where the project answers, "https://myshop.ge"; sign-in lives at /api/auth. */
  baseURL: string;
  /** The project's D1 (env.DB); Node's DatabaseSync in tests. */
  database: BetterAuthOptions["database"];
  /** The project's secret for signing (a Worker secret, BASE_SECRET), 32+ characters. */
  secret: string;
  locale?: Locale;
  /** Phone + SMS code. On when an SMS sender is given. */
  sms?: SmsSender;
  /** Email + password, email codes, confirmation and reset. On when a mail sender is given. */
  mail?: MailSender;
  /** Sign up and in with a password (with mail), or with codes only. Default: true. */
  passwords?: boolean;
  /** People may make an account themselves. Default: true. */
  signUp?: boolean;
  google?: { clientId: string; clientSecret: string };
  /** Kept for later: Meta's app review comes first (ADR 0022). */
  facebook?: { clientId: string; clientSecret: string };
  /** Cloudflare Turnstile on sign-up, sign-in and codes. */
  turnstileSecret?: string;
  /** Refuse passwords found in breaches (haveibeenpwned, k-anonymity). Default: true. */
  checkLeakedPasswords?: boolean;
  /** Other origins allowed to post here (the project's other domains). */
  trustedOrigins?: string[];
  /** Replace any of base's texts. */
  messages?: Partial<Messages>;
  /** The Worker's ctx.waitUntil: SMS and mail are sent after the answer, not before. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Where a failed send is told (the Worker's log by default). */
  onSendError?: (what: string, error: unknown) => void;
  /** The admin's switches (settings.ts); createBase reads them from the project's D1. */
  switches?: Switches;
  /** The project's own templates (settings.ts); createBase reads them from the project's D1. */
  templates?: Templates;
  /** Keep every SMS and letter in _base_message_log (base_0003.sql). createBase turns it on when the table is there. */
  log?: boolean;
  /** Which security notices go out (settings.ts); createBase reads them from the project's D1. */
  notices?: Notices;
};

/** What the code lets this project do, before the admin's switches. */
export function capabilitiesOf(config: BaseConfig): Switches {
  return {
    emailCode: Boolean(config.mail),
    facebook: Boolean(config.facebook),
    google: Boolean(config.google),
    passwords: Boolean(config.mail) && config.passwords !== false,
    phone: Boolean(config.sms),
    signUp: config.signUp !== false,
  };
}

/** The table names, as the migration makes them. */
export const TABLES = {
  account: "_base_account",
  rateLimit: "_base_rate_limit",
  session: "_base_session",
  signIn: "_base_sign_in",
  twoFactor: "_base_two_factor",
  user: "_base_user",
  verification: "_base_verification",
} as const;

/**
 * Stricter limits where a request costs money or guesses a secret, per IP
 * (window in seconds, requests in it). An SMS is paid for: a script that
 * asks for codes to many numbers ("SMS pumping") must hit a wall fast.
 */
export const RATE_RULES = {
  "/email-otp/send-verification-otp": { max: 3, window: 60 },
  "/phone-number/send-otp": { max: 3, window: 60 },
  "/phone-number/verify": { max: 10, window: 60 },
  "/request-password-reset": { max: 3, window: 60 },
  "/sign-in/email": { max: 5, window: 60 },
  "/sign-in/email-otp": { max: 10, window: 60 },
  "/sign-up/email": { max: 5, window: 60 },
} as const;

/** Paths a person reaches to get in, guarded by Turnstile when it is on. */
const GUARDED = [
  "/sign-up/email",
  "/sign-in/email",
  "/phone-number/send-otp",
  "/email-otp/send-verification-otp",
  "/request-password-reset",
];

/**
 * Base's own bookkeeping: every new session is written to _base_sign_in
 * (who, when, from where, how), and a bcrypt password that just signed in
 * is written again as scrypt.
 */
type Notify = (kind: NoticeKind, user: { email: string; name?: string | null }, device?: string | null) => Promise<void>;

/** "Safari, macOS"-ish, from a user agent, for a notice. */
export function deviceOf(agent: string | null | undefined): string {
  if (!agent) return "?";
  const browser = /Edg\//.test(agent) ? "Edge" : /Chrome\//.test(agent) ? "Chrome" : /Firefox\//.test(agent) ? "Firefox" : /Safari\//.test(agent) ? "Safari" : (agent.split(/[/ ]/)[0] ?? "?");
  const system = /iPhone|iPad/.test(agent) ? "iOS" : /Android/.test(agent) ? "Android" : /Mac OS X/.test(agent) ? "macOS" : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : "";
  return [browser, system].filter(Boolean).join(", ").slice(0, 60);
}

function unisitesBase(notify: Notify): BetterAuthPlugin {
  return {
    hooks: {
      after: [
        {
          // A password changed while signed in; a reset is told by onPasswordReset.
          handler: createAuthMiddleware(async (ctx) => {
            const user = ctx.context.session?.user;
            if (user && !(ctx.context.returned instanceof Error)) await notify("passwordChanged", user);
          }),
          matcher: (ctx) => ctx.path === "/change-password",
        },
        {
          handler: createAuthMiddleware(async (ctx) => {
            const user = ctx.context.session?.user;
            if (user && !(ctx.context.returned instanceof Error)) await notify("twoFactorDisabled", user);
          }),
          matcher: (ctx) => ctx.path === "/two-factor/disable",
        },
        {
          handler: createAuthMiddleware(async (ctx) => {
            const userId = ctx.context.newSession?.user.id;
            const password = (ctx.body as { password?: unknown } | undefined)?.password;
            if (!userId || typeof password !== "string") return;
            const accounts = await ctx.context.internalAdapter.findAccounts(userId);
            const credential = accounts.find((a) => a.providerId === "credential");
            if (credential?.password && isBcrypt(credential.password)) {
              await ctx.context.internalAdapter.updatePassword(userId, await hashPassword(password));
            }
          }),
          matcher: (ctx) => ctx.path === "/sign-in/email",
        },
      ],
    },
    id: "unisites-base",
    init: () => ({
      options: {
        databaseHooks: {
          session: {
            create: {
              after: async (session, ctx) => {
                if (!ctx) return;
                // A device this person has not signed in from before (by its user agent), when they have before.
                const before = await ctx.context.adapter.findMany<{ userAgent: string | null }>({
                  limit: 50,
                  model: "signIn",
                  where: [{ field: "userId", value: session.userId }],
                });
                const newDevice = before.length > 0 && !before.some((b) => b.userAgent === (session.userAgent ?? null));
                await ctx.context.adapter.create({
                  data: {
                    at: new Date(),
                    ip: session.ipAddress ?? null,
                    method: ctx.path ?? null,
                    userAgent: session.userAgent ?? null,
                    userId: session.userId,
                  },
                  model: "signIn",
                });
                if (newDevice) {
                  const user = await ctx.context.internalAdapter.findUserById(session.userId);
                  if (user) await notify("newSignIn", user, session.userAgent);
                }
              },
            },
          },
        },
      },
    }),
    schema: {
      signIn: {
        fields: {
          at: { required: true, type: "date" },
          ip: { required: false, type: "string" },
          method: { required: false, type: "string" },
          userAgent: { required: false, type: "string" },
          userId: {
            index: true,
            references: { field: "id", model: "user", onDelete: "cascade" },
            required: true,
            type: "string",
          },
        },
        modelName: TABLES.signIn,
      },
    },
  } satisfies BetterAuthPlugin;
}

export function baseOptions(config: BaseConfig) {
  if (!config.secret || config.secret.length < 32) {
    throw new Error("unisites-base: the secret must be at least 32 characters (a Worker secret, BASE_SECRET)");
  }
  const locale = config.locale ?? "ka";
  // The project's own templates where it has them, base's where not, and the code's own last.
  const say: Messages = { ...messagesFrom(locale, config.templates?.[locale]), ...config.messages };
  const db = config.database as SettingsDatabase;
  /** Sends after the answer (waitUntil), and writes the outcome to the log; a failure is said, never thrown. */
  const later = (line: Omit<LogLine, "status" | "error">, send: () => Promise<void>) => {
    const note = (status: LogLine["status"], error?: string) =>
      config.log ? logMessage(db, { ...line, error: error ?? null, status }).catch(() => undefined) : Promise.resolve();
    const sending = send().then(
      () => note("sent"),
      (error: unknown) => {
        (config.onSendError ?? ((w, e) => console.error(JSON.stringify({ error: String(e), message: `base: ${w} not sent` }))))(line.kind, error);
        return note("failed", error instanceof Error ? error.message : String(error));
      },
    );
    if (config.waitUntil) config.waitUntil(sending);
    return config.waitUntil ? Promise.resolve() : sending;
  };
  const letter = (kind: TemplateKind, to: string, purpose?: string) => ({ channel: "email" as const, kind, purpose: purpose ?? null, to });
  // A phone-only account's address is a placeholder: nothing is ever sent to it.
  const send = config.mail;
  const mail: MailSender | undefined = send
    ? (letter) => (isPlaceholderEmail(letter.to) ? Promise.resolve() : send(letter))
    : undefined;
  // A way in is on when the code can do it and the admin has not switched it off.
  const can = capabilitiesOf(config);
  const switches = config.switches ?? ALL_ON;
  const on = (key: keyof Switches) => can[key] && switches[key];
  const signUp = on("signUp");
  const sms = on("phone") ? config.sms : undefined;
  const withPasswords = on("passwords");

  // A security notice, by mail, when the admin left it on and the person has a real address.
  const notices = config.notices ?? NOTICES_DEFAULT;
  const when = () =>
    `${new Date().toLocaleString(locale === "ka" ? "ka-GE" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tbilisi" })} (${locale === "ka" ? "თბილისი" : "Tbilisi"})`;
  const notify: Notify = async (kind, user, agent) => {
    if (!notices[kind] || !mail || isPlaceholderEmail(user.email)) return;
    const values = { app: config.app, device: deviceOf(agent), when: when() };
    const letterOf = kind === "newSignIn" ? say.newSignIn(values) : say[kind](values);
    await later(letter(kind, user.email), () => mail(render(letterOf, user.email)));
  };
  const plugins: BetterAuthPlugin[] = [unisitesBase(notify), admin(), twoFactor({ issuer: config.app, schema: { twoFactor: { modelName: TABLES.twoFactor } } })];
  if (sms) {
    plugins.push(
      phoneNumber({
        allowedAttempts: 3,
        expiresIn: 300,
        otpLength: 6,
        phoneNumberValidator: isE164,
        sendOTP: ({ code, phoneNumber: to }) => later({ channel: "sms", kind: "smsCode", to }, () => sms(to, say.smsCode({ app: config.app, code }))),
        signUpOnVerification:
          !signUp
            ? undefined
            : { getTempEmail: placeholderEmail, getTempName: (phone) => phone },
      }),
    );
  }
  if (mail && on("emailCode")) {
    plugins.push(
      emailOTP({
        allowedAttempts: 3,
        disableSignUp: !signUp,
        expiresIn: 300,
        otpLength: 6,
        sendVerificationOTP: ({ email, otp, type }) =>
          later(letter("emailCode", email, type), () => mail(render(say.emailCode({ app: config.app, code: otp, purpose: type }), email))),
      }),
    );
  }
  if (withPasswords && config.checkLeakedPasswords !== false) plugins.push(haveIBeenPwned());
  if (config.turnstileSecret) {
    plugins.push(captcha({ endpoints: GUARDED, provider: "cloudflare-turnstile", secretKey: config.turnstileSecret }));
  }

  const social: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  if (config.google && on("google")) social.google = { ...config.google, disableSignUp: !signUp, prompt: "select_account" };
  if (config.facebook && on("facebook")) social.facebook = { ...config.facebook, disableSignUp: !signUp };

  return {
    account: { modelName: TABLES.account },
    advanced: {
      // __Host-: Secure, path /, no Domain; the browser refuses the cookie otherwise.
      cookiePrefix: "__Host-base",
      defaultCookieAttributes: { httpOnly: true, path: "/", sameSite: "lax", secure: true },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: false,
    },
    appName: config.app,
    basePath: "/api/auth",
    baseURL: config.baseURL,
    database: config.database,
    emailAndPassword: {
      autoSignIn: true,
      disableSignUp: !signUp,
      enabled: withPasswords,
      password: passwords,
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      // After a reset, every other session ends: whoever had the old password is out.
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user }) => notify("passwordChanged", user),
      sendResetPassword: async ({ url, user }) => {
        if (mail) await later(letter("resetPassword", user.email), () => mail(render(say.resetPassword({ app: config.app, url }), user.email)));
      },
    },
    emailVerification: {
      autoSignInAfterVerification: true,
      sendOnSignUp: true,
      sendVerificationEmail: async ({ url, user }) => {
        if (mail) await later(letter("confirmEmail", user.email), () => mail(render(say.confirmEmail({ app: config.app, url }), user.email)));
      },
    },
    plugins,
    rateLimit: {
      customRules: { ...RATE_RULES },
      enabled: true,
      max: 100,
      modelName: TABLES.rateLimit,
      storage: "database",
      window: 60,
    },
    secret: config.secret,
    session: { expiresIn: 60 * 60 * 24 * 30, modelName: TABLES.session, updateAge: 60 * 60 * 24 },
    socialProviders: social,
    trustedOrigins: config.trustedOrigins,
    user: { modelName: TABLES.user },
    verification: { modelName: TABLES.verification },
  } satisfies BetterAuthOptions;
}

/** How long a Worker keeps the switches before reading them again. */
export const SETTINGS_TTL_MS = 30_000;

type Remembered = { at: number; capabilities: string | null; log: boolean; notices: Notices; switches: Switches; templates: Templates };
let remembered: Remembered | null = null;

/** Forget the switches read before (tests; a Worker forgets them after SETTINGS_TTL_MS). */
export function forgetSettings(): void {
  remembered = null;
}

/**
 * The admin's switches from the project's D1, kept for SETTINGS_TTL_MS, and
 * what the code can do written beside them for the Unisites page. Before the
 * project has base_0002.sql, everything the code can do is on.
 */
async function settingsFor(config: BaseConfig, now = Date.now()): Promise<Pick<Remembered, "log" | "notices" | "switches" | "templates">> {
  if (remembered && now - remembered.at < SETTINGS_TTL_MS) return remembered;
  const db = config.database as SettingsDatabase;
  const empty: Templates = { en: {}, ka: {} };
  try {
    const switches = await readSwitches(db);
    const templates = await readTemplates(db);
    const notices = await readNotices(db);
    const known = remembered?.capabilities ?? (await readCapabilities(db));
    const capabilities = await noteCapabilities(db, capabilitiesOf(config), known);
    // The log once its table is there (base_0003.sql).
    const log = await hasTable(db, "_base_message_log");
    remembered = { at: now, capabilities, log, notices, switches, templates };
  } catch {
    // No _base_settings yet: the code alone decides.
    remembered = { at: now, capabilities: null, log: false, notices: NOTICES_DEFAULT, switches: ALL_ON, templates: empty };
  }
  return remembered;
}

async function hasTable(db: SettingsDatabase, name: string): Promise<boolean> {
  try {
    await run(db, `select 1 from "${name}" limit 1`, [], true);
    return true;
  } catch {
    return false;
  }
}

export function createBase(config: BaseConfig) {
  baseOptions(config); // a wrong secret is said at once, not at the first request
  const make = (settings: Pick<Remembered, "log" | "notices" | "switches" | "templates">) =>
    betterAuth(
      baseOptions({
        ...config,
        log: config.log ?? settings.log,
        notices: config.notices ?? settings.notices,
        switches: config.switches ?? settings.switches,
        templates: config.templates ?? settings.templates,
      }),
    );
  let made: Promise<ReturnType<typeof make>> | null = null;
  const auth = () => (made ??= settingsFor(config).then(make));
  return {
    /** better-auth, with the admin's switches applied. */
    auth,
    /** Answers /api/auth/* (sign-up, sign-in, codes, sessions, Google). */
    handler: async (request: Request) => (await auth()).handler(request),
    /** The person signed in on this request, or null. */
    session: async (request: Request) => (await auth()).api.getSession({ headers: request.headers }),
  };
}
