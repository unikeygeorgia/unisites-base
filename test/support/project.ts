import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { createBase, forgetSettings, type BaseConfig } from "../../src/base.ts";
import type { Mail } from "../../src/senders.ts";

export const ORIGIN = "https://shop.test";

/** A project as a Worker has it: an empty D1 with base's migration, and senders that keep what they send. */
export function project(
  config: Partial<BaseConfig> = {},
  { migrations = ["base_0001.sql", "base_0002.sql"], switches = {} }: { migrations?: string[]; switches?: Record<string, boolean> } = {},
) {
  forgetSettings();
  const db = new DatabaseSync(":memory:");
  for (const file of migrations) db.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  for (const [key, value] of Object.entries(switches)) {
    db.prepare("insert into _base_settings (key, value, updatedAt) values (?, ?, ?)").run(`switch.${key}`, String(value), new Date().toISOString());
  }
  const sms: { text: string; to: string }[] = [];
  const mail: Mail[] = [];
  const base = createBase({
    app: "Shop",
    baseURL: ORIGIN,
    checkLeakedPasswords: false,
    database: db,
    mail: async (m) => void mail.push(m),
    secret: "a-test-secret-that-is-long-enough-123",
    sms: async (to, text) => void sms.push({ text, to }),
    ...config,
  });
  let cookie = "";
  async function call(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await base.handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(cookie ? { cookie } : {}),
          "cf-connecting-ip": "203.0.113.7",
          origin: ORIGIN,
          ...headers,
        },
        method: body === undefined ? "GET" : "POST",
      }),
    );
    const set = response.headers.getSetCookie();
    const token = set.find((c) => c.startsWith("__Host-base.session_token="));
    if (token) cookie = token.split(";")[0];
    return { body: (await response.json().catch(() => null)) as { user?: Record<string, unknown> } | null, response, set };
  }
  return {
    base,
    call,
    db,
    forget: () => void (cookie = ""),
    mail,
    sms,
    /** The newest code texted to a number. */
    code: () => /(\d{6})/.exec(sms.at(-1)?.text ?? "")?.[1] ?? "",
  };
}
