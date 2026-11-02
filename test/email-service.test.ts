import { describe, expect, it } from "vitest";

import { emailService, mailFromEnv, type EmailBinding } from "../src/senders.ts";

import { project } from "./support/project.ts";

/** Mail through Cloudflare Email Service, from the address Unisites gives every app. */

const LETTER = { html: "<p>კოდი 123456</p>", subject: "Shop: კოდი", text: "კოდი 123456", to: "ana@example.com" };

function binding() {
  const sent: Parameters<EmailBinding["send"]>[0][] = [];
  return { send: async (message: Parameters<EmailBinding["send"]>[0]) => void sent.push(message), sent };
}

describe("Email Service", () => {
  it("sends through the binding, with a name when the address has one", async () => {
    const b = binding();
    await emailService({ binding: b, from: "shop@unisites.ge" })(LETTER);
    await emailService({ binding: b, from: "Shop <shop@unisites.ge>", replyTo: "hi@shop.ge" })(LETTER);
    expect(b.sent).toEqual([
      { ...LETTER, from: "shop@unisites.ge" },
      { ...LETTER, from: { email: "shop@unisites.ge", name: "Shop" }, replyTo: "hi@shop.ge" },
    ]);
  });

  it("is the sender when the project has none of its own", async () => {
    const b = binding();
    await mailFromEnv({ EMAIL: b, UNISITES_MAIL_FROM: "shop@unisites.ge" })?.(LETTER);
    expect(b.sent[0]?.from).toBe("shop@unisites.ge");
  });

  it("keeps MAIL_FROM's name and takes replies at its address, but sends from Unisites' own", async () => {
    const b = binding();
    await mailFromEnv({ EMAIL: b, MAIL_FROM: "Shop <hello@shop.ge>", UNISITES_MAIL_FROM: "shop@unisites.ge" })?.(LETTER);
    expect(b.sent[0]).toMatchObject({ from: { email: "shop@unisites.ge", name: "Shop" }, replyTo: "hello@shop.ge" });
    await mailFromEnv({ EMAIL: b, MAIL_FROM: "Shop <hello@shop.ge>", MAIL_REPLY_TO: "desk@shop.ge", UNISITES_MAIL_FROM: "shop@unisites.ge" })?.(LETTER);
    expect(b.sent[1]?.replyTo).toBe("desk@shop.ge");
  });

  it("gives way to the project's own SMTP or Resend", async () => {
    const b = binding();
    const own = { EMAIL: b, UNISITES_MAIL_FROM: "shop@unisites.ge" };
    const calls: string[] = [];
    const fetcher = (async (url: string) => (calls.push(url), new Response("{}"))) as unknown as typeof fetch;
    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      await mailFromEnv({ ...own, MAIL_FROM: "hello@shop.ge", RESEND_API_KEY: "re_x" })?.(LETTER);
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual(["https://api.resend.com/emails"]);
    expect(b.sent).toEqual([]);
    expect(mailFromEnv({ ...own, MAIL_FROM: "hello@shop.ge", SMTP_HOST: "mail.shop.ge", SMTP_PASSWORD: "x" })).not.toBe(undefined);
  });

  it("is none without the binding or Unisites' address", () => {
    expect(mailFromEnv({ UNISITES_MAIL_FROM: "shop@unisites.ge" })).toBeUndefined();
    expect(mailFromEnv({ EMAIL: binding() })).toBeUndefined();
  });

  it("turns passwords on and delivers a reset letter, with no sender set up", async () => {
    const b = binding();
    const p = project({ mail: mailFromEnv({ EMAIL: b, UNISITES_MAIL_FROM: "shop@unisites.ge" }) });
    await p.call("/sign-up/email", { email: "ana@example.com", name: "Ana", password: "A-good-password-9" });
    p.forget();
    expect((await p.call("/request-password-reset", { email: "ana@example.com", redirectTo: "/" })).response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reset = b.sent.find((m) => m.to === "ana@example.com" && /reset|token=/i.test(m.text));
    expect(reset?.from).toBe("shop@unisites.ge");
    const row = p.db.prepare("select value from _base_settings where key = 'capabilities'").get() as { value: string };
    expect(JSON.parse(row.value).passwords).toBe(true);
  });
});
