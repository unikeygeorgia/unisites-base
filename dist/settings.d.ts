/**
 * Which ways in are on (plan stage 11): switches the project's admin sets
 * on Unisites' "Sign-in methods" page, kept in the project's own D1
 * (_base_settings, migrations/base_0002.sql). The code says what a project
 * can do (an SMS sender, mail, Google's keys); a switch can only turn off
 * what the code can do. base writes what it can do into the same table, so
 * the page shows which switches mean something.
 */
export declare const SETTINGS_TABLE = "_base_settings";
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
export type SettingsDatabase = {
    prepare(sql: string): unknown;
};
/** The switches as the admin left them; everything on where nothing is said. */
export declare function readSwitches(db: SettingsDatabase): Promise<Switches>;
/** What the code can do, kept for the Unisites page; written only when it changed. */
export declare function noteCapabilities(db: SettingsDatabase, capabilities: Switches, known: string | null): Promise<string>;
export declare function readCapabilities(db: SettingsDatabase): Promise<string | null>;
