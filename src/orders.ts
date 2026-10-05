import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint, createAuthMiddleware } from "better-auth/api";

import { localeOf, type Letter, type Locale, type Messages } from "./messages.ts";
import { SIGNATURE_HEADER, verifyOrder, type PlatformOrder } from "./platform.ts";
import type { MailSender } from "./senders.ts";
import { setPasswordPage } from "./set-password.ts";

/**
 * Orders from Unisites (platform.ts): the project's admin invites someone,
 * or sends someone a reset letter, from the "Users" page. The project's
 * Worker writes the user, makes the link and sends the letter through its
 * own sender; Unisites only signs the order.
 *
 * The link is better-auth's own reset link, so the invited person sets
 * their first password the same way anyone sets a new one, on the
 * project's page or base's (set-password.ts). Using it proves the address
 * is theirs: base marks it confirmed.
 */

export const INVITE_DAYS = 7;
const RESET_SECONDS = 60 * 60;

type Deliver = (kind: "invite" | "resetPassword", to: string, letter: Letter) => Promise<void>;

export type OrdersConfig = {
  app: string;
  /** BASE_PLATFORM_KEY; without it there are no orders. */
  key?: string;
  mail?: MailSender;
  /** Passwords are on: an invitation sets one. */
  passwords: boolean;
  /** The project's own page for the link (it gets ?token=…); base's page by default. */
  passwordPage?: string;
  /** Where the person goes once the password is set. */
  signInURL?: string;
  messages: (locale: Locale) => Messages;
  deliver: Deliver;
};

const token = () => [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, "0")).join("");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Requests whose reset link set a person's first password: no "password changed" notice for them. */
export const firstPasswords = new WeakSet<Request>();

export function unisitesOrders(config: OrdersConfig): BetterAuthPlugin {
  return {
    endpoints: {
      unisitesOrder: createAuthEndpoint("/unisites/order", { method: "POST" }, async (ctx) => {
        if (!config.key) throw ctx.error("NOT_FOUND");
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const action = body.action === "invite" || body.action === "reset" ? body.action : null;
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : undefined;
        const locale: Locale | undefined = body.locale === "en" || body.locale === "ka" ? body.locale : undefined;
        if (!action || !EMAIL.test(email) || email.length > 254) throw ctx.error("BAD_REQUEST", { code: "BAD_ORDER", message: "action and email" });
        const order: PlatformOrder = { action, email, ...(name ? { name } : {}), ...(locale ? { locale } : {}) };
        if (!(await verifyOrder(config.key, ctx.request?.headers.get(SIGNATURE_HEADER) ?? null, order))) {
          throw ctx.error("UNAUTHORIZED", { code: "BAD_SIGNATURE", message: "not signed by Unisites" });
        }
        if (!config.mail) throw ctx.error("CONFLICT", { code: "NO_MAIL", message: "the project has no mail sender" });
        if (!config.passwords) throw ctx.error("CONFLICT", { code: "PASSWORDS_OFF", message: "sign-in with a password is off" });

        const found = await ctx.context.internalAdapter.findUserByEmail(email);
        let user = found?.user ?? null;
        if (user && (user as { banned?: boolean | null }).banned) throw ctx.error("CONFLICT", { code: "BANNED", message: "the person is blocked" });
        if (!user && action === "reset") throw ctx.error("NOT_FOUND", { code: "NO_USER", message: "no such person" });
        const created = !user;
        if (!user) user = await ctx.context.internalAdapter.createUser({ email, emailVerified: false, name: name || email.split("@")[0] || email }, { method: "admin" });
        if (!user) throw ctx.error("INTERNAL_SERVER_ERROR");

        const secret = token();
        const seconds = action === "invite" ? INVITE_DAYS * 24 * 60 * 60 : RESET_SECONDS;
        await ctx.context.internalAdapter.createVerificationValue({
          expiresAt: new Date(Date.now() + seconds * 1000),
          identifier: `reset-password:${secret}`,
          value: user.id,
        });
        const page = config.passwordPage ?? `${ctx.context.baseURL}/unisites/set-password`;
        const url = `${ctx.context.baseURL}/reset-password/${secret}?callbackURL=${encodeURIComponent(page)}`;
        const say = config.messages(locale ?? "ka");
        const letter = action === "invite" ? say.invite({ app: config.app, url }) : say.resetPassword({ app: config.app, url });
        try {
          await config.deliver(action === "invite" ? "invite" : "resetPassword", email, letter);
        } catch (error) {
          // The person stays (an invitation can be sent again); the link is useless unsent.
          throw ctx.error("BAD_GATEWAY", { code: "NOT_SENT", message: error instanceof Error ? error.message : String(error) });
        }
        return ctx.json({ created, sent: true, userId: user.id });
      }),

      unisitesSetPassword: createAuthEndpoint("/unisites/set-password", { method: "GET" }, async (ctx) => {
        const request = ctx.request;
        const locale = request ? localeOf(request) : "ka";
        return setPasswordPage({
          app: config.app,
          locale,
          next: config.signInURL ?? new URL(ctx.context.baseURL).origin + "/",
          post: `${new URL(ctx.context.baseURL).pathname}/reset-password`,
        });
      }),
    },
    hooks: {
      before: [
        {
          // A working reset link proves the address: confirm it, and remember a first password.
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as { token?: unknown };
            const given = typeof body.token === "string" ? body.token : (ctx.query as { token?: string } | undefined)?.token;
            if (!given) return;
            const verification = await ctx.context.internalAdapter.findVerificationValue(`reset-password:${given}`);
            if (!verification || verification.expiresAt < new Date()) return;
            const user = await ctx.context.internalAdapter.findUserById(verification.value);
            if (!user) return;
            if (!user.emailVerified) await ctx.context.internalAdapter.updateUser(user.id, { emailVerified: true });
            if (ctx.request && !(await ctx.context.internalAdapter.findCredentialAccount(user.id))) firstPasswords.add(ctx.request);
          }),
          matcher: (ctx) => ctx.path === "/reset-password",
        },
      ],
    },
    id: "unisites-orders",
  } satisfies BetterAuthPlugin;
}
