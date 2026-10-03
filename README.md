# unisites-base

Sign-in and mail for a [Unisites](https://app.unisites.ge) project: [better-auth](https://www.better-auth.com)
on the project's own Cloudflare Worker and D1, set up the way every Unisites project shares
(unisites ADR 0021 and 0022).

- **Ways in:** phone + SMS code, email + password (confirmed by mail, reset by mail), email codes,
  Google. Facebook is ready for later.
- **Tables:** `_base_*` in the project's D1, from `migrations/`. Unisites' "Users" page reads and
  changes them through D1: blocking is `banned = 1`, signing out everywhere is deleting sessions.
- **Cookie:** `__Host-base.session_token`, HttpOnly, Secure, SameSite=Lax.
- **Old passwords:** bcrypt hashes (as Supabase Auth keeps them) still sign in, and are written again
  as scrypt the first time they do.
- **Protection:** rate limits in D1 by IP, Turnstile when its secret is set, breached passwords
  refused (haveibeenpwned), a second factor (TOTP) for those who turn it on.
- **Every sign-in** is written to `_base_sign_in`: who, when, from where, how.
- **Language:** SMS and mail in Georgian or English, the person's own.

## Use

```bash
npm install github:unikeygeorgia/unisites-base#v0.1.0
npx unisites-base migrations          # copies base_0001.sql into ./migrations
```

```ts
import { createBase, localeOf, resend, smsoffice } from "unisites-base";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/auth/")) {
      const base = createBase({
        app: "Multicolor",
        baseURL: url.origin,
        database: env.DB,
        secret: env.BASE_SECRET,
        locale: localeOf(request),
        sms: smsoffice({ apiKey: env.SMSOFFICE_API_KEY, sender: "Multicolor" }),
        mail: resend({ apiKey: env.RESEND_API_KEY, from: "Multicolor <no-reply@multicolor.ge>" }),
        google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
        turnstileSecret: env.TURNSTILE_SECRET,
        waitUntil: (p) => ctx.waitUntil(p),
      });
      return base.handler(request);
    }
    // …the app
  },
};
```

Secrets (`BASE_SECRET` and the senders' keys) are set on the project's Worker from Unisites, never
in the repository.

## Develop

```bash
npm install
npm run check          # types, tests (Node's SQLite with the real migration), build
npm run migrations     # after raising better-auth: rewrites migrations/base_0001.sql
```

`dist/` is committed: a project installs a tag straight from GitHub, without a build.
