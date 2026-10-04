/**
 * Which ways in are on (plan stage 11): switches the project's admin sets
 * on Unisites' "Sign-in methods" page, kept in the project's own D1
 * (_base_settings, migrations/base_0002.sql). The code says what a project
 * can do (an SMS sender, mail, Google's keys); a switch can only turn off
 * what the code can do. base writes what it can do into the same table, so
 * the page shows which switches mean something.
 */

export const SETTINGS_TABLE = "_base_settings";

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
async function run(db: SettingsDatabase, sql: string, params: unknown[], read: boolean): Promise<Row[]> {
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
