/**
 * Which ways in are on (plan stage 11): switches the project's admin sets
 * on Unisites' "Sign-in methods" page, kept in the project's own D1
 * (_base_settings, migrations/base_0002.sql). The code says what a project
 * can do (an SMS sender, mail, Google's keys); a switch can only turn off
 * what the code can do. base writes what it can do into the same table, so
 * the page shows which switches mean something.
 */
import { LOCALES, NOTICE_KINDS, TEMPLATE_KINDS } from "./messages.js";
export const SETTINGS_TABLE = "_base_settings";
export const LOG_TABLE = "_base_message_log";
/** How long the log keeps a line. */
export const LOG_DAYS = 90;
export const SWITCHES = ["signUp", "phone", "passwords", "emailCode", "google", "facebook"];
/** Everything on: what a project gets before its admin changes anything. */
export const ALL_ON = {
    emailCode: true,
    facebook: true,
    google: true,
    passwords: true,
    phone: true,
    signUp: true,
};
/** One statement on a D1 database or on Node's DatabaseSync (the tests'). */
export async function run(db, sql, params, read) {
    const statement = db.prepare(sql);
    if (typeof statement.bind === "function") {
        const bound = statement.bind(...params);
        if (!read) {
            await bound.run();
            return [];
        }
        return (await bound.all()).results;
    }
    if (!read) {
        statement.run(...params);
        return [];
    }
    return statement.all(...params);
}
/** The switches as the admin left them; everything on where nothing is said. */
export async function readSwitches(db) {
    const rows = await run(db, `select key, value from ${SETTINGS_TABLE} where key like 'switch.%'`, [], true);
    const switches = { ...ALL_ON };
    for (const row of rows) {
        const key = String(row.key).slice("switch.".length);
        if (SWITCHES.includes(key))
            switches[key] = String(row.value) !== "false";
    }
    return switches;
}
/** What the code can do, kept for the Unisites page; written only when it changed. */
export async function noteCapabilities(db, capabilities, known) {
    const value = JSON.stringify(capabilities);
    if (value !== known) {
        await run(db, `insert into ${SETTINGS_TABLE} (key, value, updatedAt) values ('capabilities', ?1, ?2)
       on conflict (key) do update set value = excluded.value, updatedAt = excluded.updatedAt`, [value, new Date().toISOString()], false);
    }
    return value;
}
export async function readCapabilities(db) {
    const rows = await run(db, `select value from ${SETTINGS_TABLE} where key = 'capabilities'`, [], true);
    return rows[0] ? String(rows[0].value) : null;
}
/** The project's own templates (template.<kind>.<locale>), as the admin saved them on Unisites. */
export async function readTemplates(db) {
    const rows = await run(db, `select key, value from ${SETTINGS_TABLE} where key like 'template.%'`, [], true);
    const out = { en: {}, ka: {} };
    for (const row of rows) {
        const [, kind, locale] = String(row.key).split(".");
        if (!TEMPLATE_KINDS.includes(kind) || !LOCALES.includes(locale))
            continue;
        try {
            const value = JSON.parse(String(row.value));
            if (typeof value?.body === "string")
                out[locale][kind] = value;
        }
        catch {
            // a broken row: base's own text stays
        }
    }
    return out;
}
/** One line in the log; now and then the lines older than LOG_DAYS go. */
export async function logMessage(db, line, now = new Date()) {
    await run(db, `insert into ${LOG_TABLE} (at, channel, kind, purpose, "to", status, error) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)`, [now.toISOString(), line.channel, line.kind, line.purpose ?? null, line.to.slice(0, 200), line.status, line.error?.slice(0, 300) ?? null], false);
    if (Math.random() < 0.02) {
        await run(db, `delete from ${LOG_TABLE} where at < ?1`, [new Date(now.getTime() - LOG_DAYS * 86_400_000).toISOString()], false);
    }
}
/** The security notices before the admin changes anything: a password or a second factor changed, yes; every new device, no. */
export const NOTICES_DEFAULT = { newSignIn: false, passwordChanged: true, twoFactorDisabled: true };
/** Which security notices the admin left on (notify.<kind>, "true"/"false"). */
export async function readNotices(db) {
    const rows = await run(db, `select key, value from ${SETTINGS_TABLE} where key like 'notify.%'`, [], true);
    const notices = { ...NOTICES_DEFAULT };
    for (const row of rows) {
        const kind = String(row.key).slice("notify.".length);
        if (NOTICE_KINDS.includes(kind))
            notices[kind] = String(row.value) === "true";
    }
    return notices;
}
