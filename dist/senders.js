import { smtp } from "./smtp.js";
/** smsoffice.ge (Georgia): the number as 995XXXXXXXXX, the text as is. */
export function smsoffice({ apiKey, fetcher = fetch, sender, }) {
    return async (to, text) => {
        const body = new URLSearchParams({
            content: text,
            destination: to.replace(/\D/g, "").replace(/^(?!995)/, "995"),
            key: apiKey,
            sender,
            urgent: "true",
        });
        const response = await fetcher("https://smsoffice.ge/api/v2/send/", {
            body,
            headers: { "content-type": "application/x-www-form-urlencoded" },
            method: "POST",
            signal: AbortSignal.timeout(10_000),
        });
        const out = (await response.json().catch(() => ({})));
        if (!out.Success)
            throw new Error(`smsoffice: ${out.ErrorCode ?? response.status} ${out.Message ?? ""}`.trim());
    };
}
/** Resend's HTTP API. */
export function resend({ apiKey, fetcher = fetch, from, replyTo, }) {
    return async ({ html, subject, text, to }) => {
        const response = await fetcher("https://api.resend.com/emails", {
            body: JSON.stringify({ from, html, subject, text, to: [to], ...(replyTo ? { reply_to: replyTo } : {}) }),
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            method: "POST",
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok)
            throw new Error(`resend: ${response.status} ${(await response.text()).slice(0, 200)}`);
    };
}
/**
 * Cloudflare Email Service, from the Worker's send_email binding. The binding
 * only sends from the addresses it allows: Unisites gives every app
 * <name>@unisites.ge, so a letter goes out before the project has a sender of
 * its own. `from` may carry a name ("Shop <shop@unisites.ge>").
 */
export function emailService({ binding, from, replyTo, }) {
    const named = /^\s*"?(.*?)"?\s*<([^>]+)>\s*$/.exec(from);
    const sender = named?.[1] ? { email: named[2].trim(), name: named[1].trim() } : (named?.[2] ?? from).trim();
    return async ({ html, subject, text, to }) => {
        await binding.send({ from: sender, html, subject, text, to, ...(replyTo ? { replyTo } : {}) });
    };
}
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
/** The address alone, from "Name <a@b>" or "a@b". */
const addressOf = (from) => from.replace(/^.*<|>.*$/g, "").trim();
/**
 * The mail sender Unisites set up for the project, from its Worker's secrets
 * (ADR 0021, point 5), so the project's code does not change when the sender
 * does: SMTP when SMTP_HOST is set, else Resend when RESEND_API_KEY is, else
 * Cloudflare Email Service from the address Unisites gave the app
 * (UNISITES_MAIL_FROM, <name>@unisites.ge, with its EMAIL binding), else none.
 * The address mail comes from is MAIL_FROM (or EMAIL_FROM). On Unisites'
 * own address, MAIL_FROM still gives the letter its name, and its address
 * takes the replies.
 */
export function mailFromEnv(env) {
    const from = text(env.MAIL_FROM) ?? text(env.EMAIL_FROM);
    const replyTo = text(env.MAIL_REPLY_TO) ?? text(env.EMAIL_REPLY_TO);
    const host = text(env.SMTP_HOST);
    if (from && host) {
        const port = Number(text(env.SMTP_PORT) ?? 465);
        const security = text(env.SMTP_SECURITY) ?? (port === 587 ? "starttls" : "tls");
        const username = text(env.SMTP_USERNAME) ?? addressOf(from);
        const password = text(env.SMTP_PASSWORD);
        if (password)
            return smtp({ from, host, password, port, replyTo, security, username });
    }
    const apiKey = text(env.RESEND_API_KEY);
    if (from && !host && apiKey)
        return resend({ apiKey, from, replyTo });
    const own = text(env.UNISITES_MAIL_FROM);
    const binding = env.EMAIL;
    if (!own || typeof binding?.send !== "function")
        return undefined;
    const name = from ? /^\s*"?(.*?)"?\s*</.exec(from)?.[1]?.trim() : undefined;
    const theirs = from && addressOf(from).toLowerCase() !== addressOf(own).toLowerCase() ? addressOf(from) : undefined;
    return emailService({
        binding,
        from: name ? `${name} <${addressOf(own)}>` : own,
        replyTo: replyTo ?? theirs,
    });
}
