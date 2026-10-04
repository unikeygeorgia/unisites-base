/**
 * Which ways in are on (plan stage 11): switches the project's admin sets
 * on Unisites' "Sign-in methods" page, kept in the project's own D1
 * (_base_settings, migrations/base_0002.sql). The code says what a project
 * can do (an SMS sender, mail, Google's keys); a switch can only turn off
 * what the code can do. base writes what it can do into the same table, so
 * the page shows which switches mean something.
 */

import { LOCALES, TEMPLATE_KINDS, type Locale, type Template, type TemplateKind } from "./messages.ts";

export const SETTINGS_TABLE = "_base_settings";
export const LOG_TABLE = "_base_message_log";
/** How long the log keeps a line. */
export const LOG_DAYS = 90;

export type Switches = {
  /** People may make an account themselves. */
  signUp: boolean;
  phone: boolean;
  passwords: boolean;
  emailCode: boolean;
  google: boolean;
  facebook: boolean;
};

export const SWITCHES: (keyof Switches)[] = ["signUp", "phone", "passwords", "emailCode", "google", "facebook"];

/** Everything on: what a project gets before its admin changes anything. */
export const ALL_ON: Switches = {
  emailCode: true,
  facebook: true,
  google: true,
  passwords: true,
  phone: true,
  signUp: true,
};

type Row = Record<string, unknown>;
type Statement = {
  all(...params: unknown[]): unknown;
  bind?: (...params: unknown[]) => Statement;
  run(...params: unknown[]): unknown;
};
export type SettingsDatabase = { prepare(sql: string): unknown };

/** One statement on a D1 database or on Node's DatabaseSync (the tests'). */
export async function run(db: SettingsDatabase, sql: string, params: unknown[], read: boolean): Promise<Row[]> {
  const statement = db.prepare(sql) as Statement;
  if (typeof statement.bind === "function") {
    const bound = statement.bind(...params);
    if (!read) {
      await bound.run();
      return [];
    }
    return ((await bound.all()) as { results: Row[] }).results;
  }
  if (!read) {
    statement.run(...params);
    return [];
  }
  return statement.all(...params) as Row[];
}

/** The switches as the admin left them; everything on where nothing is said. */
export async function readSwitches(db: SettingsDatabase): Promise<Switches> {
  const rows = await run(db, `select key, value from ${SETTINGS_TABLE} where key like 'switch.%'`, [], true);
  const switches = { ...ALL_ON };
  for (const row of rows) {
    const key = String(row.key).slice("switch.".length) as keyof Switches;
    if (SWITCHES.includes(key)) switches[key] = String(row.value) !== "false";
  }
  return switches;
}

/** What the code can do, kept for the Unisites page; written only when it changed. */
export async function noteCapabilities(db: SettingsDatabase, capabilities: Switches, known: string | null): Promise<string> {
  const value = JSON.stringify(capabilities);
  if (value !== known) {
    await run(
      db,
      `insert into ${SETTINGS_TABLE} (key, value, updatedAt) values ('capabilities', ?1, ?2)
       on conflict (key) do update set value = excluded.value, updatedAt = excluded.updatedAt`,
      [value, new Date().toISOString()],
      false,
    );
  }
  return value;
}

export async function readCapabilities(db: SettingsDatabase): Promise<string | null> {
  const rows = await run(db, `select value from ${SETTINGS_TABLE} where key = 'capabilities'`, [], true);
  return rows[0] ? String(rows[0].value) : null;
}

export type Templates = Record<Locale, Partial<Record<TemplateKind, Template>>>;

/** The project's own templates (template.<kind>.<locale>), as the admin saved them on Unisites. */
export async function readTemplates(db: SettingsDatabase): Promise<Templates> {
  const rows = await run(db, `select key, value from ${SETTINGS_TABLE} where key like 'template.%'`, [], true);
  const out: Templates = { en: {}, ka: {} };
  for (const row of rows) {
    const [, kind, locale] = String(row.key).split(".");
    if (!TEMPLATE_KINDS.includes(kind as TemplateKind) || !LOCALES.includes(locale as Locale)) continue;
    try {
      const value = JSON.parse(String(row.value)) as Template;
      if (typeof value?.body === "string") out[locale as Locale][kind as TemplateKind] = value;
    } catch {
      // a broken row: base's own text stays
    }
  }
  return out;
}

export type LogLine = {
  channel: "sms" | "email";
  kind: TemplateKind;
  purpose?: string | null;
  to: string;
  status: "sent" | "failed";
  error?: string | null;
};

/** One line in the log; now and then the lines older than LOG_DAYS go. */
export async function logMessage(db: SettingsDatabase, line: LogLine, now = new Date()): Promise<void> {
  await run(
    db,
    `insert into ${LOG_TABLE} (at, channel, kind, purpose, "to", status, error) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    [now.toISOString(), line.channel, line.kind, line.purpose ?? null, line.to.slice(0, 200), line.status, line.error?.slice(0, 300) ?? null],
    false,
  );
  if (Math.random() < 0.02) {
    await run(db, `delete from ${LOG_TABLE} where at < ?1`, [new Date(now.getTime() - LOG_DAYS * 86_400_000).toISOString()], false);
  }
}
