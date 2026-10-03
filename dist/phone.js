/**
 * Phone numbers as better-auth stores them: E.164, "+995555123456". A
 * Georgian mobile typed the way people type it ("555 12 34 56",
 * "+995 555-12-34-56", "995555123456") becomes that; other countries must
 * already start with "+".
 */
export function toE164(raw) {
    const digits = raw.replace(/[^\d+]/g, "");
    if (/^\+[1-9]\d{7,14}$/.test(digits))
        return digits;
    const bare = digits.replace(/^\+/, "");
    if (/^5\d{8}$/.test(bare))
        return `+995${bare}`;
    if (/^9955\d{8}$/.test(bare))
        return `+${bare}`;
    return null;
}
/** Whether better-auth may take this as a phone number (it is E.164 already). */
export function isE164(phone) {
    return /^\+[1-9]\d{7,14}$/.test(phone);
}
/** Where a phone-only account's email would be: never sent to, never shown. */
export function placeholderEmail(phone) {
    return `${phone.replace(/\D/g, "")}@phone.invalid`;
}
export function isPlaceholderEmail(email) {
    return email.endsWith("@phone.invalid");
}
