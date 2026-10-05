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
const encoder = new TextEncoder();
export const SIGNATURE_HEADER = "x-unisites-signature";
const WINDOW_SECONDS = 300;
async function hmac(key, text) {
    const k = await crypto.subtle.importKey("raw", encoder.encode(key), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signed = new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(text)));
    return [...signed].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** The project's own key, from Unisites' master key and the project's name. */
export async function platformKeyFor(master, project) {
    if (master.length < 32)
        throw new Error("unisites-base: the platform's master key must be at least 32 characters");
    return hmac(master, `unisites-project:${project}`);
}
const canonical = (t, order) => [t, order.action, order.email.trim().toLowerCase(), order.name ?? "", order.locale ?? ""].join("\n");
/** The header Unisites sends with an order. */
export async function signOrder(key, order, now = Date.now()) {
    const t = Math.floor(now / 1000);
    return `t=${t},v1=${await hmac(key, canonical(t, order))}`;
}
/** Whether an order carries Unisites' signature for this project, made in the last five minutes. */
export async function verifyOrder(key, header, order, now = Date.now()) {
    if (!key || !header)
        return false;
    const t = Number(/(?:^|,)t=(\d+)/.exec(header)?.[1]);
    const given = /(?:^|,)v1=([0-9a-f]{64})/.exec(header)?.[1];
    if (!Number.isFinite(t) || !given || Math.abs(now / 1000 - t) > WINDOW_SECONDS)
        return false;
    const expected = await hmac(key, canonical(t, order));
    let diff = 0;
    for (let i = 0; i < expected.length; i++)
        diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
    return diff === 0;
}
