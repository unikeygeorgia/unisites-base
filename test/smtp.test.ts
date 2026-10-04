import { describe, expect, it } from "vitest";

import { mailFromEnv } from "../src/senders.ts";
import { mailbox, message, sendSmtp, SmtpError } from "../src/smtp.ts";

import { smtpServer } from "./support/smtp-server.ts";

/** Mail over SMTP, as a project's own mailbox sends it. */

const LETTER = { html: "<p>შენი კოდია 123456</p>", subject: "Shop: კოდი 123456", text: "შენი კოდია 123456\n.dot line", to: "ana@example.com" };
const BASE = { from: "Shop <no-reply@shop.test>", host: "mail.shop.test", password: "secret-pass", username: "no-reply@shop.test" };

describe("SMTP", () => {
  it("sends over TLS on 465: greet, EHLO, AUTH, MAIL, RCPT, DATA, QUIT", async () => {
    const server = smtpServer();
    await sendSmtp({ ...BASE, connect: server.connect, port: 465, security: "tls" }, LETTER);
    expect(server.connected).toEqual({ hostname: "mail.shop.test", port: 465, secureTransport: "on" });
    expect(server.commands).toEqual([
      "EHLO shop.test",
      "AUTH PLAIN ***",
      "MAIL FROM:<no-reply@shop.test>",
      "RCPT TO:<ana@example.com>",
      "DATA",
      "QUIT",
    ]);
    expect(server.messages).toHaveLength(1);
    const sent = server.messages[0] ?? "";
    expect(sent).toContain("From: Shop <no-reply@shop.test>");
    expect(sent).toContain(`Subject: =?UTF-8?B?${Buffer.from("Shop: კოდი 123456").toString("base64")}?=`);
    const text = /charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/.exec(sent)?.[1] ?? "";
    expect(Buffer.from(text.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe(LETTER.text);
  });

  it("upgrades with STARTTLS on 587 and signs in after it, with LOGIN when that is all there is", async () => {
    const server = smtpServer({ auth: "LOGIN" });
    await sendSmtp({ ...BASE, connect: server.connect, port: 587, security: "starttls" }, LETTER);
    expect(server.connected?.secureTransport).toBe("starttls");
    expect(server.tls).toBe(true);
    expect(server.commands.slice(0, 6)).toEqual(["EHLO shop.test", "STARTTLS", "EHLO shop.test", "AUTH LOGIN", "bm8tcmVwbHlAc2hvcC50ZXN0", "***"]);
  });

  it("says a wrong password plainly, and never repeats it", async () => {
    const server = smtpServer();
    const error = await sendSmtp({ ...BASE, connect: server.connect, password: "wrong", port: 465, security: "tls" }, LETTER).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmtpError);
    expect(String((error as Error).message)).toBe("the mail server refused the username or password (535)");
    expect(String((error as Error).message)).not.toContain("wrong");
    expect(server.messages).toEqual([]);
  });

  it("refuses STARTTLS where the server does not offer it, rather than sign in in the clear", async () => {
    const server = smtpServer({ starttls: false });
    await expect(sendSmtp({ ...BASE, connect: server.connect, port: 587, security: "starttls" }, LETTER)).rejects.toThrow(/does not offer STARTTLS/);
    expect(server.commands).not.toContain("AUTH PLAIN ***");
  });

  it("keeps a header to one line, and an address an address", () => {
    expect(() => message(BASE, { ...LETTER, subject: "hi\r\nBcc: all@x.test" })).toThrow(/line break/);
    expect(() => mailbox("not an address")).toThrow(/not an email address/);
    expect(mailbox('"მულტიკოლორი" <no-reply@shop.test>').header).toBe(`=?UTF-8?B?${Buffer.from("მულტიკოლორი").toString("base64")}?= <no-reply@shop.test>`);
  });
});

describe("the sender from the Worker's secrets", () => {
  it("is SMTP when SMTP_HOST is set, Resend when only its key is, else none", () => {
    expect(mailFromEnv({ MAIL_FROM: "a@b.test", SMTP_HOST: "mail.b.test", SMTP_PASSWORD: "x" })).toBeTypeOf("function");
    expect(mailFromEnv({ EMAIL_FROM: "a@b.test", RESEND_API_KEY: "re_x" })).toBeTypeOf("function");
    expect(mailFromEnv({ SMTP_HOST: "mail.b.test", SMTP_PASSWORD: "x" })).toBeUndefined();
    expect(mailFromEnv({ MAIL_FROM: "a@b.test", SMTP_HOST: "mail.b.test" })).toBeUndefined();
  });
});
