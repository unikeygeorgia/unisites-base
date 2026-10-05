import type { BetterAuthPlugin } from "better-auth";
import { type Letter, type Locale, type Messages } from "./messages.ts";
import type { MailSender } from "./senders.ts";
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
export declare const INVITE_DAYS = 7;
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
/** Requests whose reset link set a person's first password: no "password changed" notice for them. */
export declare const firstPasswords: WeakSet<Request<unknown, CfProperties<unknown>>>;
export declare function unisitesOrders(config: OrdersConfig): BetterAuthPlugin;
export {};
