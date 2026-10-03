import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { hashPassword } from "better-auth/crypto";
import { admin, captcha, emailOTP, haveIBeenPwned, phoneNumber, twoFactor } from "better-auth/plugins";
import { MESSAGES, render } from "./messages.js";
import { isBcrypt, passwords } from "./passwords.js";
import { isE164, isPlaceholderEmail, placeholderEmail } from "./phone.js";
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
    const sms = config.sms;
    const withPasswords = Boolean(mail) && config.passwords !== false;
    const plugins = [unisitesBase(), admin(), twoFactor({ issuer: config.app, schema: { twoFactor: { modelName: TABLES.twoFactor } } })];
    if (sms) {
        plugins.push(phoneNumber({
            allowedAttempts: 3,
            expiresIn: 300,
            otpLength: 6,
            phoneNumberValidator: isE164,
            sendOTP: ({ code, phoneNumber: to }) => later("sms code", () => sms(to, say.smsCode({ app: config.app, code }))),
            signUpOnVerification: config.signUp === false
                ? undefined
                : { getTempEmail: placeholderEmail, getTempName: (phone) => phone },
        }));
    }
    if (mail) {
        plugins.push(emailOTP({
            allowedAttempts: 3,
            disableSignUp: config.signUp === false,
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
    if (config.google)
        social.google = { ...config.google, prompt: "select_account" };
    if (config.facebook)
        social.facebook = config.facebook;
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
            disableSignUp: config.signUp === false,
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
export function createBase(config) {
    const auth = betterAuth(baseOptions(config));
    return {
        auth,
        /** Answers /api/auth/* (sign-up, sign-in, codes, sessions, Google). */
        handler: (request) => auth.handler(request),
        /** The person signed in on this request, or null. */
        session: (request) => auth.api.getSession({ headers: request.headers }),
    };
}
