import bcrypt from "bcryptjs";
import { hashPassword, verifyPassword } from "better-auth/crypto";
/**
 * Passwords: new ones are better-auth's scrypt; old ones may be bcrypt
 * ($2a$/$2b$/$2y$), as Supabase Auth stored them, and still sign in. After
 * a bcrypt password signs in, base.ts writes it again as scrypt.
 */
export function isBcrypt(hash) {
    return /^\$2[aby]\$\d{2}\$/.test(hash);
}
export const passwords = {
    hash: (password) => hashPassword(password),
    verify: ({ hash, password }) => isBcrypt(hash) ? bcrypt.compare(password, hash) : verifyPassword({ hash, password }),
};
