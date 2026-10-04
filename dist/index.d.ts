export { baseOptions, capabilitiesOf, createBase, forgetSettings, RATE_RULES, SETTINGS_TTL_MS, TABLES, type BaseConfig } from "./base.ts";
export { ALL_ON, SETTINGS_TABLE, SWITCHES, type Switches } from "./settings.ts";
export { localeOf, MESSAGES, render, type CodePurpose, type Letter, type Locale, type Messages } from "./messages.ts";
export { isBcrypt } from "./passwords.ts";
export { isE164, isPlaceholderEmail, placeholderEmail, toE164 } from "./phone.ts";
export { resend, smsoffice, type Mail, type MailSender, type SmsSender } from "./senders.ts";
