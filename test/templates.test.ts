import { describe, expect, it } from "vitest";

import { messagesFrom, templateProblems, TEMPLATES } from "../src/messages.ts";

import { project } from "./support/project.ts";

/** The admin's own texts, from the project's D1, and the log of what was sent. */

function saveTemplate(p: ReturnType<typeof project>, key: string, value: unknown) {
  p.db.prepare("insert into _base_settings (key, value, updatedAt) values (?, ?, ?)").run(key, JSON.stringify(value), new Date().toISOString());
}

describe("templates", () => {
  it("say what is wrong: a variable that is not there, one that must be, an empty text", () => {
    expect(templateProblems("smsCode", { body: "{{app}}: {{code}}" })).toEqual([]);
    expect(templateProblems("smsCode", { body: "{{app}} hello" })).toEqual(["{{code}} is missing"]);
    expect(templateProblems("confirmEmail", { body: "{{url}} {{code}}", button: "Go", subject: "S" })).toEqual([
      "{{url}} is not a variable here",
      "{{code}} is not a variable here",
    ]);
    expect(templateProblems("resetPassword", { body: "x", subject: "S" })).toEqual(["the button is empty"]);
    for (const locale of ["ka", "en"] as const) {
      for (const [kind, template] of Object.entries(TEMPLATES[locale])) {
        expect(templateProblems(kind as keyof typeof TEMPLATES.ka, template)).toEqual([]);
      }
    }
  });

  it("fill their variables, and fall back to base's text when one is broken", () => {
    const own = messagesFrom("ka", { smsCode: { body: "{{app}} — კოდი {{code}}" } });
    expect(own.smsCode({ app: "Shop", code: "123456" })).toBe("Shop — კოდი 123456");
    const broken = messagesFrom("ka", { smsCode: { body: "no code here" } });
    expect(broken.smsCode({ app: "Shop", code: "123456" })).toBe("Shop: შენი კოდია 123456. მოქმედებს 5 წუთი.");
    expect(messagesFrom("en").emailCode({ app: "Shop", code: "1", purpose: "forget-password" }).body).toMatch(/^Your code for a new password: 1/);
  });

  it("are the project's own when saved on Unisites", async () => {
    const p = project();
    saveTemplate(p, "template.smsCode.ka", { body: "{{app}} — კოდი {{code}}" });
    await p.call("/phone-number/send-otp", { phoneNumber: "+995555000600" });
    expect(p.sms[0]?.text).toMatch(/^Shop — კოდი \d{6}$/);
  });
});

describe("the log", () => {
  it("keeps who got which message and that it went, never the code", async () => {
    const p = project();
    await p.call("/phone-number/send-otp", { phoneNumber: "+995555000601" });
    await p.call("/sign-up/email", { email: "log@example.com", name: "L", password: "A-good-password-9" });
    const rows = p.db.prepare(`select channel, kind, purpose, "to", status, error from _base_message_log order by id`).all();
    expect(rows).toEqual([
      { channel: "sms", error: null, kind: "smsCode", purpose: null, status: "sent", to: "+995555000601" },
      { channel: "email", error: null, kind: "confirmEmail", purpose: null, status: "sent", to: "log@example.com" },
    ]);
    expect(JSON.stringify(p.db.prepare("select * from _base_message_log").all())).not.toMatch(new RegExp(p.code()));
  });

  it("keeps a failure with its reason", async () => {
    const p = project({ onSendError: () => undefined, sms: async () => { throw new Error("smsoffice: 20 no balance"); } });
    await p.call("/phone-number/send-otp", { phoneNumber: "+995555000602" });
    expect(p.db.prepare(`select status, error from _base_message_log`).all()).toEqual([{ error: "smsoffice: 20 no balance", status: "failed" }]);
  });

  it("is off before the project has base_0003.sql, and sending still works", async () => {
    const p = project({}, { migrations: ["base_0001.sql", "base_0002.sql"] });
    expect((await p.call("/phone-number/send-otp", { phoneNumber: "+995555000603" })).response.status).toBe(200);
    expect(p.sms).toHaveLength(1);
  });
});
