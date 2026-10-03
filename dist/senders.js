/**
 * Who delivers a project's SMS and mail. A project passes one of these, or
 * its own function of the same shape; the text is base's (messages.ts) or
 * the project's own.
 */
/** smsoffice.ge (Georgia): the number as 995XXXXXXXXX, the text as is. */
export function smsoffice({ apiKey, fetcher = fetch, sender, }) {
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
        const out = (await response.json().catch(() => ({})));
        if (!out.Success)
            throw new Error(`smsoffice: ${out.ErrorCode ?? response.status} ${out.Message ?? ""}`.trim());
    };
}
/** Resend's HTTP API. */
export function resend({ apiKey, fetcher = fetch, from, replyTo, }) {
    return async ({ html, subject, text, to }) => {
        const response = await fetcher("https://api.resend.com/emails", {
            body: JSON.stringify({ from, html, subject, text, to: [to], ...(replyTo ? { reply_to: replyTo } : {}) }),
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            method: "POST",
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok)
            throw new Error(`resend: ${response.status} ${(await response.text()).slice(0, 200)}`);
    };
}
