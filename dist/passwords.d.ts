/**
 * Passwords: new ones are better-auth's scrypt; old ones may be bcrypt
 * ($2a$/$2b$/$2y$), as Supabase Auth stored them, and still sign in. After
 * a bcrypt password signs in, base.ts writes it again as scrypt.
 */
export declare function isBcrypt(hash: string): boolean;
export declare const passwords: {
    hash: (password: string) => Promise<string>;
    verify: ({ hash, password }: {
        hash: string;
        password: string;
    }) => Promise<boolean>;
};
