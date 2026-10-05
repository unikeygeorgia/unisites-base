import { describe, expect, it } from "vitest";

import { platformKeyFor, SIGNATURE_HEADER, signOrder, verifyOrder, type PlatformOrder } from "../src/platform.ts";

import { ORIGIN, project } from "./support/project.ts";

/** Orders from Unisites: an invitation and a reset letter, signed with the project's key. */

const MASTER = "the-platform-master-key-long-enough-0123456789";

async function signed(p: ReturnType<typeof project>, key: string, order: PlatformOrder, now?: number) {
  return p.call("/unisites/order", order, { [SIGNATURE_HEADER]: await signOrder(key, order, now) });
}

function linkIn(text: string | undefined) {
  const url = new URL(/https:\/\/shop\.test\/api\/auth\/reset-password\/[^\s"]+/.exec(text ?? "")?.[0] ?? "https://x/");
  return url.pathname.replace("/api/auth", "") + url.search;
}

describe("signatures", () => {
  it("a project's key signs for that project only, for five minutes", async () => {
    const a = await platformKeyFor(MASTER, "shop");
    const b = await platformKeyFor(MASTER, "other");
    const order: PlatformOrder = { action: "invite", email: "nino@example.com" };
    const header = await signOrder(a, order);
    expect(await verifyOrder(a, header, order)).toBe(true);
    expect(await verifyOrder(b, header, order)).toBe(false);
    expect(await verifyOrder(a, header, { ...order, email: "someone@example.com" })).toBe(false);
    expect(await verifyOrder(a, header, { ...order, action: "reset" })).toBe(false);
    expect(await verifyOrder(a, await signOrder(a, order, Date.now() - 6 * 60_000), order)).toBe(false);
    expect(await verifyOrder(undefined, header, order)).toBe(false);
    await expect(platformKeyFor("short", "shop")).rejects.toThrow(/32/);
  });
});

describe("orders", () => {
  it("are not there without the project's key", async () => {
    const p = project();
    const key = await platformKeyFor(MASTER, "shop");
    expect((await signed(p, key, { action: "invite", email: "nino@example.com" })).response.status).toBe(404);
  });

  it("are refused unsigned, signed with another project's key, or old", async () => {
    const key = await platformKeyFor(MASTER, "shop");
    const p = project({ platformKey: key });
    const order: PlatformOrder = { action: "invite", email: "nino@example.com" };
    expect((await p.call("/unisites/order", order)).response.status).toBe(401);
    expect((await signed(p, await platformKeyFor(MASTER, "other"), order)).response.status).toBe(401);
    expect((await signed(p, key, order, Date.now() - 10 * 60_000)).response.status).toBe(401);
    expect(p.mail).toEqual([]);
    expect(p.db.prepare("select count(*) as n from _base_user").get()).toEqual({ n: 0 });
  });

  it("invite: a new person sets a first password through base's page, and the address is confirmed", async () => {
    const key = await platformKeyFor(MASTER, "shop");
    const p = project({ platformKey: key });
    const answer = await signed(p, key, { action: "invite", email: "Nino@Example.com", locale: "en", name: "Nino" });
    expect(answer.response.status).toBe(200);
    expect(answer.body).toMatchObject({ created: true, sent: true });
    expect(p.mail).toHaveLength(1);
    expect(p.mail[0]).toMatchObject({ subject: "Shop: you are invited", to: "nino@example.com" });
    expect(p.mail[0]?.html).toContain("Accept the invitation");
    expect(p.db.prepare("select name, emailVerified from _base_user").get()).toEqual({ emailVerified: 0, name: "Nino" });

    // The link checks the token and sends the person to base's page with it.
    const open = await p.call(linkIn(p.mail[0]?.text));
    expect(open.response.status).toBe(302);
    const page = new URL(open.response.headers.get("location") ?? "");
    expect(page.origin + page.pathname).toBe(`${ORIGIN}/api/auth/unisites/set-password`);
    const token = page.searchParams.get("token") ?? "";

    const html = await p.base.handler(new Request(page, { headers: { "accept-language": "en" } }));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toMatch(/default-src 'none'; script-src 'nonce-/);
    expect(html.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html.headers.get("cache-control")).toBe("no-store");
    const text = await html.text();
    expect(text).toContain("Set the password");
    expect(text).not.toContain(token);

    p.mail.length = 0;
    expect((await p.call("/reset-password", { newPassword: "A-good-password-9", token })).response.status).toBe(200);
    // A first password changed nothing: no "your password was changed".
    expect(p.mail).toEqual([]);
    expect(p.db.prepare("select emailVerified from _base_user").get()).toEqual({ emailVerified: 1 });
    expect((await p.call("/sign-in/email", { email: "nino@example.com", password: "A-good-password-9" })).response.status).toBe(200);
    // The link works once.
    expect((await p.call("/reset-password", { newPassword: "Another-good-pass-7", token })).response.status).toBe(400);
  });

  it("invite: the link lasts 7 days; a reset letter's 1 hour", async () => {
    const key = await platformKeyFor(MASTER, "shop");
    const p = project({ platformKey: key });
    await signed(p, key, { action: "invite", email: "nino@example.com" });
    await signed(p, key, { action: "reset", email: "nino@example.com" });
    const left = (p.db.prepare("select expiresAt from _base_verification order by expiresAt").all() as { expiresAt: string }[]).map(
      (r) => Math.round((new Date(r.expiresAt).getTime() - Date.now()) / 60_000),
    );
    expect(left).toEqual([60, 7 * 24 * 60]);
    expect(p.mail.map((m) => m.subject)).toEqual(["Shop: მოწვევა", "Shop: ახალი პაროლი"]);
  });

  it("a project's own page gets the link, when it has one", async () => {
    const key = await platformKeyFor(MASTER, "shop");
    const p = project({ passwordPage: `${ORIGIN}/admin/login/?reset=1`, platformKey: key });
    await signed(p, key, { action: "invite", email: "nino@example.com" });
    const open = await p.call(linkIn(p.mail[0]?.text));
    expect(open.response.headers.get("location")).toMatch(/^https:\/\/shop\.test\/admin\/login\/\?reset=1&token=/);
  });

  it("reset: only for someone who is there; an existing person keeps their account; a blocked one gets nothing", async () => {
    const key = await platformKeyFor(MASTER, "shop");
    const p = project({ platformKey: key });
    const none = await signed(p, key, { action: "reset", email: "nobody@example.com" });
    expect(none.response.status).toBe(404);
    expect(none.body).toMatchObject({ code: "NO_USER" });
    expect(p.db.prepare("select count(*) as n from _base_user").get()).toEqual({ n: 0 });

    await signed(p, key, { action: "invite", email: "nino@example.com" });
    const again = await signed(p, key, { action: "invite", email: "nino@example.com" });
    expect(again.body).toMatchObject({ created: false, sent: true });
    expect(p.db.prepare("select count(*) as n from _base_user").get()).toEqual({ n: 1 });

    p.db.prepare("update _base_user set banned = 1").run();
    p.mail.length = 0;
    const blocked = await signed(p, key, { action: "reset", email: "nino@example.com" });
    expect(blocked.response.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: "BANNED" });
    expect(p.mail).toEqual([]);
  });

  it("say when the letter did not go, and log it", async () => {
    const key = await platformKeyFor(MASTER, "shop");
    const p = project({
      mail: async () => {
        throw new Error("535 authentication failed");
      },
      onSendError: () => undefined,
      platformKey: key,
    });
    const answer = await signed(p, key, { action: "invite", email: "nino@example.com" });
    expect(answer.response.status).toBe(502);
    expect(answer.body).toMatchObject({ code: "NOT_SENT", message: "535 authentication failed" });
    expect(p.db.prepare("select kind, status from _base_message_log").all()).toEqual([{ kind: "invite", status: "failed" }]);
  });

  it("need passwords on, and a mail sender", async () => {
    const key = await platformKeyFor(MASTER, "shop");
    const off = project({ platformKey: key }, { switches: { passwords: false } });
    expect((await signed(off, key, { action: "invite", email: "nino@example.com" })).body).toMatchObject({ code: "PASSWORDS_OFF" });
    const noMail = project({ mail: undefined, platformKey: key });
    expect((await signed(noMail, key, { action: "invite", email: "nino@example.com" })).body).toMatchObject({ code: "NO_MAIL" });
  });
});
