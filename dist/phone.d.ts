/**
 * Phone numbers as better-auth stores them: E.164, "+995555123456". A
 * Georgian mobile typed the way people type it ("555 12 34 56",
 * "+995 555-12-34-56", "995555123456") becomes that; other countries must
 * already start with "+".
 */
export declare function toE164(raw: string): string | null;
/** Whether better-auth may take this as a phone number (it is E.164 already). */
export declare function isE164(phone: string): boolean;
/** Where a phone-only account's email would be: never sent to, never shown. */
export declare function placeholderEmail(phone: string): string;
export declare function isPlaceholderEmail(email: string): boolean;
