import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { hashPassword } from "better-auth/crypto";
import { admin, captcha, emailOTP, haveIBeenPwned, phoneNumber, twoFactor } from "better-auth/plugins";
import { MESSAGES, render } from "./messages.js";
import { isBcrypt, passwords } from "./passwords.js";
import { isE164, isPlaceholderEmail, placeholderEmail } from "./phone.js";
import { ALL_ON, noteCapabilities, readCapabilities, readSwitches } from "./settings.js";
/** What the code lets this project do, before the admin's switches. */
export function capabilitiesOf(config) {
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
};
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
};
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
function unisitesBase() {
    return {
        hooks: {
            after: [
                {
                    handler: createAuthMiddleware(async (ctx) => {
                        const userId = ctx.context.newSession?.user.id;
                        const password = ctx.body?.password;
                        if (!userId || typeof password !== "string")
                            return;
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
                                if (!ctx)
                                    return;
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
    };
}
export function baseOptions(config) {
    if (!config.secret || config.secret.length < 32) {
        throw new Error("unisites-base: the secret must be at least 32 characters (a Worker secret, BASE_SECRET)");
    }
    const locale = config.locale ?? "ka";
    const say = { ...MESSAGES[locale], ...config.messages };
    const later = (what, send) => {
        const sending = send().catch((error) => (config.onSendError ?? ((w, e) => console.error(JSON.stringify({ error: String(e), message: `base: ${w} not sent` }))))(what, error));
        if (config.waitUntil)
            config.waitUntil(sending);
        return config.waitUntil ? Promise.resolve() : sending;
    };
    // A phone-only account's address is a placeholder: nothing is ever sent to it.
    const send = config.mail;
    const mail = send
        ? (letter) => (isPlaceholderEmail(letter.to) ? Promise.resolve() : send(letter))
        : undefined;
    // A way in is on when the code can do it and the admin has not switched it off.
    const can = capabilitiesOf(config);
    const switches = config.switches ?? ALL_ON;
    const on = (key) => can[key] && switches[key];
    const signUp = on("signUp");
    const sms = on("phone") ? config.sms : undefined;
    const withPasswords = on("passwords");
    const plugins = [unisitesBase(), admin(), twoFactor({ issuer: config.app, schema: { twoFactor: { modelName: TABLES.twoFactor } } })];
    if (sms) {
        plugins.push(phoneNumber({
            allowedAttempts: 3,
            expiresIn: 300,
            otpLength: 6,
            phoneNumberValidator: isE164,
            sendOTP: ({ code, phoneNumber: to }) => later("sms code", () => sms(to, say.smsCode({ app: config.app, code }))),
            signUpOnVerification: !signUp
                ? undefined
                : { getTempEmail: placeholderEmail, getTempName: (phone) => phone },
        }));
    }
    if (mail && on("emailCode")) {
        plugins.push(emailOTP({
            allowedAttempts: 3,
            disableSignUp: !signUp,
            expiresIn: 300,
            otpLength: 6,
            sendVerificationOTP: ({ email, otp, type }) => later("email code", () => mail(render(say.emailCode({ app: config.app, code: otp, purpose: type }), email))),
        }));
    }
    if (withPasswords && config.checkLeakedPasswords !== false)
        plugins.push(haveIBeenPwned());
    if (config.turnstileSecret) {
        plugins.push(captcha({ endpoints: GUARDED, provider: "cloudflare-turnstile", secretKey: config.turnstileSecret }));
    }
    const social = {};
    if (config.google && on("google"))
        social.google = { ...config.google, disableSignUp: !signUp, prompt: "select_account" };
    if (config.facebook && on("facebook"))
        social.facebook = { ...config.facebook, disableSignUp: !signUp };
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
            sendResetPassword: async ({ url, user }) => {
                if (mail)
                    await later("password reset", () => mail(render(say.resetPassword({ app: config.app, url }), user.email)));
            },
        },
        emailVerification: {
            autoSignInAfterVerification: true,
            sendOnSignUp: true,
            sendVerificationEmail: async ({ url, user }) => {
                if (mail)
                    await later("email confirmation", () => mail(render(say.confirmEmail({ app: config.app, url }), user.email)));
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
    };
}
/** How long a Worker keeps the switches before reading them again. */
export const SETTINGS_TTL_MS = 30_000;
let remembered = null;
/** Forget the switches read before (tests; a Worker forgets them after SETTINGS_TTL_MS). */
export function forgetSettings() {
    remembered = null;
}
/**
 * The admin's switches from the project's D1, kept for SETTINGS_TTL_MS, and
 * what the code can do written beside them for the Unisites page. Before the
 * project has base_0002.sql, everything the code can do is on.
 */
async function switchesFor(config, now = Date.now()) {
    if (config.switches)
        return config.switches;
    if (remembered && now - remembered.at < SETTINGS_TTL_MS)
        return remembered.switches;
    const db = config.database;
    try {
        const switches = await readSwitches(db);
        const known = remembered?.capabilities ?? (await readCapabilities(db));
        const capabilities = await noteCapabilities(db, capabilitiesOf(config), known);
        remembered = { at: now, capabilities, switches };
        return switches;
    }
    catch {
        // No _base_settings yet: the code alone decides.
        remembered = { at: now, capabilities: null, switches: ALL_ON };
        return ALL_ON;
    }
}
export function createBase(config) {
    baseOptions(config); // a wrong secret is said at once, not at the first request
    const make = (switches) => betterAuth(baseOptions({ ...config, switches }));
    let made = null;
    const auth = () => (made ??= switchesFor(config).then(make));
    return {
        /** better-auth, with the admin's switches applied. */
        auth,
        /** Answers /api/auth/* (sign-up, sign-in, codes, sessions, Google). */
        handler: async (request) => (await auth()).handler(request),
        /** The person signed in on this request, or null. */
        session: async (request) => (await auth()).api.getSession({ headers: request.headers }),
    };
}
