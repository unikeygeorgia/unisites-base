import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";

import { project } from "./support/project.ts";

describe("phone and SMS code", () => {
  it("makes the account on the first code, with a __Host- cookie, and writes the sign-in down", async () => {
    const p = project();
    expect((await p.call("/phone-number/send-otp", { phoneNumber: "+995555000001" })).response.status).toBe(200);
    expect(p.sms).toEqual([{ text: expect.stringMatching(/^Shop: შენი კოდია \d{6}\. მოქმედებს 5 წუთი\.$/), to: "+995555000001" }]);

    const verified = await p.call("/phone-number/verify", { code: p.code(), phoneNumber: "+995555000001" });
    expect(verified.response.status).toBe(200);
    const cookie = verified.set.find((c) => c.startsWith("__Host-base.session_token="));
    expect(cookie).toMatch(/; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    expect(cookie).not.toMatch(/Domain=/i);

    const session = await p.call("/get-session");
    expect(session.body?.user).toMatchObject({ phoneNumber: "+995555000001", phoneNumberVerified: true });
    expect(p.db.prepare("select method, ip from _base_sign_in").all()).toEqual([
      { ip: "203.0.113.7", method: "/phone-number/verify" },
    ]);
  });

  it("speaks English to an English browser", async () => {
    const p = project({ locale: "en" });
    await p.call("/phone-number/send-otp", { phoneNumber: "+995555000002" });
    expect(p.sms[0].text).toMatch(/^Shop: your code is \d{6}\. It works for 5 minutes\.$/);
  });

  it("refuses a wrong code, and a number that is not E.164", async () => {
    const p = project();
    await p.call("/phone-number/send-otp", { phoneNumber: "+995555000003" });
    expect((await p.call("/phone-number/verify", { code: "000000", phoneNumber: "+995555000003" })).response.status).toBe(400);
    expect((await p.call("/phone-number/send-otp", { phoneNumber: "555 00 00 04" })).response.status).toBe(400);
  });

  it("makes no account from a code when sign-up is off", async () => {
    const p = project({ signUp: false });
    await p.call("/phone-number/send-otp", { phoneNumber: "+995555000005" });
    const answer = await p.call("/phone-number/verify", { code: p.code(), phoneNumber: "+995555000005" });
    expect(answer.response.status).not.toBe(200);
    expect(p.db.prepare("select count(*) as n from _base_user").get()).toEqual({ n: 0 });
  });
});

describe("a password from Supabase (bcrypt)", () => {
  function imported() {
    const p = project();
    const now = new Date().toISOString();
    p.db.prepare(`insert into _base_user (id, name, email, emailVerified, createdAt, updatedAt) values ('u1', 'Ana', 'ana@example.com', 1, ?, ?)`).run(now, now);
    p.db
      .prepare(`insert into _base_account (id, accountId, providerId, userId, password, createdAt, updatedAt) values ('a1', 'u1', 'credential', 'u1', ?, ?, ?)`)
      .run(bcrypt.hashSync("Old-password-1", 4), now, now);
    return p;
  }

  it("signs in, and is written again as scrypt", async () => {
    const p = imported();
    expect((await p.call("/sign-in/email", { email: "ana@example.com", password: "Old-password-1" })).response.status).toBe(200);
    const { password } = p.db.prepare("select password from _base_account where id = 'a1'").get() as { password: string };
    expect(password).not.toMatch(/^\$2/);
    p.forget();
    expect((await p.call("/sign-in/email", { email: "ana@example.com", password: "Old-password-1" })).response.status).toBe(200);
  });

  it("refuses a wrong password, and keeps the old hash", async () => {
    const p = imported();
    expect((await p.call("/sign-in/email", { email: "ana@example.com", password: "nope-nope-1" })).response.status).toBe(401);
    const { password } = p.db.prepare("select password from _base_account where id = 'a1'").get() as { password: string };
    expect(password).toMatch(/^\$2/);
  });
});

describe("email and password", () => {
  it("confirms the address by mail before the first sign-in", async () => {
    const p = project();
    expect((await p.call("/sign-up/email", { email: "gio@example.com", name: "Gio", password: "A-good-password-9" })).response.status).toBe(200);
    expect(p.mail[0]).toMatchObject({ subject: "Shop: ელფოსტის დადასტურება", to: "gio@example.com" });
    const link = /https:\/\/shop\.test\/api\/auth\/verify-email\?token=[^"\s&]+[^"\s]*/.exec(p.mail[0].text)?.[0];
    expect(link).toBeTruthy();

    p.forget();
    expect((await p.call("/sign-in/email", { email: "gio@example.com", password: "A-good-password-9" })).response.status).toBe(403);
    await p.call(new URL(link!).pathname.replace("/api/auth", "") + new URL(link!).search);
    p.forget();
    expect((await p.call("/sign-in/email", { email: "gio@example.com", password: "A-good-password-9" })).response.status).toBe(200);
  });

  it("is off without a mail sender, so a phone-only project has no passwords", async () => {
    const p = project({ mail: undefined });
    expect((await p.call("/sign-up/email", { email: "x@example.com", name: "X", password: "A-good-password-9" })).response.status).not.toBe(200);
  });
});

describe("Unisites' Users page, through D1", () => {
  it("blocks with banned = 1 and signs out by deleting sessions", async () => {
    const p = project();
    await p.call("/phone-number/send-otp", { phoneNumber: "+995555000010" });
    await p.call("/phone-number/verify", { code: p.code(), phoneNumber: "+995555000010" });
    expect((await p.call("/get-session")).body).not.toBeNull();

    p.db.prepare("delete from _base_session").run();
    expect((await p.call("/get-session")).body).toBeNull();

    p.db.prepare("update _base_user set banned = 1").run();
    await p.call("/phone-number/send-otp", { phoneNumber: "+995555000010" });
    expect((await p.call("/phone-number/verify", { code: p.code(), phoneNumber: "+995555000010" })).response.status).toBe(403);
  });
});

describe("Turnstile", () => {
  it("guards the ways in when its secret is set", async () => {
    const p = project({ turnstileSecret: "1x0000000000000000000000000000000AA" });
    expect((await p.call("/phone-number/send-otp", { phoneNumber: "+995555000020" })).response.status).toBe(400);
    expect(p.sms).toEqual([]);
  });
});
