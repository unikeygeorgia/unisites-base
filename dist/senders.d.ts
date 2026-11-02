/**
 * Who delivers a project's SMS and mail. A project passes one of these, or
 * its own function of the same shape; the text is base's (messages.ts) or
 * the project's own.
 */
export type SmsSender = (to: string, text: string) => Promise<void>;
export type Mail = {
    html: string;
    subject: string;
    text: string;
    to: string;
};
export type MailSender = (mail: Mail) => Promise<void>;
/** smsoffice.ge (Georgia): the number as 995XXXXXXXXX, the text as is. */
export declare function smsoffice({ apiKey, fetcher, sender, }: {
    apiKey: string;
    fetcher?: typeof fetch;
    sender: string;
}): SmsSender;
/** Resend's HTTP API. */
export declare function resend({ apiKey, fetcher, from, replyTo, }: {
    apiKey: string;
    fetcher?: typeof fetch;
    from: string;
    replyTo?: string;
}): MailSender;
/** Cloudflare Email Service's binding (send_email), as far as base uses it. */
export type EmailBinding = {
    send(message: {
        from: string | {
            email: string;
            name: string;
        };
        html: string;
        replyTo?: string;
        subject: string;
        text: string;
        to: string;
    }): Promise<unknown>;
};
/**
 * Cloudflare Email Service, from the Worker's send_email binding. The binding
 * only sends from the addresses it allows: Unisites gives every app
 * <name>@unisites.ge, so a letter goes out before the project has a sender of
 * its own. `from` may carry a name ("Shop <shop@unisites.ge>").
 */
export declare function emailService({ binding, from, replyTo, }: {
    binding: EmailBinding;
    from: string;
    replyTo?: string;
}): MailSender;
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
export declare function mailFromEnv(env: Record<string, unknown>): MailSender | undefined;
