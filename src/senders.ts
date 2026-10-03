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
