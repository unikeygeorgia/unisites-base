import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { describe, expect, it } from "vitest";

import { project } from "./support/project.ts";

/** A second factor (TOTP), as a project's admins turn it on and sign in with it. */

async function signedUp(p: ReturnType<typeof project>) {
  await p.call("/sign-up/email", { email: "admin@example.com", name: "Admin", password: "A-good-password-9" });
  const link = /https:\/\/shop\.test\/api\/auth\/verify-email\?token=[^"\s]+/.exec(p.mail[0]?.text ?? "")?.[0] ?? "";
  await p.call(new URL(link).pathname.replace("/api/auth", "") + new URL(link).search);
  p.forget();
  expect((await p.call("/sign-in/email", { email: "admin@example.com", password: "A-good-password-9" })).response.status).toBe(200);
}

/** The secret as an authenticator app reads it from the QR (base32), back to what TOTP signs with. */
const secretOf = (uri: string) => new TextDecoder().decode(base32.decode(new URL(uri).searchParams.get("secret") ?? ""));

describe("two-factor", () => {
  it("is turned on with the password and a first code, and gives backup codes", async () => {
    const p = project();
    await signedUp(p);
    const enabled = await p.call("/two-factor/enable", { password: "A-good-password-9" });
    expect(enabled.response.status).toBe(200);
    const { backupCodes, totpURI } = enabled.body as unknown as { backupCodes: string[]; totpURI: string };
    expect(totpURI).toMatch(/^otpauth:\/\/totp\/Shop:admin%40example\.com\?/);
    expect(backupCodes.length).toBeGreaterThanOrEqual(8);
    expect(p.db.prepare("select twoFactorEnabled from _base_user").get()).toEqual({ twoFactorEnabled: 0 });

    const code = await createOTP(secretOf(totpURI)).totp();
    expect((await p.call("/two-factor/verify-totp", { code })).response.status).toBe(200);
    expect(p.db.prepare("select twoFactorEnabled from _base_user").get()).toEqual({ twoFactorEnabled: 1 });
  });

  it("then asks for a code after the password, and a session only comes with it", async () => {
    const p = project();
    await signedUp(p);
    const { totpURI } = (await p.call("/two-factor/enable", { password: "A-good-password-9" })).body as unknown as { totpURI: string };
    await p.call("/two-factor/verify-totp", { code: await createOTP(secretOf(totpURI)).totp() });
    p.forget();
    p.db.prepare("delete from _base_session").run();

    const first = await p.call("/sign-in/email", { email: "admin@example.com", password: "A-good-password-9" });
    expect(first.body).toMatchObject({ twoFactorRedirect: true });
    expect(first.set.find((c) => c.startsWith("__Host-base.session_token=") && !c.includes("Max-Age=0"))).toBeUndefined();
    expect(first.set.some((c) => c.startsWith("__Host-base.two_factor="))).toBe(true);
    expect(p.db.prepare("select count(*) as n from _base_session").get()).toEqual({ n: 0 });

    // the jar sends the two_factor cookie with the next request, as a browser does
    const wrong = await p.call("/two-factor/verify-totp", { code: "000000" });
    expect(wrong.response.status).not.toBe(200);
    const right = await p.call("/two-factor/verify-totp", { code: await createOTP(secretOf(totpURI)).totp() });
    expect(right.response.status).toBe(200);
    expect(right.set.some((c) => c.startsWith("__Host-base.session_token="))).toBe(true);
  });
});
