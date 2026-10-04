export { baseOptions, capabilitiesOf, createBase, deviceOf, forgetSettings, RATE_RULES, SETTINGS_TTL_MS, TABLES, type BaseConfig } from "./base.ts";
export { ALL_ON, LOG_DAYS, LOG_TABLE, NOTICES_DEFAULT, SETTINGS_TABLE, SWITCHES, type Notices, type Switches, type Templates } from "./settings.ts";
export {
  CODE_PURPOSE,
  fill,
  LOCALES,
  localeOf,
  MESSAGES,
  messagesFrom,
  NOTICE_KINDS,
  render,
  TEMPLATE_KINDS,
  templateProblems,
  TEMPLATES,
  VARIABLES,
  type CodePurpose,
  type Letter,
  type Locale,
  type Messages,
  type NoticeKind,
  type Template,
  type TemplateKind,
} from "./messages.ts";
export { isBcrypt } from "./passwords.ts";
export { isE164, isPlaceholderEmail, placeholderEmail, toE164 } from "./phone.ts";
export { mailFromEnv, resend, smsoffice, type Mail, type MailSender, type SmsSender } from "./senders.ts";
export { mailbox, message, sendSmtp, smtp, SmtpError, type SmtpOptions, type SmtpSecurity } from "./smtp.ts";
