import { smtp, type SmtpSecurity } from "./smtp.ts";

/**
 * Who delivers a project's SMS and mail. A project passes one of these, or
 * its own function of the same shape; the text is base's (messages.ts) or
 * the project's own.
 */

export type SmsSender = (to: string, text: string) => Promise<void>;

export type Mail = { html: string; subject: string; text: string; to: string };
export type MailSender = (mail: Mail) => Promise<void>;

/** smsoffice.ge (Georgia): the number as 995XXXXXXXXX, the text as is. */
export function smsoffice({
  apiKey,
  fetcher = fetch,
  sender,
}: {
  apiKey: string;
  fetcher?: typeof fetch;
  sender: string;
}): SmsSender {
  return async (to, text) => {
    const body = new URLSearchParams({
      content: text,
      destination: to.replace(/\D/g, "").replace(/^(?!995)/, "995"),
      key: apiKey,
      sender,
      urgent: "true",
    });
    const response = await fetcher("https://smsoffice.ge/api/v2/send/", {
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    const out = (await response.json().catch(() => ({}))) as {
      ErrorCode?: number;
      Message?: string;
      Success?: boolean;
    };
    if (!out.Success) throw new Error(`smsoffice: ${out.ErrorCode ?? response.status} ${out.Message ?? ""}`.trim());
  };
}

/** Resend's HTTP API. */
export function resend({
  apiKey,
  fetcher = fetch,
  from,
  replyTo,
}: {
  apiKey: string;
  fetcher?: typeof fetch;
  from: string;
  replyTo?: string;
}): MailSender {
  return async ({ html, subject, text, to }) => {
    const response = await fetcher("https://api.resend.com/emails", {
      body: JSON.stringify({ from, html, subject, text, to: [to], ...(replyTo ? { reply_to: replyTo } : {}) }),
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`resend: ${response.status} ${(await response.text()).slice(0, 200)}`);
  };
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/**
 * The mail sender Unisites set up for the project, from its Worker's secrets
 * (ADR 0021, point 5), so the project's code does not change when the sender
 * does: SMTP when SMTP_HOST is set, else Resend when RESEND_API_KEY is, else
 * none. The address mail comes from is MAIL_FROM (or EMAIL_FROM).
 */
export function mailFromEnv(env: Record<string, unknown>): MailSender | undefined {
  const from = text(env.MAIL_FROM) ?? text(env.EMAIL_FROM);
  const replyTo = text(env.MAIL_REPLY_TO) ?? text(env.EMAIL_REPLY_TO);
  if (!from) return undefined;
  const host = text(env.SMTP_HOST);
  if (host) {
    const port = Number(text(env.SMTP_PORT) ?? 465);
    const security = (text(env.SMTP_SECURITY) as SmtpSecurity | undefined) ?? (port === 587 ? "starttls" : "tls");
    const username = text(env.SMTP_USERNAME) ?? from.replace(/^.*<|>$/g, "");
    const password = text(env.SMTP_PASSWORD);
    if (!password) return undefined;
    return smtp({ from, host, password, port, replyTo, security, username });
  }
  const apiKey = text(env.RESEND_API_KEY);
  return apiKey ? resend({ apiKey, from, replyTo }) : undefined;
}
