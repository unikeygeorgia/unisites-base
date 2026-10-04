import type { Mail, MailSender } from "./senders.ts";
/**
 * Mail over SMTP from a Worker (unisites ADR 0021, point 5): the project's
 * own mailbox (DirectAdmin or cPanel, Zoho, Google Workspace, Unimail's
 * mailboxes) sends its sign-in letters. A Worker opens a TCP socket
 * (cloudflare:sockets); port 25 is closed to Workers, 465 (TLS) and 587
 * (STARTTLS) are not.
 *
 * Small on purpose, so it can be read in full: EHLO, STARTTLS, AUTH PLAIN or
 * LOGIN, MAIL, RCPT, DATA, QUIT, and a UTF-8 multipart message. The password
 * is never in an error or a log.
 */
export type SmtpSecurity = "tls" | "starttls";
export type SmtpOptions = {
    host: string;
    /** 465 with "tls", 587 with "starttls". */
    port: number;
    security: SmtpSecurity;
    username: string;
    password: string;
    /** "Multicolor <no-reply@multicolor.ge>" */
    from: string;
    replyTo?: string;
    /** How long to wait for each answer from the server. */
    timeoutMs?: number;
    /** The socket; cloudflare:sockets' connect by default (the tests give a fake one). */
    connect?: Connect;
};
/** The part of cloudflare:sockets this uses. */
export type SmtpSocket = {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    startTls(): SmtpSocket;
    close(): Promise<void>;
};
export type Connect = (address: {
    hostname: string;
    port: number;
}, options: {
    secureTransport: "on" | "starttls";
    allowHalfOpen: boolean;
}) => SmtpSocket;
export declare class SmtpError extends Error {
    code: number | null;
    constructor(message: string, code?: number | null);
}
/** "Name <a@b.c>" or "a@b.c": the address, and the header with the name encoded. */
export declare function mailbox(raw: string): {
    address: string;
    header: string;
};
/** The whole message, headers and body, as DATA sends it (before dot-stuffing). */
export declare function message(options: {
    from: string;
    replyTo?: string;
}, mail: Mail, now?: Date): string;
/** Sends one letter: the whole conversation, then QUIT. */
export declare function sendSmtp(options: SmtpOptions, mail: Mail): Promise<void>;
/** A mail sender for createBase, over the project's own mailbox. */
export declare function smtp(options: SmtpOptions): MailSender;
