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
/** smsoffice.ge, as multicolor uses it: the number as 995XXXXXXXXX, the text as is. */
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
