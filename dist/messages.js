/**
 * What base says to a person, in Georgian and in English (ADR 0021, point 5:
 * a template per language, the person's own). A project may replace any of
 * them; the Unisites "Email" page will keep its edits in the project's D1.
 */
const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ka = {
    confirmEmail: ({ app, url }) => ({
        body: `დაადასტურე, რომ ეს ელფოსტა შენია, და ${app}-ზე ანგარიში ჩაირთვება.`,
        button: { label: "ელფოსტის დადასტურება", url },
        subject: `${app}: ელფოსტის დადასტურება`,
    }),
    emailCode: ({ app, code, purpose }) => ({
        body: `${CODE_PURPOSE.ka[purpose]}: ${code}\n\nკოდი 5 წუთი მოქმედებს. თუ ეს შენ არ გითხოვია, უბრალოდ არ გამოიყენო.`,
        subject: `${app}: კოდი ${code}`,
    }),
    resetPassword: ({ app, url }) => ({
        body: `ახალი პაროლისთვის გახსენი ბმული. ის 1 საათი მოქმედებს. თუ ეს შენ არ გითხოვია, პაროლი არ შეიცვლება.`,
        button: { label: "ახალი პაროლი", url },
        subject: `${app}: ახალი პაროლი`,
    }),
    smsCode: ({ app, code }) => `${app}: შენი კოდია ${code}. მოქმედებს 5 წუთი.`,
};
const en = {
    confirmEmail: ({ app, url }) => ({
        body: `Confirm that this email is yours, and your ${app} account is ready.`,
        button: { label: "Confirm email", url },
        subject: `${app}: confirm your email`,
    }),
    emailCode: ({ app, code, purpose }) => ({
        body: `${CODE_PURPOSE.en[purpose]}: ${code}\n\nThe code works for 5 minutes. If you did not ask for it, just don't use it.`,
        subject: `${app}: code ${code}`,
    }),
    resetPassword: ({ app, url }) => ({
        body: `Open the link to set a new password. It works for 1 hour. If you did not ask for it, your password stays as it is.`,
        button: { label: "Set a new password", url },
        subject: `${app}: a new password`,
    }),
    smsCode: ({ app, code }) => `${app}: your code is ${code}. It works for 5 minutes.`,
};
const CODE_PURPOSE = {
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
export const MESSAGES = { en, ka };
/** A letter as the mail sender takes it: plain text and simple, safe HTML. */
export function render(letter, to) {
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
export function localeOf(request) {
    const cookie = /(?:^|;\s*)lang=(ka|en)\b/.exec(request.headers.get("cookie") ?? "")?.[1];
    if (cookie === "ka" || cookie === "en")
        return cookie;
    const first = (request.headers.get("accept-language") ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
    return first.startsWith("en") ? "en" : "ka";
}
