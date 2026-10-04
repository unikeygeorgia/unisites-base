/**
 * What base says to a person, in Georgian and in English (ADR 0021, point 5:
 * a template per language, the person's own). Each text is a template with
 * {{variables}}; the project's admin edits them on Unisites' "Mail" page,
 * which keeps them in the project's D1 (_base_settings, template.<kind>.<locale>),
 * and base falls back to these where nothing is saved.
 */

export type Locale = "ka" | "en";
export const LOCALES: Locale[] = ["ka", "en"];

export type CodePurpose = "sign-in" | "email-verification" | "forget-password" | "change-email";
export type Letter = { body: string; button?: { label: string; url: string }; subject: string };

export type Messages = {
  /** The SMS with a sign-in code. */
  smsCode: (v: { app: string; code: string }) => string;
  /** An email with a one-time code: sign-in, confirming the address, a new password, a new address. */
  emailCode: (v: { app: string; code: string; purpose: CodePurpose }) => Letter;
  /** The link that confirms an address after signing up with a password. */
  confirmEmail: (v: { app: string; url: string }) => Letter;
  /** The link that sets a new password. */
  resetPassword: (v: { app: string; url: string }) => Letter;
};

export type TemplateKind = keyof Messages;
export const TEMPLATE_KINDS: TemplateKind[] = ["confirmEmail", "resetPassword", "emailCode", "smsCode"];

/** A template: an SMS has a body only; a letter a subject, a body, and for a link a button's label. */
export type Template = { body: string; button?: string; subject?: string };

/** The variables each template may use, and those it must (a code letter without its code is useless). */
export const VARIABLES: Record<TemplateKind, { may: string[]; must: string[] }> = {
  confirmEmail: { may: ["app"], must: [] },
  emailCode: { may: ["app", "code", "purpose"], must: ["code"] },
  resetPassword: { may: ["app"], must: [] },
  smsCode: { may: ["app", "code"], must: ["code"] },
};

export const TEMPLATES: Record<Locale, Record<TemplateKind, Template>> = {
  en: {
    confirmEmail: {
      body: "Confirm that this email is yours, and your {{app}} account is ready.",
      button: "Confirm email",
      subject: "{{app}}: confirm your email",
    },
    emailCode: {
      body: "{{purpose}}: {{code}}\n\nThe code works for 5 minutes. If you did not ask for it, just don't use it.",
      subject: "{{app}}: code {{code}}",
    },
    resetPassword: {
      body: "Open the link to set a new password. It works for 1 hour. If you did not ask for it, your password stays as it is.",
      button: "Set a new password",
      subject: "{{app}}: a new password",
    },
    smsCode: { body: "{{app}}: your code is {{code}}. It works for 5 minutes." },
  },
  ka: {
    confirmEmail: {
      body: "დაადასტურე, რომ ეს ელფოსტა შენია, და {{app}}-ზე ანგარიში ჩაირთვება.",
      button: "ელფოსტის დადასტურება",
      subject: "{{app}}: ელფოსტის დადასტურება",
    },
    emailCode: {
      body: "{{purpose}}: {{code}}\n\nკოდი 5 წუთი მოქმედებს. თუ ეს შენ არ გითხოვია, უბრალოდ არ გამოიყენო.",
      subject: "{{app}}: კოდი {{code}}",
    },
    resetPassword: {
      body: "ახალი პაროლისთვის გახსენი ბმული. ის 1 საათი მოქმედებს. თუ ეს შენ არ გითხოვია, პაროლი არ შეიცვლება.",
      button: "ახალი პაროლი",
      subject: "{{app}}: ახალი პაროლი",
    },
    smsCode: { body: "{{app}}: შენი კოდია {{code}}. მოქმედებს 5 წუთი." },
  },
};

