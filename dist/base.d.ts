import { type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { type Locale, type Messages } from "./messages.ts";
import type { MailSender, SmsSender } from "./senders.ts";
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
    google?: {
        clientId: string;
        clientSecret: string;
    };
    /** Kept for later: Meta's app review comes first (ADR 0022). */
    facebook?: {
        clientId: string;
        clientSecret: string;
    };
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
};
/** The table names, as the migration makes them. */
export declare const TABLES: {
    readonly account: "_base_account";
    readonly rateLimit: "_base_rate_limit";
    readonly session: "_base_session";
    readonly signIn: "_base_sign_in";
    readonly twoFactor: "_base_two_factor";
    readonly user: "_base_user";
    readonly verification: "_base_verification";
};
/**
 * Stricter limits where a request costs money or guesses a secret, per IP
 * (window in seconds, requests in it). An SMS is paid for: a script that
 * asks for codes to many numbers ("SMS pumping") must hit a wall fast.
 */
export declare const RATE_RULES: {
    readonly "/email-otp/send-verification-otp": {
        readonly max: 3;
        readonly window: 60;
    };
    readonly "/phone-number/send-otp": {
        readonly max: 3;
        readonly window: 60;
    };
    readonly "/phone-number/verify": {
        readonly max: 10;
        readonly window: 60;
    };
    readonly "/request-password-reset": {
        readonly max: 3;
        readonly window: 60;
    };
    readonly "/sign-in/email": {
        readonly max: 5;
        readonly window: 60;
    };
    readonly "/sign-in/email-otp": {
        readonly max: 10;
        readonly window: 60;
    };
    readonly "/sign-up/email": {
        readonly max: 5;
        readonly window: 60;
    };
};
export declare function baseOptions(config: BaseConfig): {
    account: {
        modelName: "_base_account";
    };
    advanced: {
        cookiePrefix: string;
        defaultCookieAttributes: {
            httpOnly: true;
            path: string;
            sameSite: "lax";
            secure: true;
        };
        ipAddress: {
            ipAddressHeaders: string[];
        };
        useSecureCookies: false;
    };
    appName: string;
    basePath: string;
    baseURL: string;
    database: any;
    emailAndPassword: {
        autoSignIn: true;
        disableSignUp: boolean;
        enabled: boolean;
        password: {
            hash: (password: string) => Promise<string>;
            verify: ({ hash, password }: {
                hash: string;
                password: string;
            }) => Promise<boolean>;
        };
        requireEmailVerification: true;
        resetPasswordTokenExpiresIn: number;
        sendResetPassword: ({ url, user }: {
            user: import("better-auth").User;
            url: string;
            token: string;
        }) => Promise<void>;
    };
    emailVerification: {
        autoSignInAfterVerification: true;
        sendOnSignUp: true;
        sendVerificationEmail: ({ url, user }: {
            user: import("better-auth").User;
            url: string;
            token: string;
        }) => Promise<void>;
    };
    plugins: BetterAuthPlugin[];
    rateLimit: {
        customRules: {
            "/email-otp/send-verification-otp": {
                readonly max: 3;
                readonly window: 60;
            };
            "/phone-number/send-otp": {
                readonly max: 3;
                readonly window: 60;
            };
            "/phone-number/verify": {
                readonly max: 10;
                readonly window: 60;
            };
            "/request-password-reset": {
                readonly max: 3;
                readonly window: 60;
            };
            "/sign-in/email": {
                readonly max: 5;
                readonly window: 60;
            };
            "/sign-in/email-otp": {
                readonly max: 10;
                readonly window: 60;
            };
            "/sign-up/email": {
                readonly max: 5;
                readonly window: 60;
            };
        };
        enabled: true;
        max: number;
        modelName: "_base_rate_limit";
        storage: "database";
        window: number;
    };
    secret: string;
    session: {
        expiresIn: number;
        modelName: "_base_session";
        updateAge: number;
    };
    socialProviders: import("better-auth").SocialProviders;
    trustedOrigins: string[] | undefined;
    user: {
        modelName: "_base_user";
    };
    verification: {
        modelName: "_base_verification";
    };
};
export declare function createBase(config: BaseConfig): {
    auth: import("better-auth").Auth<{
        account: {
            modelName: "_base_account";
        };
        advanced: {
            cookiePrefix: string;
            defaultCookieAttributes: {
                httpOnly: true;
                path: string;
                sameSite: "lax";
                secure: true;
            };
            ipAddress: {
                ipAddressHeaders: string[];
            };
            useSecureCookies: false;
        };
        appName: string;
        basePath: string;
        baseURL: string;
        database: any;
        emailAndPassword: {
            autoSignIn: true;
            disableSignUp: boolean;
            enabled: boolean;
            password: {
                hash: (password: string) => Promise<string>;
                verify: ({ hash, password }: {
                    hash: string;
                    password: string;
                }) => Promise<boolean>;
            };
            requireEmailVerification: true;
            resetPasswordTokenExpiresIn: number;
            sendResetPassword: ({ url, user }: {
                user: import("better-auth").User;
                url: string;
                token: string;
            }) => Promise<void>;
        };
        emailVerification: {
            autoSignInAfterVerification: true;
            sendOnSignUp: true;
            sendVerificationEmail: ({ url, user }: {
                user: import("better-auth").User;
                url: string;
                token: string;
            }) => Promise<void>;
        };
        plugins: BetterAuthPlugin[];
        rateLimit: {
            customRules: {
                "/email-otp/send-verification-otp": {
                    readonly max: 3;
                    readonly window: 60;
                };
                "/phone-number/send-otp": {
                    readonly max: 3;
                    readonly window: 60;
                };
                "/phone-number/verify": {
                    readonly max: 10;
                    readonly window: 60;
                };
                "/request-password-reset": {
                    readonly max: 3;
                    readonly window: 60;
                };
                "/sign-in/email": {
                    readonly max: 5;
                    readonly window: 60;
                };
                "/sign-in/email-otp": {
                    readonly max: 10;
                    readonly window: 60;
                };
                "/sign-up/email": {
                    readonly max: 5;
                    readonly window: 60;
                };
            };
            enabled: true;
            max: number;
            modelName: "_base_rate_limit";
            storage: "database";
            window: number;
        };
        secret: string;
        session: {
            expiresIn: number;
            modelName: "_base_session";
            updateAge: number;
        };
        socialProviders: import("better-auth").SocialProviders;
        trustedOrigins: string[] | undefined;
        user: {
            modelName: "_base_user";
        };
        verification: {
            modelName: "_base_verification";
        };
    }>;
    /** Answers /api/auth/* (sign-up, sign-in, codes, sessions, Google). */
    handler: (request: Request) => Promise<Response>;
    /** The person signed in on this request, or null. */
    session: (request: Request) => Promise<{
        session: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            userId: string;
            expiresAt: Date;
            token: string;
            ipAddress?: string | null | undefined | undefined;
            userAgent?: string | null | undefined | undefined;
        };
        user: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            email: string;
            emailVerified: boolean;
            name: string;
            image?: string | null | undefined | undefined;
        };
    } | null>;
};
