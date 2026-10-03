/**
 * What base says to a person, in Georgian and in English (ADR 0021, point 5:
 * a template per language, the person's own). A project may replace any of
 * them; the Unisites "Email" page will keep its edits in the project's D1.
 */
export type Locale = "ka" | "en";
export type Messages = {
    /** The SMS with a sign-in code. */
    smsCode: (v: {
        app: string;
        code: string;
    }) => string;
    /** An email with a one-time code: sign-in, confirming the address, a new password, a new address. */
    emailCode: (v: {
        app: string;
        code: string;
        purpose: CodePurpose;
    }) => Letter;
    /** The link that confirms an address after signing up with a password. */
    confirmEmail: (v: {
        app: string;
        url: string;
    }) => Letter;
    /** The link that sets a new password. */
    resetPassword: (v: {
        app: string;
        url: string;
    }) => Letter;
};
export type CodePurpose = "sign-in" | "email-verification" | "forget-password" | "change-email";
export type Letter = {
    body: string;
    button?: {
        label: string;
        url: string;
    };
    subject: string;
};
export declare const MESSAGES: Record<Locale, Messages>;
/** A letter as the mail sender takes it: plain text and simple, safe HTML. */
export declare function render(letter: Letter, to: string): {
    html: string;
    subject: string;
    text: string;
    to: string;
};
/** The person's language: a "lang" cookie, else the browser's first choice, else Georgian. */
export declare function localeOf(request: Request): Locale;