/** What {{purpose}} reads as, by the code's purpose. */
export const CODE_PURPOSE: Record<Locale, Record<CodePurpose, string>> = {
  en: {
    "change-email": "Your code to change the email",
    "email-verification": "Your code to confirm the email",
    "forget-password": "Your code for a new password",
    "sign-in": "Your sign-in code",
  },
  ka: {
    "change-email": "ელფოსტის შესაცვლელი კოდი",
    "email-verification": "ელფოსტის დასადასტურებელი კოდი",
    "forget-password": "ახალი პაროლის კოდი",
    "sign-in": "შესვლის კოდი",
  },
};

/** {{name}} replaced by its value; an unknown variable is left as it is. */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z]+)\s*\}\}/g, (whole, name: string) => values[name] ?? whole);
}

/** What is wrong with a template, or nothing: the variables it may use, and those it must. */
export function templateProblems(kind: TemplateKind, template: Template): string[] {
  const problems: string[] = [];
  const text = [template.subject ?? "", template.body, template.button ?? ""].join("\n");
  const used = [...text.matchAll(/\{\{\s*([a-z]+)\s*\}\}/g)].map((m) => m[1] ?? "");
  const { may, must } = VARIABLES[kind];
  for (const name of used) if (!may.includes(name)) problems.push(`{{${name}}} is not a variable here`);
  for (const name of must) if (!used.includes(name)) problems.push(`{{${name}}} is missing`);
  if (!template.body.trim()) problems.push("the text is empty");
  if (kind !== "smsCode" && !template.subject?.trim()) problems.push("the subject is empty");
  if ((kind === "confirmEmail" || kind === "resetPassword") && !template.button?.trim()) problems.push("the button is empty");
  if (kind === "smsCode" && template.body.length > 300) problems.push("an SMS this long is several SMS");
  if (text.length > 5000) problems.push("too long");
  return problems;
}

/** The messages from a set of templates (a project's own, where it has them, base's elsewhere). */
export function messagesFrom(locale: Locale, own: Partial<Record<TemplateKind, Template>> = {}): Messages {
  const pick = (kind: TemplateKind): Template => {
    const mine = own[kind];
    return mine && templateProblems(kind, mine).length === 0 ? mine : TEMPLATES[locale][kind];
  };
  const letter = (kind: TemplateKind, values: Record<string, string>, url?: string): Letter => {
    const t = pick(kind);
    return {
      body: fill(t.body, values),
      ...(url && t.button ? { button: { label: fill(t.button, values), url } } : {}),
      subject: fill(t.subject ?? "", values),
    };
  };
  return {
    confirmEmail: ({ app, url }) => letter("confirmEmail", { app }, url),
    emailCode: ({ app, code, purpose }) => letter("emailCode", { app, code, purpose: CODE_PURPOSE[locale][purpose] }),
    resetPassword: ({ app, url }) => letter("resetPassword", { app }, url),
    smsCode: ({ app, code }) => fill(pick("smsCode").body, { app, code }),
  };
}

export const MESSAGES: Record<Locale, Messages> = { en: messagesFrom("en"), ka: messagesFrom("ka") };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A letter as the mail sender takes it: plain text and simple, safe HTML. */
export function render(letter: Letter, to: string): { html: string; subject: string; text: string; to: string } {
  const paragraphs = letter.body
    .split("\n\n")
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const button = letter.button
    ? `<p style="margin:24px 0"><a href="${esc(letter.button.url)}" style="display:inline-block;background:#12131a;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:999px">${esc(letter.button.label)}</a></p>`
    : "";
  return {
    html: `<!doctype html><html><body style="margin:0;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#12131a;background:#ffffff"><div style="max-width:520px;margin:0 auto">${paragraphs}${button}</div></body></html>`,
    subject: letter.subject,
    text: letter.button ? `${letter.body}\n\n${letter.button.url}` : letter.body,
    to,
  };
}

/** The person's language: a "lang" cookie, else the browser's first choice, else Georgian. */
export function localeOf(request: Request): Locale {
  const cookie = /(?:^|;\s*)lang=(ka|en)\b/.exec(request.headers.get("cookie") ?? "")?.[1];
  if (cookie === "ka" || cookie === "en") return cookie;
  const first = (request.headers.get("accept-language") ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("en") ? "en" : "ka";
}
