/**
 * Unisites asking a project to act for one of its people (an invitation, a
 * reset letter), without holding the project's mail keys (ADR 0021): the
 * project's Worker sends the letter itself, and takes the order only when
 * Unisites signed it.
 *
 * Unisites keeps one master key; each project's key is HMAC(master, project)
 * and sits on the project's Worker as the secret BASE_PLATFORM_KEY, so
 * Unisites can sign for any project and no project can sign for another.
 * A signature covers the time, the action and its fields, and is good for
 * five minutes.
 *
 * Web Crypto only: the same code runs in the project's Worker and in
 * Unisites' (unisites-base/platform), with no better-auth.
 */
export declare const SIGNATURE_HEADER = "x-unisites-signature";
/** The project's own key, from Unisites' master key and the project's name. */
export declare function platformKeyFor(master: string, project: string): Promise<string>;
export type PlatformOrder = {
    action: "invite" | "reset";
    email: string;
    locale?: "ka" | "en";
    name?: string;
};
/** The header Unisites sends with an order. */
export declare function signOrder(key: string, order: PlatformOrder, now?: number): Promise<string>;
/** Whether an order carries Unisites' signature for this project, made in the last five minutes. */
export declare function verifyOrder(key: string | undefined, header: string | null, order: PlatformOrder, now?: number): Promise<boolean>;
