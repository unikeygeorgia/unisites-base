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
- **Protection:** rate limits in D1 by IP, strict where a request costs money or guesses a secret
  (3 SMS codes a minute; `RATE_RULES`), Turnstile when its secret is set, breached passwords refused
  (haveibeenpwned), a second factor (TOTP) for those who turn it on, a signing secret of 32+
  characters or no start, and no mail ever sent to a phone-only account's placeholder address.
- **Every sign-in** is written to `_base_sign_in`: who, when, from where, how.
- **Language:** SMS and mail in Georgian or English, the person's own.
- **Mail senders:** SMTP from the project's own mailbox (DirectAdmin or cPanel, Zoho, Google
  Workspace, Unimail's mailboxes; 465 TLS or 587 STARTTLS, from a Worker's TCP socket), Resend, or
  your own function. `mailFromEnv(env)` picks the one Unisites set up as Worker secrets
  (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `MAIL_FROM`; or `RESEND_API_KEY`), so
  the project's code does not change with the sender. `unisites-base/smtp` is the SMTP client alone,
  without better-auth (Unisites tests a mailbox with it before saving it).
- **Switches:** the project's admin turns ways in (and sign-up) off and on from Unisites'
  "Sign-in methods" page, kept in `_base_settings`; a Worker reads them every 30 seconds. A switch
  only closes what the code can do; base writes what the code can do beside them for the page.

## Use

```bash
npm install https://github.com/unikeygeorgia/unisites-base/archive/refs/tags/v0.3.1.tar.gz   # the lockfile keeps its hash
npx unisites-base migrations          # copies base_*.sql into ./migrations
```

```ts
import { createBase, localeOf, mailFromEnv, smsoffice } from "unisites-base";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/auth/")) {
      const base = createBase({
        app: "My Shop",
        baseURL: url.origin,
        database: env.DB,
        secret: env.BASE_SECRET,
        locale: localeOf(request),
        sms: smsoffice({ apiKey: env.SMSOFFICE_API_KEY, sender: "MyShop" }),
        mail: mailFromEnv(env),                       // SMTP or Resend, as set on Unisites
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

## Security

better-auth is pinned to an exact version, and only the plugins listed above are used (no SSO, SCIM,
OAuth server or OAuth proxy). Report a vulnerability privately: see [SECURITY.md](SECURITY.md).
