/**
 * What base says to a person, in Georgian and in English (ADR 0021, point 5:
 * a template per language, the person's own). Each text is a template with
 * {{variables}}; the project's admin edits them on Unisites' "Mail" page,
 * which keeps them in the project's D1 (_base_settings, template.<kind>.<locale>),
 * and base falls back to these where nothing is saved.
 */
export type Locale = "ka" | "en";
export declare const LOCALES: Locale[];
export type CodePurpose = "sign-in" | "email-verification" | "forget-password" | "change-email";
export type Letter = {
    body: string;
    button?: {
        label: string;
        url: string;
    };
    subject: string;
};
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
export type TemplateKind = keyof Messages;
export declare const TEMPLATE_KINDS: TemplateKind[];
/** A template: an SMS has a body only; a letter a subject, a body, and for a link a button's label. */
export type Template = {
    body: string;
    button?: string;
    subject?: string;
};
/** The variables each template may use, and those it must (a code letter without its code is useless). */
export declare const VARIABLES: Record<TemplateKind, {
    may: string[];
    must: string[];
}>;
export declare const TEMPLATES: Record<Locale, Record<TemplateKind, Template>>;
/** What {{purpose}} reads as, by the code's purpose. */
export declare const CODE_PURPOSE: Record<Locale, Record<CodePurpose, string>>;
/** {{name}} replaced by its value; an unknown variable is left as it is. */
export declare function fill(text: string, values: Record<string, string>): string;
/** What is wrong with a template, or nothing: the variables it may use, and those it must. */
export declare function templateProblems(kind: TemplateKind, template: Template): string[];
/** The messages from a set of templates (a project's own, where it has them, base's elsewhere). */
export declare function messagesFrom(locale: Locale, own?: Partial<Record<TemplateKind, Template>>): Messages;
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
