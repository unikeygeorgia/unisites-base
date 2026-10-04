import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { describe, expect, it } from "vitest";

import { deviceOf } from "../src/base.ts";

import { project } from "./support/project.ts";

/** Security notices: a password or a second factor changed, a new device; each with its own switch. */

const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

async function account(p: ReturnType<typeof project>, agent = SAFARI) {
  await p.call("/sign-up/email", { email: "nino@example.com", name: "Nino", password: "A-good-password-9" }, { "user-agent": agent });
  const link = /https:\/\/shop\.test\/api\/auth\/verify-email\?token=[^"\s]+/.exec(p.mail[0]?.text ?? "")?.[0] ?? "";
  await p.call(new URL(link).pathname.replace("/api/auth", "") + new URL(link).search, undefined, { "user-agent": agent });
  p.mail.length = 0;
}

function settings(p: ReturnType<typeof project>, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    p.db.prepare("insert into _base_settings (key, value, updatedAt) values (?, ?, ?)").run(key, value, new Date().toISOString());
  }
}

describe("security notices", () => {
  it("tell a password reset, and every other session ends", async () => {
    const p = project();
    await account(p);
    p.forget();
    await p.call("/request-password-reset", { email: "nino@example.com", redirectTo: "/account" });
    const token = /reset-password\/([^?"\s]+)/.exec(p.mail.at(-1)?.text ?? "")?.[1] ?? "";
    expect(p.db.prepare("select count(*) as n from _base_session").get()).toEqual({ n: 1 });
    expect((await p.call("/reset-password", { newPassword: "Another-good-pass-7", token })).response.status).toBe(200);
    expect(p.mail.at(-1)).toMatchObject({ subject: "Shop: პაროლი შეიცვალა", to: "nino@example.com" });
    expect(p.mail.at(-1)?.text).toMatch(/\(თბილისი\)/);
    expect(p.db.prepare("select count(*) as n from _base_session").get()).toEqual({ n: 0 });
  });

  it("tell the second factor turned off", async () => {
    const p = project();
    await account(p);
    const { totpURI } = (await p.call("/two-factor/enable", { password: "A-good-password-9" })).body as unknown as { totpURI: string };
    const secret = new TextDecoder().decode(base32.decode(new URL(totpURI).searchParams.get("secret") ?? ""));
    await p.call("/two-factor/verify-totp", { code: await createOTP(secret).totp() });
    p.mail.length = 0;
    expect((await p.call("/two-factor/disable", { password: "A-good-password-9" })).response.status).toBe(200);
    expect(p.mail.map((m) => m.subject)).toEqual(["Shop: ორფაქტორიანი დაცვა გამოირთო"]);
  });

  it("tell a new device only when the admin turned that on", async () => {
    const off = project();
    await account(off);
    off.forget();
    await off.call("/sign-in/email", { email: "nino@example.com", password: "A-good-password-9" }, { "user-agent": CHROME });
    expect(off.mail).toEqual([]);

    const on = project();
    settings(on, { "notify.newSignIn": "true" });
    await account(on);
    on.forget();
    await on.call("/sign-in/email", { email: "nino@example.com", password: "A-good-password-9" }, { "user-agent": SAFARI });
    expect(on.mail).toEqual([]);
    on.forget();
    await on.call("/sign-in/email", { email: "nino@example.com", password: "A-good-password-9" }, { "user-agent": CHROME });
    expect(on.mail.map((m) => m.subject)).toEqual(["Shop: შესვლა ახალი მოწყობილობიდან"]);
    expect(on.mail[0]?.text).toContain("Chrome, Windows");
  });

  it("stay quiet when switched off", async () => {
    const p = project();
    settings(p, { "notify.passwordChanged": "false" });
    await account(p);
    p.forget();
    await p.call("/request-password-reset", { email: "nino@example.com", redirectTo: "/account" });
    const token = /reset-password\/([^?"\s]+)/.exec(p.mail.at(-1)?.text ?? "")?.[1] ?? "";
    p.mail.length = 0;
    await p.call("/reset-password", { newPassword: "Another-good-pass-7", token });
    expect(p.mail).toEqual([]);
  });

  it("name a device the way a person would", () => {
    expect(deviceOf(SAFARI)).toBe("Safari, macOS");
    expect(deviceOf(CHROME)).toBe("Chrome, Windows");
    expect(deviceOf(null)).toBe("?");
  });
});
