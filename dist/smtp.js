export class SmtpError extends Error {
    code;
    constructor(message, code = null) {
        super(message);
        this.code = code;
        this.name = "SmtpError";
    }
}
const encoder = new TextEncoder();
const LINE = /\r\n/;
/** One end of the conversation: replies read line by line, commands written. */
class Wire {
    socket;
    timeoutMs;
    reader;
    writer;
    decoder = new TextDecoder();
    buffer = "";
    constructor(socket, timeoutMs) {
        this.socket = socket;
        this.timeoutMs = timeoutMs;
        this.reader = socket.readable.getReader();
        this.writer = socket.writable.getWriter();
    }
    /** A whole reply: its code, and its text without the codes. */
    async reply() {
        const lines = [];
        for (;;) {
            const line = await this.line();
            const code = Number(line.slice(0, 3));
            if (!/^\d{3}[ -]/.test(line) && line.length !== 3)
                throw new SmtpError(`unexpected answer: ${line.slice(0, 120)}`);
            lines.push(line.slice(4));
            if (line[3] !== "-")
                return { code, lines, text: lines.join(" ") };
        }
    }
    async line() {
        for (;;) {
            const at = this.buffer.search(LINE);
            if (at >= 0) {
                const line = this.buffer.slice(0, at);
                this.buffer = this.buffer.slice(at + 2);
                return line;
            }
            let timer;
            const chunk = await Promise.race([
                this.reader.read(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new SmtpError("the mail server did not answer in time")), this.timeoutMs);
                }),
            ]).finally(() => clearTimeout(timer));
            if (chunk.done)
                throw new SmtpError("the mail server closed the connection");
            this.buffer += this.decoder.decode(chunk.value, { stream: true });
            if (this.buffer.length > 64 * 1024)
                throw new SmtpError("the mail server's answer is too long");
        }
    }
    async send(command) {
        await this.writer.write(encoder.encode(`${command}\r\n`));
    }
    /** A command, and the answer it must get. */
    async expect(command, codes, what) {
        await this.send(command);
        const answer = await this.reply();
        if (!codes.includes(answer.code))
            throw new SmtpError(`${what}: ${answer.code} ${answer.text}`.slice(0, 300), answer.code);
        return answer;
    }
    /** Hands the socket over (to STARTTLS), releasing the streams. */
    release() {
        this.reader.releaseLock();
        this.writer.releaseLock();
        return this.socket;
    }
    async close() {
        try {
            await this.writer.close();
        }
        catch {
            // already closed by the server
        }
        await this.socket.close().catch(() => undefined);
    }
}
const b64 = (text) => {
    let binary = "";
    for (const byte of encoder.encode(text))
        binary += String.fromCharCode(byte);
    return btoa(binary);
};
/** A header value with no way to start another header. */
function header(value) {
    if (/[\r\n]/.test(value))
        throw new SmtpError("a header cannot hold a line break");
    return value;
}
/** RFC 2047: a Georgian subject or name as =?UTF-8?B?…?=. */
function words(text) {
    // eslint-disable-next-line no-control-regex
    return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${b64(text)}?=`;
}
/** "Name <a@b.c>" or "a@b.c": the address, and the header with the name encoded. */
export function mailbox(raw) {
    const value = header(raw.trim());
    const named = /^(.*)<([^<>\s]+@[^<>\s]+)>$/.exec(value);
    const address = named ? (named[2] ?? "") : value;
    if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(address))
        throw new SmtpError(`not an email address: ${address.slice(0, 80)}`);
    const name = named?.[1]?.trim().replace(/^"|"$/g, "") ?? "";
    return { address, header: name ? `${words(name)} <${address}>` : address };
}
const wrap = (text) => b64(text).replace(/.{1,76}/g, (line) => `${line}\r\n`);
/** The whole message, headers and body, as DATA sends it (before dot-stuffing). */
export function message(options, mail, now = new Date()) {
    const from = mailbox(options.from);
    const to = mailbox(mail.to);
    const domain = from.address.split("@")[1] ?? "localhost";
    const boundary = `b${crypto.randomUUID().replace(/-/g, "")}`;
    return [
        `From: ${from.header}`,
        `To: ${to.header}`,
        ...(options.replyTo ? [`Reply-To: ${mailbox(options.replyTo).header}`] : []),
        `Subject: ${words(header(mail.subject))}`,
        `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
        `Message-ID: <${crypto.randomUUID()}@${domain}>`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        wrap(mail.text).trimEnd(),
        `--${boundary}`,
        "Content-Type: text/html; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        wrap(mail.html).trimEnd(),
        `--${boundary}--`,
        "",
    ].join("\r\n");
}
async function defaultConnect() {
    const sockets = (await import("cloudflare:sockets"));
    return sockets.connect;
}
/** Sends one letter: the whole conversation, then QUIT. */
export async function sendSmtp(options, mail) {
    const from = mailbox(options.from);
    const to = mailbox(mail.to);
    const body = message(options, mail);
    const connect = options.connect ?? (await defaultConnect());
    const timeout = options.timeoutMs ?? 15_000;
    const helo = from.address.split("@")[1] ?? "localhost";
    let socket = connect({ hostname: header(options.host), port: options.port }, { allowHalfOpen: false, secureTransport: options.security === "tls" ? "on" : "starttls" });
    let wire = new Wire(socket, timeout);
    try {
        const greeting = await wire.reply();
        if (greeting.code !== 220)
            throw new SmtpError(`the mail server refused: ${greeting.code} ${greeting.text}`, greeting.code);
        let hello = await wire.expect(`EHLO ${helo}`, [250], "EHLO");
        if (options.security === "starttls") {
            if (!hello.lines.some((l) => /^STARTTLS\b/i.test(l)))
                throw new SmtpError("the mail server does not offer STARTTLS on this port");
            await wire.expect("STARTTLS", [220], "STARTTLS");
            socket = wire.release().startTls();
            wire = new Wire(socket, timeout);
            hello = await wire.expect(`EHLO ${helo}`, [250], "EHLO");
        }
        const auth = hello.lines.find((l) => /^AUTH\b/i.test(l))?.toUpperCase() ?? "";
        try {
            if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) {
                await wire.expect(`AUTH PLAIN ${b64(`\u0000${options.username}\u0000${options.password}`)}`, [235], "sign-in");
            }
            else {
                await wire.expect("AUTH LOGIN", [334], "sign-in");
                await wire.expect(b64(options.username), [334], "sign-in");
                await wire.expect(b64(options.password), [235], "sign-in");
            }
        }
        catch (error) {
            // The server's own words, never the command that carried the password.
            if (error instanceof SmtpError)
                throw new SmtpError(`the mail server refused the username or password (${error.code ?? "?"})`, error.code);
            throw error;
        }
        await wire.expect(`MAIL FROM:<${from.address}>`, [250], "MAIL FROM");
        await wire.expect(`RCPT TO:<${to.address}>`, [250, 251], "RCPT TO");
        await wire.expect("DATA", [354], "DATA");
        // Dot-stuffing: a line that starts with "." gets one more.
        await wire.send(`${body.replace(/\r\n\./g, "\r\n..")}\r\n.`);
        const accepted = await wire.reply();
        if (accepted.code !== 250)
            throw new SmtpError(`the mail server did not take the letter: ${accepted.code} ${accepted.text}`.slice(0, 300), accepted.code);
        await wire.send("QUIT").catch(() => undefined);
    }
    finally {
        await wire.close();
    }
}
/** A mail sender for createBase, over the project's own mailbox. */
export function smtp(options) {
    return (mail) => sendSmtp(options, mail);
}
