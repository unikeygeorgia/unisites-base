/** D1 takes a statement of at most 100,000 bytes (bytes: Georgian text is three a letter). */
const MAX_STATEMENT = 90_000;
const encoder = new TextEncoder();
const bytes = (s) => encoder.encode(s).length;
const ident = (n) => `"${n.replace(/"/g, '""')}"`;
const text = (s) => `'${s.replace(/'/g, "''")}'`;
const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
/** Microseconds kept: two rows a UNIQUE keeps apart stay apart. */
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
/** What Postgres is asked for, for one column: always text, and how SQLite then takes it. */
function reader(c) {
    const col = ident(c.name);
    const udt = c.udt.replace(/^_/, "");
    if (c.category === "A")
        return { sql: `to_json(${col})::text`, kind: "text" };
    if (udt === "bool")
        return { sql: `case when ${col} then '1' when not ${col} then '0' end`, kind: "number" };
    if (["int2", "int4", "int8", "numeric", "float4", "float8", "oid"].includes(udt))
        return { sql: `${col}::text`, kind: "number" };
    // infinity stays 'infinity' (after every date, as text sorts) and -infinity '-infinity' (before).
    if (udt === "timestamptz")
        return { sql: `case when isfinite(${col}) then to_char(${col} at time zone 'UTC', ${ISO}) else ${col}::text end`, kind: "text" };
    if (udt === "timestamp")
        return { sql: `case when isfinite(${col}) then to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS.US') else ${col}::text end`, kind: "text" };
    if (udt === "bytea")
        return { sql: `encode(${col}, 'hex')`, kind: "blob" };
    return { sql: `${col}::text`, kind: "text" };
}
function literal(v, kind, notes, where) {
    if (v === null || v === undefined)
        return "NULL";
    const s = String(v);
    if (kind === "number") {
        if (NUMBER.test(s))
            return s;
        // NaN and Infinity have no SQLite literal.
        notes.add(`${where}: ${s} is not a number SQLite keeps; it is NULL`);
        return "NULL";
    }
    if (kind === "blob") {
        if (!/^[0-9a-f]*$/i.test(s))
            throw new Error(`${where}: a blob that is not hex`);
        return `X'${s}'`;
    }
    return text(s);
}
/** Tables in the order their foreign keys need: one a row points to comes first. */
function ordered(tables) {
    const by = new Map(tables.map((t) => [t.name, t]));
    const done = new Set();
    const out = [];
    const visit = (t, path) => {
        if (done.has(t.name) || path.has(t.name))
            return;
        path.add(t.name);
        for (const k of t.constraints ?? []) {
            const to = k.type === "f" && k.references?.schema === "public" ? by.get(k.references.table) : undefined;
            if (to && to !== t)
                visit(to, path);
        }
        path.delete(t.name);
        done.add(t.name);
        out.push(t);
    };
    for (const t of tables)
        visit(t, new Set());
    return out;
}
/** INSERTs of rows, each statement under D1's size. */
function inserts(table, cols, rows) {
    const head = `INSERT INTO ${ident(table)} (${cols.map(ident).join(", ")}) VALUES\n`;
    const out = [];
    let batch = [];
    let size = head.length;
    for (const r of rows) {
        const line = `(${r.join(", ")})`;
        const n = bytes(line);
        if (batch.length && size + n + 2 > MAX_STATEMENT) {
            out.push(`${head}${batch.join(",\n")};`);
            batch = [];
            size = head.length;
        }
        batch.push(line);
        size += n + 2;
    }
    if (batch.length)
        out.push(`${head}${batch.join(",\n")};`);
    return out;
}
const PREAMBLE = "-- From `unisites-base import-supabase --data`: personal data, for one database, then delete.\nPRAGMA defer_foreign_keys = true;\n";
/** auth.users and their identities, as base's _base_user and _base_account; and who was left out. */
async function people(query, notes) {
    const users = await query(`
    select u.id::text as id, u.email, u.phone, u.encrypted_password as password,
      u.email_confirmed_at is not null as email_ok, u.phone_confirmed_at is not null as phone_ok,
      coalesce(u.banned_until > now(), false) as banned, to_char(u.banned_until at time zone 'UTC', ${ISO}) as ban_until,
      coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name') as name,
      coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture') as image,
      to_char(coalesce(u.created_at, now()) at time zone 'UTC', ${ISO}) as created,
      to_char(coalesce(u.updated_at, u.created_at, now()) at time zone 'UTC', ${ISO}) as updated,
      coalesce((select json_agg(json_build_array(i.provider, i.provider_id)) from auth.identities i where i.user_id = u.id), '[]'::json)::text as identities
    from auth.users u order by u.created_at, u.id`);
    const userRows = [];
    const accountRows = [];
    const seen = new Set();
    const dropped = new Set();
    for (const u of users) {
        const id = String(u.id);
        const phone = u.phone ? `+${String(u.phone).replace(/\D/g, "")}` : null;
        const email = u.email ? String(u.email).toLowerCase() : phone ? `${phone.slice(1)}@phone.invalid` : null;
        if (!email) {
            notes.add(`people: ${id} has neither an address nor a phone (an anonymous sign-in), and is left out`);
            dropped.add(id);
            continue;
        }
        if (seen.has(email)) {
            notes.add(`people: ${email} is there twice; the second (${id}) is left out`);
            dropped.add(id);
            continue;
        }
        seen.add(email);
        const name = u.name ?? (u.email ? String(u.email).split("@")[0] : phone);
        const emailOk = u.email ? !!u.email_ok : false;
        userRows.push([
            text(id), text(name), text(email), emailOk ? "1" : "0", u.image ? text(String(u.image)) : "NULL", text(String(u.created)), text(String(u.updated)),
            u.banned ? "1" : "0", u.banned && u.ban_until ? text(String(u.ban_until)) : "NULL", phone ? text(phone) : "NULL", phone ? (u.phone_ok ? "1" : "0") : "NULL",
        ]);
        const pw = u.password ? String(u.password) : "";
        if (pw) {
            if (!/^\$2[aby]\$\d{2}\$/.test(pw))
                notes.add(`people: ${id}'s password is not bcrypt; they set a new one`);
            else
                accountRows.push([text(`supabase-credential-${id}`), text(id), "'credential'", text(id), text(pw), text(String(u.created)), text(String(u.updated))]);
        }
        for (const [provider, providerId] of JSON.parse(String(u.identities))) {
            if (provider === "email" || provider === "phone")
                continue;
            if (provider !== "google") {
                notes.add(`people: ${id} signs in with ${provider}, which base has not got`);
                continue;
            }
            if (!providerId)
                continue;
            accountRows.push([text(`supabase-${provider}-${providerId}`), text(providerId), text(provider), text(id), "NULL", text(String(u.created)), text(String(u.updated))]);
        }
    }
    const sql = [
        ...inserts("_base_user", ["id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt", "banned", "banExpires", "phoneNumber", "phoneNumberVerified"], userRows),
        ...inserts("_base_account", ["id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt"], accountRows),
    ].join("\n\n");
    return { sql, rows: userRows.length, dropped };
}
export async function exportData(catalog, query, options = {}) {
    const pageRows = options.pageRows ?? 500;
    const fileRows = options.fileRows ?? 5000;
    const notes = new Set();
    const files = [];
    const counts = {};
    const p = await people(query, notes);
    files.push({ name: "0000_people.sql", sql: `${PREAMBLE}\n${p.sql}\n`, rows: p.rows });
    counts._base_user = p.rows;
    let n = 1;
    const wanted = options.tables ? new Set(options.tables) : null;
    const tables = ordered(catalog.tables);
    for (const t of tables) {
        // A foreign key back to a table that comes later is a cycle: defer_foreign_keys is all that holds it.
        for (const k of t.constraints ?? []) {
            const to = k.type === "f" && k.references?.schema === "public" ? k.references.table : null;
            if (to && to !== t.name && tables.findIndex((x) => x.name === to) > tables.indexOf(t)) {
                notes.add(`${t.name} → ${to} → … → ${t.name} is a cycle of foreign keys: each file has to run as one transaction`);
            }
        }
    }
    for (const t of tables) {
        if (wanted && !wanted.has(t.name))
            continue;
        const readers = t.columns.map(reader);
        const cols = t.columns.map((c) => c.name);
        const pk = (t.constraints ?? []).find((k) => k.type === "p")?.columns;
        // A stable order to page by: the key, or where the row is (ctid; every type has none of its own).
        const order = pk?.length ? pk.map(ident).join(", ") : "ctid";
        const select = readers.map((r, i) => `${r.sql} as c${i}`).join(", ");
        const raw = [];
        for (let offset = 0;; offset += pageRows) {
            const page = await query(`select coalesce(json_agg(json_build_array(${readers.map((_, i) => `c${i}`).join(", ")})), '[]'::json)::text as rows from (select ${select} from public.${ident(t.name)} order by ${order} limit ${pageRows} offset ${offset}) x`);
            const got = JSON.parse(String(page[0]?.rows ?? "[]"));
            raw.push(...got);
            if (got.length < pageRows)
                break;
        }
        counts[t.name] = raw.length;
        // A person left out: what points to them is NULL, or, where it may not be, the row stays behind.
        const toPeople = (t.constraints ?? []).filter((k) => k.type === "f" && k.references?.schema === "auth" && k.references.table === "users" && k.columns?.length === 1);
        let kept = raw;
        if (p.dropped.size) {
            kept = [];
            for (const r of raw) {
                let keep = true;
                for (const k of toPeople) {
                    const i = cols.indexOf(k.columns[0]);
                    if (r[i] !== null && p.dropped.has(r[i])) {
                        if (t.columns[i].notnull) {
                            keep = false;
                            notes.add(`${t.name}: a row of a person left out stays behind`);
                        }
                        else {
                            r[i] = null;
                            notes.add(`${t.name}.${cols[i]}: a person left out is NULL`);
                        }
                    }
                }
                if (keep)
                    kept.push(r);
            }
        }
        // A table that points to itself: each row after the one it points to.
        const self = (t.constraints ?? []).filter((k) => k.type === "f" && k.references?.schema === "public" && k.references.table === t.name && k.columns?.length === 1 && k.references.columns.length === 1);
        if (self.length)
            kept = parentsFirst(kept, self.map((k) => [cols.indexOf(k.columns[0]), cols.indexOf(k.references.columns[0])]));
        const file = t.name.replace(/[^A-Za-z0-9_]/g, "_");
        for (let at = 0, part = 1; at < kept.length; at += fileRows, part++) {
            const chunk = kept.slice(at, at + fileRows).map((r) => r.map((v, i) => literal(v, readers[i].kind, notes, `${t.name}.${cols[i]}`)));
            const name = `${String(n).padStart(4, "0")}_${file}${kept.length > fileRows ? `_${part}` : ""}.sql`;
            files.push({ name, sql: `${PREAMBLE}\n${inserts(t.name, cols, chunk).join("\n\n")}\n`, rows: chunk.length });
        }
        for (const r of raw)
            for (const [i, v] of r.entries())
                if (v === "infinity" || v === "-infinity")
                    notes.add(`${t.name}.${cols[i]}: ${v} is kept as the text '${v}'`);
        if (kept.length)
            n++;
    }
    for (const f of files) {
        for (const statement of f.sql.split(/;\n/)) {
            if (bytes(statement) > 100_000)
                notes.add(`${f.name}: a row over D1's 100,000-byte statement; it has to be moved by the Worker`);
        }
    }
    return { files, counts, notes: [...notes] };
}
/** Rows in an order where a row comes after the row its own column points to (from, to: indexes). */
function parentsFirst(rows, links) {
    const out = [];
    const done = new Set();
    const index = links.map(([, to]) => new Map(rows.map((r, i) => [r[to], i])));
    const visit = (i, path) => {
        if (done.has(i) || path.has(i))
            return;
        path.add(i);
        links.forEach(([from], l) => {
            const parent = rows[i][from] === null ? undefined : index[l].get(rows[i][from]);
            if (parent !== undefined && parent !== i)
                visit(parent, path);
        });
        path.delete(i);
        done.add(i);
        out.push(rows[i]);
    };
    rows.forEach((_, i) => visit(i, new Set()));
    return out;
}
/** How many rows each table has in Postgres, to compare after the import. */
export async function countRows(catalog, query) {
    if (!catalog.tables.length)
        return {};
    const parts = catalog.tables.map((t) => `select ${text(t.name)} as t, count(*)::int as n from public.${ident(t.name)}`).join(" union all ");
    const rows = await query(`select json_object_agg(t, n)::text as counts from (${parts}) x`);
    const counts = JSON.parse(String(rows[0]?.counts ?? "{}"));
    const people = await query("select count(*)::int as n from auth.users where coalesce(email, phone, '') <> ''");
    return { _base_user: Number(people[0]?.n ?? 0), ...counts };
}
