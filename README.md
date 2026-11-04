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
- **Templates:** every SMS and letter is a template with `{{variables}}`, in Georgian and English;
  the admin edits them on Unisites' "Mail" page (kept in `_base_settings`), and a broken one falls
  back to base's own text. `unisites-base/messages` has the defaults and the checks, alone.
- **Security notices:** a letter when the password changes (after a reset, every other session also
  ends), when the second factor is turned off, and (off by default) on a sign-in from a new device;
  each has a switch on Unisites (`notify.<kind>` in `_base_settings`) and a template.
- **Log:** every SMS and letter sent, or tried, in `_base_message_log` (`base_0003.sql`): when, to
  whom, which, sent or failed with the reason; never the code or the text; kept 90 days.
- **Mail senders:** SMTP from the project's own mailbox (DirectAdmin or cPanel, Zoho, Google
  Workspace, Unimail's mailboxes; 465 TLS or 587 STARTTLS, from a Worker's TCP socket), Resend, or
  your own function. `mailFromEnv(env)` picks the one Unisites set up as Worker secrets
  (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `MAIL_FROM`; or `RESEND_API_KEY`), so
  the project's code does not change with the sender. Until the project has one, it sends through
  Cloudflare Email Service from the address Unisites gives every app, `<name>@unisites.ge` (the
  `EMAIL` binding and `UNISITES_MAIL_FROM`), so email and password work from the first deploy;
  `MAIL_FROM` then still gives the letter its name, and its address takes the replies. `unisites-base/smtp` is the SMTP client alone,
  without better-auth (Unisites tests a mailbox with it before saving it).
- **Invitations and reset letters from Unisites:** the project's admin invites someone, or sends
  someone a reset letter, from Unisites' "Users" page. Unisites signs the order (HMAC-SHA256, good
  for 5 minutes) with the project's own key, the Worker secret `BASE_PLATFORM_KEY`, and the project
  sends the letter through its own sender: Unisites never holds the project's mail keys. The link
  (7 days for an invitation, 1 hour for a reset) opens the project's own password page, or base's
  (`/api/auth/unisites/set-password`, Georgian and English, no referrer, no cache, its own script
  only); using it confirms the address. Without `BASE_PLATFORM_KEY` there are no orders.
  `unisites-base/platform` is the signing alone, for Unisites' side.
- **Switches:** the project's admin turns ways in (and sign-up) off and on from Unisites'
  "Sign-in methods" page, kept in `_base_settings`; a Worker reads them every 30 seconds. A switch
  only closes what the code can do; base writes what the code can do beside them for the page.

## Use

```bash
npm install https://github.com/unikeygeorgia/unisites-base/archive/refs/tags/v0.7.0.tar.gz   # the lockfile keeps its hash
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
        mail: mailFromEnv(env),                       // SMTP, Resend, or <name>@unisites.ge
        google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
        turnstileSecret: env.TURNSTILE_SECRET,
        platformKey: env.BASE_PLATFORM_KEY,          // invitations and reset letters from Unisites
        waitUntil: (p) => ctx.waitUntil(p),
      });
      return base.handler(request);
    }
    // …the app
  },
};
```

