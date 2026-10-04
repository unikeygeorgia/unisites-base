import { describe, expect, it } from "vitest";

import { project } from "./support/project.ts";

/** The admin's switches on Unisites' "Sign-in methods" page, read from the project's D1. */

describe("switches", () => {
  it("leave every way the code can do on until the admin says otherwise", async () => {
    const p = project();
    expect((await p.call("/phone-number/send-otp", { phoneNumber: "+995555000400" })).response.status).toBe(200);
  });

  it("close a way in the admin switched off", async () => {
    const p = project({}, { switches: { phone: false } });
    expect((await p.call("/phone-number/send-otp", { phoneNumber: "+995555000401" })).response.status).toBe(404);
    expect(p.sms).toEqual([]);
    expect((await p.call("/sign-up/email", { email: "a@example.com", name: "A", password: "A-good-password-9" })).response.status).toBe(200);
  });

  it("stop new accounts, while people who have one still get in", async () => {
    const p = project({}, { switches: { signUp: false } });
    await p.call("/phone-number/send-otp", { phoneNumber: "+995555000402" });
    expect((await p.call("/phone-number/verify", { code: p.code(), phoneNumber: "+995555000402" })).response.status).not.toBe(200);
    expect((await p.call("/sign-up/email", { email: "b@example.com", name: "B", password: "A-good-password-9" })).response.status).not.toBe(200);
    expect(p.db.prepare("select count(*) as n from _base_user").get()).toEqual({ n: 0 });
  });

  it("cannot turn on what the code cannot do", async () => {
    const p = project({ sms: undefined }, { switches: { phone: true } });
    expect((await p.call("/phone-number/send-otp", { phoneNumber: "+995555000403" })).response.status).toBe(404);
  });

  it("write what the code can do for the Unisites page", async () => {
    const p = project();
    await p.call("/get-session");
    const row = p.db.prepare("select value from _base_settings where key = 'capabilities'").get() as { value: string };
    expect(JSON.parse(row.value)).toEqual({
      emailCode: true,
      facebook: false,
      google: false,
      passwords: true,
      phone: true,
      signUp: true,
    });
  });

  it("work before the project has base_0002.sql: the code alone decides", async () => {
    const p = project({}, { migrations: ["base_0001.sql"] });
    expect((await p.call("/phone-number/send-otp", { phoneNumber: "+995555000404" })).response.status).toBe(200);
  });
});
