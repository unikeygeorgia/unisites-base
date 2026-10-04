import type { Connect, SmtpSocket } from "../../src/smtp.ts";

/**
 * A mail server for the tests, over in-memory streams: it greets, answers
 * EHLO with its capabilities, takes STARTTLS (a new socket, as a TLS upgrade
 * gives), checks AUTH PLAIN or LOGIN against one username and password, and
 * keeps every command and the message DATA carried.
 */
export function smtpServer({
  auth = "PLAIN LOGIN",
  password = "secret-pass",
  starttls = true,
  username = "no-reply@shop.test",
}: { auth?: string; password?: string; starttls?: boolean; username?: string } = {}) {
  const commands: string[] = [];
  const messages: string[] = [];
  let connected: { hostname: string; port: number; secureTransport: string } | null = null;
  let tls = false;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const b64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

  function socket(greet: boolean): SmtpSocket {
    let push: (text: string) => void = () => undefined;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(encoder.encode(text));
        if (greet) push("220 shop.test ESMTP ready\r\n");
      },
    });
    let buffer = "";
    let data: string | null = null;
    let login: "user" | "pass" | null = null;
    let user = "";
    const answer = (line: string) => {
      if (data !== null) {
        if (line === ".") {
          messages.push(data);
          data = null;
          push("250 2.0.0 queued as 42\r\n");
        } else data += `${line}\r\n`;
        return;
      }
      commands.push(line.startsWith("AUTH PLAIN") ? "AUTH PLAIN ***" : login === "pass" ? "***" : line);
      if (login === "user") {
        user = b64(line);
        login = "pass";
        return push("334 UGFzc3dvcmQ6\r\n");
      }
      if (login === "pass") {
        login = null;
        return push(user === username && b64(line) === password ? "235 2.7.0 ok\r\n" : "535 5.7.8 authentication failed\r\n");
      }
      if (line.startsWith("EHLO")) {
        const caps = [`250-shop.test`, ...(starttls && !tls ? ["250-STARTTLS"] : []), `250-AUTH ${auth}`, "250 8BITMIME"];
        return push(`${caps.join("\r\n")}\r\n`);
      }
      if (line === "STARTTLS") {
        push("220 2.0.0 go ahead\r\n");
        return;
      }
      if (line.startsWith("AUTH PLAIN ")) {
        const [, u, p] = b64(line.slice(11)).split("\u0000");
        return push(u === username && p === password ? "235 2.7.0 ok\r\n" : "535 5.7.8 authentication failed\r\n");
      }
      if (line === "AUTH LOGIN") {
        login = "user";
        return push("334 VXNlcm5hbWU6\r\n");
      }
      if (line.startsWith("MAIL FROM:")) return push("250 2.1.0 ok\r\n");
      if (line.startsWith("RCPT TO:")) return push("250 2.1.5 ok\r\n");
      if (line === "DATA") {
        data = "";
        return push("354 end with .\r\n");
      }
      if (line === "QUIT") return push("221 bye\r\n");
      push("502 not here\r\n");
    };
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        buffer += decoder.decode(chunk);
        let at;
        while ((at = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          answer(line);
        }
      },
    });
    return {
      close: async () => undefined,
      readable,
      startTls: () => {
        tls = true;
        return socket(false);
      },
      writable,
    };
  }

  const connect: Connect = (address, options) => {
    connected = { ...address, secureTransport: options.secureTransport };
    tls = options.secureTransport === "on";
    return socket(true);
  };
  return { commands, connect, get connected() { return connected; }, messages, get tls() { return tls; } };
}