Secrets (`BASE_SECRET`, `BASE_PLATFORM_KEY` and the senders' keys) are set on the project's Worker from Unisites, never
in the repository.

## Data and access rules

`unisites-base/data` reads and writes a project's tables for a person through rules, the way
Postgres RLS and PocketBase's API rules do (unisites ADR 0030). The rules are in `access.json`:

```json
{
  "tables": {
    "notes": {
      "list": "exists(memberships, tenant_id = row.tenant_id && user_id = auth.id)",
      "view": "exists(memberships, tenant_id = row.tenant_id && user_id = auth.id)",
      "create": "exists(memberships, tenant_id = row.tenant_id && user_id = auth.id)",
      "update": "owner_id = auth.id",
      "delete": "owner_id = auth.id",
      "hidden": ["internal_note"],
      "fill": { "owner_id": "auth.id" }
    },
    "plans": { "list": "" }
  }
}
```

- **Five rules a table:** `list`, `view` (one row by key), `create` (checked on the new rows),
  `update` (the old row) with `updateCheck` (the new row; `update` when missing), `delete`. A missing
  or `null` rule refuses everyone, `""` lets everyone in, and a table without rules is not served.
- **The language:** columns, `auth.<field>`, `row.<column>` inside `exists()`, `=`, `!=`, `<`, `<=`,
  `>`, `>=`, `in [..]`, `&&`, `||`, `!`, `null`, `true`, `false`, numbers and strings. It becomes SQL with
  every value as a parameter; it is never SQL.
- **Columns:** `hidden` are never read, filtered, ordered by or written; `readonly` are read only;
  `fill` are set from the session on create and readonly after. Keys are never changed.
- **One statement each,** with the rules inside, so nothing is read, counted or written that they do
  not allow: update and delete also apply `list`, returned rows apply `list`, a create writes all its
  rows or none. Update and delete need a column filter.
- **Values as the column keeps them:** text only into text columns, numbers and booleans only into
  numeric ones (SQLite would turn `'-5'` into `-5` after the rule had checked the text). `rowid` and
  its other names are never taken from a request, and a table's `ON CONFLICT REPLACE` never deletes
  another row (`INSERT OR ABORT`). A UNIQUE, foreign key or CHECK failure is only `conflict`: it does
  not name the column, though it does say that the value is taken, as in Postgres.
- **Signed out:** `auth.*` is null, and a comparison with null is false; a `!` or `!=` over `auth.*`
  is true, so `check` warns about it.

```ts
import { createData, d1 } from "unisites-base/data";
import access from "../access.json";

const data = createData({ exec: d1(env.DB), access });   // sqlStorage(ctx.storage.sql) in a Durable Object
const db = data.as(user ? { id: user.id, role: user.role } : null);
await db.list("notes", { where: [{ column: "body", op: "ilike", value: "%milk%" }], order: [{ column: "id" }], limit: 50 });
await db.create("notes", { id: crypto.randomUUID(), tenant_id: "t1", body: "…" });
await db.update("notes", [{ column: "id", op: "eq", value: "n1" }], { body: "…" });

data.admin();   // no rules, like Supabase's service role: the project's own server code only
```

`db.upsert(table, rows, { onConflict: ["tenant_id", "external_id"] })` is create, and a row that
collides changes the one already there through update's rules (and list on it), as Postgres does for
`ON CONFLICT DO UPDATE`; one refused row writes none. A key a row leaves out takes the column's
default, and the rules see that default.

### supabase-js: `/rest/v1`

`unisites-base/rest` answers `/rest/v1/<table>` as PostgREST does, through `data.as(person)`, so a
project moving from Supabase keeps its `supabase.from(...)` code:

```ts
import { createRest } from "unisites-base/rest";

const rest = createRest({
  data,
  auth: async (request) => {
    const session = await base.api.getSession({ headers: request.headers });
    return session ? { id: session.user.id, role: session.user.role } : null;
  },
  rpc: { mark_read: async ({ conversation_id }, { db }) => db.update("messages", [/* … */], { read: true }) },
});
if (url.pathname.startsWith("/rest/v1/")) return rest.handler(request);
```

```ts
const supabase = createClient(location.origin, "unisites");   // the key is not used: the cookie is
const { data } = await supabase.from("memberships").select("role, tenants(id, name)").eq("user_id", id);
```

- **Reads:** `select` with columns, `*`, `alias:column` and embeds through a foreign key of one
  column either way (`tenants(...)`, `notes(...)`, `table!fk_column(...)`, nested); each embedded
  table is read through its own rules. Filters `eq neq gt gte lt lte like ilike in is`, `not`,
  `or()`, `and()`, and on JSON columns `contains`, `containedBy`, `overlaps` (as jsonb's `@>`:
  by JSON type, nested; a column that is not JSON is NULL); `order`, `limit`, `range`, `count`,
  `head`, `single()`, `maybeSingle()`.
- **Writes:** `insert`, `upsert` (`onConflict`, `ignoreDuplicates`), `update`, `delete`, with
  `.select()` for the rows back; `rpc(name, args)` calls the project's own function from `rpc`.
- **Not Postgres:** a column declared `BOOLEAN` comes back `true`/`false`, one whose type names JSON
  (`JSON TEXT`, so that SQLite keeps it as text) comes back parsed. A filter's value is read by the
  column's type: text where it keeps numbers is a 400, as Postgres' `22P02`.
- **Not supported, and a 400 rather than a guess:** `!inner`, filters or order on an embedded table,
  casts, JSON paths, aggregates, ranges, full-text search, CSV, other schemas than `public`.
- **Errors** have PostgREST's codes: no table or no rules `404 PGRST205`, a hidden column as a missing
  one `42703`, a refused row `403 42501`, a collision `409 23505`, a change without a filter `21000`.
- **Origin:** writes and functions come from the project's own origin only (and those in `origins`,
  an app's WebView): every `*.unisites.ge` is the same site, so the cookie's SameSite=Lax is not
  enough. A function answers GET only with `{ handler, get: true }`, for one that changes nothing.
  Bodies are `application/json`, at most 2 MB.
- **single() on a change** changes no row if it would change more than one, as PostgREST rolls back.
- **Embeds:** at most 20 in one select, and at most 5 × `maxRows` embedded rows in one request.
- **What a person can learn, as in Postgres:** a UNIQUE collision (409), `ignoreDuplicates` with a
  count, or an upsert refused on a row they cannot see, says that such a row exists.

### Realtime: `supabase.channel(...)`

`unisites-base/realtime` speaks realtime-js's own protocol, so `postgres_changes` subscriptions
work unchanged. A room is a Durable Object with hibernating WebSockets. Every write through `data`
(`as` and `admin`) hands its rows to `onChange`, and the room sends each row only to the sockets
whose person `list`'s rule lets see it, without hidden columns, and through their filter.

```ts
import { createRealtime, createRoom } from "unisites-base/realtime";

export const Realtime = createRoom((env: Env) => ({ data: createData({ exec: d1(env.DB), access }) }));

const realtime = createRealtime({ namespace: env.REALTIME, auth });
const data = createData({ exec: d1(env.DB), access, onChange: (changes) => ctx.waitUntil(realtime.notify(changes)) });
if (url.pathname.startsWith("/realtime/v1/")) return realtime.handler(request);
```

```jsonc
// wrangler.jsonc
"durable_objects": { "bindings": [{ "name": "REALTIME", "class_name": "Realtime" }] },
"migrations": [{ "tag": "realtime", "new_sqlite_classes": ["Realtime"] }]
```

```ts
supabase
  .channel(`inbox:${tenantId}`)
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `tenant_id=eq.${tenantId}` }, (p) => …)
  .subscribe();
```

- **Takes:** one table of `public`, `INSERT`, `UPDATE`, `DELETE` or `*`, and one filter
  `column=op.value` with `eq neq lt lte gt gte in`, as Supabase does. A table not served, a hidden
  or missing column, or another filter is a `CHANNEL_ERROR`.
- **Old rows:** an UPDATE's `old` is the key (as Postgres without `REPLICA IDENTITY FULL`); a
  DELETE's is the whole row the person may see. Unlike Supabase, a DELETE also goes through the
  rules and the filter.
- **Sockets:** only from the project's own origin (and `origins`); a socket lives at most an hour
  (`maxAge`), after which realtime-js joins again and the session is checked again;
  `realtime.disconnect(userId)` closes a person's sockets at once (signing out everywhere, a block).
  At most 20 channels on a socket, 10 subscriptions on a channel (within Cloudflare's 2 KB), 10
  sockets for a person (or a signed-out address), 2,000 in a room (`maxSockets`), 50 messages a
  second. Each change is checked once for each person in the room, whatever their filters.
- **Only through `data`:** a row a trigger, a cascade or raw SQL changes sends nothing. A person's
  session fields are the ones they joined with, until the socket's hour is up or `disconnect`.
- **Not yet:** broadcast and presence.

### Moving from Supabase: the report

```bash
SUPABASE_ACCESS_TOKEN=… npx unisites-base import-supabase --report --project <ref> --code .
npx unisites-base import-supabase --sql        # the query, for Supabase's SQL editor; then --catalog answer.json
```

It reads the project's catalog with one SELECT: tables, column grants, constraints, indexes,
triggers, policies, SQL functions, the realtime publication, buckets, and counts of people and
files. Never a row of the data, and it changes nothing in Supabase or in the project. Into
`./supabase-import/` it writes:

- `report.md`: each table, rule, function, trigger, bucket, way of signing in and use of supabase-js
  in the code, as moves by itself, moves with a difference, or by hand, and why.
- `schema.sql`: the tables for SQLite. uuid and text become `TEXT`, jsonb and arrays `JSON TEXT`,
  timestamps ISO `TEXT`, numeric `REAL` (said in the report), an identity key `INTEGER PRIMARY KEY`,
  enums a `CHECK`. `gen_random_uuid()` and `now()` keep making the same values, foreign keys to
  `auth.users` point to `_base_user`, an `updated_at` trigger becomes SQLite's.
- `access.json`: the policies as rules. Helper functions such as `my_tenant_ids()` are inlined into
  `exists()`, `auth.uid()` is `auth.id`, roles become `auth.id != null`, and column grants become
  `hidden` and `readonly`. What it cannot translate stays closed and is listed with its SQL.

Then the rows, and the people with their passwords:

```bash
SUPABASE_ACCESS_TOKEN=… npx unisites-base import-supabase --data --project <ref>
```

It writes `supabase-import/data/*.sql` (git-ignored, readable only by you) for a new database made
from base's migrations and `schema.sql`, in the order the foreign keys need, each statement under
D1's 100 KB. Postgres reads every value as text, so nothing is lost on the way: bigint and numeric
keep their digits, timestamps are ISO in UTC as `now()` writes them, booleans 1 and 0, jsonb and
arrays JSON. People go into `_base_user` with their own ids (old rows' `auth.uid()` is still
`auth.id`), and bcrypt passwords into `_base_account`: they sign in with the password they had. The
files are tried on SQLite and every count compared with Postgres before it says they are ready.

Both drafts are tried before the report is written: the schema on SQLite after base's migrations,
and `check` on the rules. The tests hold the translation against Postgres itself (PGlite): each
person reads, and may create, the same rows under the draft as under the policies.

`npx unisites-base check` checks `access.json` against `migrations/` (no such table or column, base's
own tables opened, writes anyone may make, columns that look secret left readable, a rule that
trusts what a person writes about themself) and lists every `data.admin()` and `env.DB` in the code.

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
