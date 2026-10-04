/**
 * Which ways in are on (plan stage 11): switches the project's admin sets
 * on Unisites' "Sign-in methods" page, kept in the project's own D1
 * (_base_settings, migrations/base_0002.sql). The code says what a project
 * can do (an SMS sender, mail, Google's keys); a switch can only turn off
 * what the code can do. base writes what it can do into the same table, so
 * the page shows which switches mean something.
 */
import { type Locale, type NoticeKind, type Template, type TemplateKind } from "./messages.ts";
export declare const SETTINGS_TABLE = "_base_settings";
export declare const LOG_TABLE = "_base_message_log";
/** How long the log keeps a line. */
export declare const LOG_DAYS = 90;
export type Switches = {
    /** People may make an account themselves. */
    signUp: boolean;
    phone: boolean;
    passwords: boolean;
    emailCode: boolean;
    google: boolean;
    facebook: boolean;
};
export declare const SWITCHES: (keyof Switches)[];
/** Everything on: what a project gets before its admin changes anything. */
export declare const ALL_ON: Switches;
type Row = Record<string, unknown>;
export type SettingsDatabase = {
    prepare(sql: string): unknown;
};
/** One statement on a D1 database or on Node's DatabaseSync (the tests'). */
export declare function run(db: SettingsDatabase, sql: string, params: unknown[], read: boolean): Promise<Row[]>;
/** The switches as the admin left them; everything on where nothing is said. */
export declare function readSwitches(db: SettingsDatabase): Promise<Switches>;
/** What the code can do, kept for the Unisites page; written only when it changed. */
export declare function noteCapabilities(db: SettingsDatabase, capabilities: Switches, known: string | null): Promise<string>;
export declare function readCapabilities(db: SettingsDatabase): Promise<string | null>;
export type Templates = Record<Locale, Partial<Record<TemplateKind, Template>>>;
/** The project's own templates (template.<kind>.<locale>), as the admin saved them on Unisites. */
export declare function readTemplates(db: SettingsDatabase): Promise<Templates>;
export type LogLine = {
    channel: "sms" | "email";
    kind: TemplateKind;
    purpose?: string | null;
    to: string;
    status: "sent" | "failed";
    error?: string | null;
};
/** One line in the log; now and then the lines older than LOG_DAYS go. */
export declare function logMessage(db: SettingsDatabase, line: LogLine, now?: Date): Promise<void>;
export type Notices = Record<NoticeKind, boolean>;
/** The security notices before the admin changes anything: a password or a second factor changed, yes; every new device, no. */
export declare const NOTICES_DEFAULT: Notices;
/** Which security notices the admin left on (notify.<kind>, "true"/"false"). */
export declare function readNotices(db: SettingsDatabase): Promise<Notices>;
export {};
