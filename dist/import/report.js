import { Unsupported, parseExpr, parseIndex } from "./pg.js";
import { admitted, planColumn, tableRule, toSqlite } from "./translate.js";
const ON = { r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
const quote = (n) => `"${n.replace(/"/g, '""')}"`;
export function buildReport(catalog, options = {}) {
    const items = [];
    const add = (area, name, level, note) => items.push({ area, name, level, note });
    const served = new Map(catalog.tables.map((t) => [t.name, t]));
    const columnsOf = (name) => served.get(name)?.columns.map((c) => c.name);
    const inlined = new Set();
    // ── Tables ──
    const ddl = [
        "-- A draft from `unisites-base import-supabase --report`: read it before it is a migration.",
        "-- Users are _base_user (unisites-base's own migrations come first).",
        "",
    ];
    const plans = new Map();
    for (const t of catalog.tables) {
        const constraints = t.constraints ?? [];
        const pk = constraints.find((k) => k.type === "p");
        const single = pk?.columns?.length === 1;
        const cols = t.columns.map((c) => planColumn(c, single && pk.columns[0] === c.name));
        plans.set(t.name, cols);
        const names = t.columns.map((c) => c.name);
        const lines = cols.map((c) => `  ${quote(c.name)} ${c.declaration}`);
        const notes = [];
        if (pk && !cols.some((c) => c.rowid))
            lines.push(`  PRIMARY KEY (${pk.columns.map(quote).join(", ")})`);
        if (!pk)
            notes.push("no primary key: the API needs one to get one row, and upsert one to collide on");
        for (const k of constraints) {
            if (k.type === "u")
                lines.push(`  UNIQUE (${k.columns.map(quote).join(", ")})`);
            else if (k.type === "f") {
                const ref = k.references;
                let target = null;
                if (ref.schema === "public")
                    target = ref.table;
                else if (ref.schema === "auth" && ref.table === "users")
                    target = "_base_user";
                if (!target || ref.columns.length !== k.columns.length) {
                    notes.push(`the foreign key ${k.name} to ${ref.schema}.${ref.table} is left out`);
                    continue;
                }
                if (target === "_base_user")
                    notes.push(`${k.columns.join(", ")} → auth.users becomes _base_user: users are moved before this table's rows`);
                const del = ON[ref.delete] ? ` ON DELETE ${ON[ref.delete]}` : "";
                const upd = ON[ref.update] ? ` ON UPDATE ${ON[ref.update]}` : "";
                lines.push(`  FOREIGN KEY (${k.columns.map(quote).join(", ")}) REFERENCES ${quote(target)} (${ref.columns.map(quote).join(", ")})${del}${upd}`);
            }
            else if (k.type === "c") {
                const m = /^CHECK \((.*)\)( NOT VALID)?$/s.exec(k.definition);
                try {
                    if (!m)
                        throw new Unsupported("a CHECK of another form");
                    lines.push(`  CHECK (${toSqlite(parseExpr(m[1]), names)})`);
                }
                catch (e) {
                    notes.push(`the check ${k.name} is left out (${e.message}): ${k.definition}`);
                }
            }
        }
        ddl.push(`CREATE TABLE ${quote(t.name)} (\n${lines.join(",\n")}\n);`);
        for (const ix of t.indexes ?? []) {
            try {
                const i = parseIndex(ix.definition);
                if (i.method !== "btree" && i.method !== "hash")
                    throw new Unsupported(`a ${i.method} index (full-text or array search)`);
                const parts = splitTop(i.items).map((part) => {
                    const m = /^("?[A-Za-z_][\w$]*"?)(?:\s+\w+_ops)?(\s+(?:ASC|DESC))?(\s+NULLS\s+(?:FIRST|LAST))?$/i.exec(part.trim());
                    if (m && names.includes(m[1].replace(/"/g, "")))
                        return `${quote(m[1].replace(/"/g, ""))}${m[2] ?? ""}`;
                    return toSqlite(parseExpr(part), names);
                });
                const where = i.where ? ` WHERE ${toSqlite(i.where, names)}` : "";
                ddl.push(`CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${quote(i.name)} ON ${quote(t.name)} (${parts.join(", ")})${where};`);
            }
            catch (e) {
                notes.push(`the index ${ix.name} is left out (${e.message})`);
            }
        }
        for (const c of cols)
            for (const n of c.notes)
                notes.push(`${c.name}: ${n}`);
        const level = cols.some((c) => c.level === "manual") || notes.some((n) => /left out/.test(n)) ? "manual" : cols.some((c) => c.level === "partial") ? "partial" : "auto";
        add("tables", t.name, level, [`${fmtRows(t.rows)}, ${fmtBytes(t.bytes)}`, ...notes].join("; "));
    }
    ddl.push("");
    // ── Triggers ──
    for (const t of catalog.tables) {
        for (const g of t.triggers ?? []) {
            const touch = /^\s*begin\s+new\.(\w+)\s*:?=\s*(now\(\)|current_timestamp|timezone\('utc'(::text)?,\s*now\(\)\));\s*return\s+new;\s*end;?\s*$/is.exec(g.source);
            if (touch && /BEFORE UPDATE/i.test(g.definition) && t.columns.some((c) => c.name === touch[1])) {
                const col = touch[1];
                ddl.push(`CREATE TRIGGER ${quote(`${t.name}_${g.name}`)} AFTER UPDATE ON ${quote(t.name)} FOR EACH ROW WHEN NEW.${quote(col)} IS OLD.${quote(col)} BEGIN\n` +
                    `  UPDATE ${quote(t.name)} SET ${quote(col)} = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE rowid = NEW.rowid;\nEND;`);
                add("triggers", `${t.name}.${g.name}`, "partial", `sets ${col} on every change: a SQLite trigger; Realtime's UPDATE shows the row before it`);
            }
            else
                add("triggers", `${t.name}.${g.name}`, "manual", `${g.function}() has to become the Worker's code, around the write: ${g.definition}`);
        }
    }
    // ── Rules ──
    const access = { tables: {} };
    const narrower = new Set();
    // Supabase's storage.objects is base's storage_objects (base_0005.sql): its policies are that table's
    // rules, with storage.foldername(name)[n] as folder<n>.
    const storageTable = catalog.buckets.length || catalog.policies.some((p) => p.schema === "storage") ? storageObjects() : null;
    if (storageTable)
        served.set(storageTable.name, storageTable);
    const policies = catalog.policies
        .filter((p) => p.schema === "public" || (p.schema === "storage" && p.table === "objects"))
        .map((p) => (p.schema === "storage" ? { ...p, schema: "public", table: "storage_objects" } : p));
    const ctx = { tables: served, policies, functions: catalog.functions, inlined, narrower };
    for (const t of storageTable ? [...catalog.tables, storageTable] : catalog.tables) {
        const policies = ctx.policies.filter((p) => p.table === t.name);
        const cols = plans.get(t.name) ?? t.columns.map((c) => planColumn(c, false));
        if (!t.rls) {
            add("rules", t.name, "manual", "row level security is off: in Supabase anyone with the anon key reads and writes it; the draft serves it to no one");
            continue;
        }
        if (!policies.length) {
            add("rules", t.name, "auto", "no policies: the browser reads nothing, the server's admin() everything, as before");
            continue;
        }
        const failed = new Set();
        narrower.clear();
        const fail = (what) => failed.add(what);
        const rules = {};
        const set = (k, v) => {
            if (v !== null)
                rules[k] = v;
        };
        set("list", tableRule(t.name, "list", ctx, fail));
        set("view", rules.list ?? null);
        set("create", tableRule(t.name, "create", ctx, fail));
        set("update", tableRule(t.name, "update", ctx, fail));
        const check = tableRule(t.name, "update", ctx, fail, "check");
        if (rules.update !== undefined && check !== rules.update) {
            // A change the check refuses is refused; without one, the update closes.
            if (check === null)
                delete rules.update;
            else
                set("updateCheck", check);
        }
        set("delete", tableRule(t.name, "delete", ctx, fail));
        // Column grants: hidden where a role that reads the table may not read the column, readonly
        // where a role that writes it may not set it (on create or on change).
        // Only the roles a command lets in count: a grant to a role no policy admits changes nothing.
        const readers = admitted(t, "list", ctx.policies);
        const creators = admitted(t, "create", ctx.policies);
        const changers = admitted(t, "update", ctx.policies);
        const hidden = t.columns.filter((c) => readers.some((r) => !c.grants[r]?.select)).map((c) => c.name);
        const keyCols = new Set((t.constraints ?? []).filter((k) => k.type === "p").flatMap((k) => k.columns ?? []));
        const fill = Object.fromEntries(cols.filter((c) => c.fill).map((c) => [c.name, c.fill]));
        const readonly = t.columns
            .filter((c) => !hidden.includes(c.name) && !Object.hasOwn(fill, c.name) && !cols.find((p) => p.name === c.name)?.rowid)
            .filter((c) => (rules.update !== undefined && changers.some((r) => !c.grants[r]?.update)) || (rules.create !== undefined && creators.some((r) => !c.grants[r]?.insert)))
            .map((c) => c.name);
        const both = (rs) => rs.length === 2;
        const differs = t.columns
            .filter((c) => (both(readers) && c.grants.anon?.select !== c.grants.authenticated?.select) || (both(changers) && c.grants.anon?.update !== c.grants.authenticated?.update) || (both(creators) && c.grants.anon?.insert !== c.grants.authenticated?.insert))
            .map((c) => c.name);
        if (hidden.length)
            rules.hidden = hidden;
        const ro = readonly.filter((c) => !keyCols.has(c) || !rules.update);
        if (ro.length && ro.length < t.columns.length)
            rules.readonly = ro;
        if (t === storageTable) {
            // The person uploading owns the file, as Supabase sets storage.objects.owner.
            fill.owner = "auth.id";
            rules.readonly = (rules.readonly ?? []).filter((c) => c !== "owner");
            if (!rules.readonly.length)
                delete rules.readonly;
        }
        if (Object.keys(fill).length)
            rules.fill = fill;
        access.tables[t.name] = rules;
        const notes = [];
        if (failed.size)
            notes.push(`not translated, so left closed: ${[...failed].join("; ")}`);
        if (hidden.length)
            notes.push(`hidden (a role that reads the table has no SELECT on them): ${hidden.join(", ")}`);
        const col = (c) => t.columns.find((x) => x.name === c);
        const oneWay = readonly.filter((c) => (rules.create !== undefined && creators.some((r) => col(c).grants[r]?.insert)) || (rules.update !== undefined && changers.some((r) => col(c).grants[r]?.update)));
        if (oneWay.length)
            notes.push(`readonly, though Postgres let a create or a change set them: ${oneWay.join(", ")}`);
        if (differs.length)
            notes.push(`anon and authenticated have different grants on ${differs.join(", ")}: the draft keeps the narrower`);
        notes.push(...narrower);
        const level = failed.size ? "manual" : oneWay.length || differs.length || narrower.size ? "partial" : "auto";
        add("rules", t.name, level, notes.join("; ") || `${policies.length} polic${policies.length === 1 ? "y" : "ies"}`);
    }
    for (const p of catalog.policies.filter((x) => x.schema === "storage" && x.table !== "objects"))
        add("storage", `policy ${p.name}`, "manual", `a policy on storage.${p.table}: buckets are set in access.json's "buckets"`);
    // ── Functions, views, realtime, storage, auth, extensions ──
    const triggerFns = new Set(catalog.tables.flatMap((t) => (t.triggers ?? []).map((g) => g.function)));
    for (const f of catalog.functions) {
        const called = options.rpc?.get(f.name);
        const where = called ? `; called at ${called.slice(0, 3).join(", ")}${called.length > 3 ? ", …" : ""}` : options.rpc ? "; the code does not call it" : "";
        if (inlined.has(f.name) && !called)
            add("functions", `${f.name}(${f.arguments})`, "auto", "inlined into the rules");
        else if (triggerFns.has(f.name))
            continue;
        else
            add("functions", `${f.name}(${f.arguments})`, "manual", `${f.language}${f.definer ? ", security definer" : ""}: a function of the Worker's (createRest's rpc), so supabase.rpc("${f.name}") keeps working${where}`);
    }
    for (const [name, at] of options.rpc ?? []) {
        if (!catalog.functions.some((f) => f.name === name))
            add("functions", name, "manual", `supabase.rpc("${name}") at ${at.slice(0, 3).join(", ")}, but the database has no such function`);
    }
    for (const v of catalog.views)
        add("views", v.name, "manual", "a view: SQLite has views, but the API serves tables; a list() or an rpc instead");
    for (const name of catalog.realtime) {
        const t = served.get(name);
        add("realtime", name, t?.replica === "f" ? "partial" : "auto", t?.replica === "f" ? "REPLICA IDENTITY FULL: an UPDATE's old row is its key only" : "postgres_changes through the room");
    }
    if (catalog.buckets.length)
        access.buckets = {};
    for (const b of catalog.buckets) {
        // Supabase checks no type for an empty list; unisites-base/storage would take none.
        access.buckets[b.id] = { public: b.public, fileSizeLimit: b.size_limit, allowedMimeTypes: b.mime_types?.length ? b.mime_types : null };
        add("storage", `bucket ${b.id}`, "auto", `${b.public ? "public" : "private"}, ${b.objects} files, ${fmtBytes(b.bytes)}: R2 (unisites-base/storage), files moved with import-supabase --files`);
    }
    const a = catalog.auth;
    add("sign-in", "users", "auto", `${a.users} people (${a.confirmed} confirmed, ${a.banned} blocked) into _base_user, with their ids, so auth.uid() stays auth.id`);
    if (a.passwords)
        add("sign-in", "passwords", a.bcrypt === a.passwords ? "auto" : "partial", `${a.bcrypt} of ${a.passwords} bcrypt: base signs them in and writes them again as scrypt`);
    for (const [provider, n] of Object.entries(a.providers ?? {})) {
        const known = ["email", "phone", "google"].includes(provider);
        add("sign-in", provider, known ? "auto" : "manual", known ? `${n} people` : `${n} people sign in with ${provider}, which base has not got`);
    }
    for (const [factor, n] of Object.entries(a.factors ?? {}))
        add("sign-in", `second factor ${factor}`, "partial", `${n} factors: base has TOTP; whether the secrets move is checked during the import`);
    const notable = {
        pg_cron: "scheduled SQL: Cron Triggers on the Worker",
        pg_net: "HTTP from SQL: fetch() in the Worker",
        http: "HTTP from SQL: fetch() in the Worker",
        vector: "vectors: Cloudflare Vectorize",
        postgis: "geography: no counterpart",
        pgsodium: "encryption in the database: Worker secrets",
        supabase_vault: "Vault's secrets: Worker secrets",
        pg_trgm: "trigram search: no counterpart",
    };
    for (const x of catalog.extensions)
        if (notable[x])
            add("extensions", x, "manual", notable[x]);
    for (const f of catalog.edgeFunctions ?? [])
        add("edge functions", f.slug, "manual", "a route of the Worker's");
    const total = catalog.tables.reduce((n, t) => n + t.bytes, 0);
    if (total > 8 * 1024 ** 3)
        add("tables", "size", "manual", `${fmtBytes(total)}: one D1 database holds 10 GB; a database for each tenant (a Durable Object)`);
    for (const c of options.code ?? [])
        add("code", c.what, c.level, `${c.note} (${c.at.length}×: ${c.at.slice(0, 5).join(", ")}${c.at.length > 5 ? ", …" : ""})`);
    if (options.vercel)
        for (const v of vercelItems(options.vercel))
            items.push(v);
    const schema = ddl.join("\n\n").replace(/\n{3,}/g, "\n\n");
    if (options.verify)
        items.push(...options.verify(schema, access));
    return { items, schema, access, markdown: markdown(catalog, items, options) };
}
function splitTop(s) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === "(")
            depth++;
        else if (s[i] === ")")
            depth--;
        else if (s[i] === "," && depth === 0) {
            out.push(s.slice(start, i));
            start = i + 1;
        }
    }
    out.push(s.slice(start));
    return out;
}
function vercelItems(v) {
    const out = [];
    const cfg = v;
    for (const c of cfg.crons ?? [])
        out.push({ area: "vercel", name: `cron ${c.path}`, level: "auto", note: `${c.schedule}: a Cron Trigger calling the same route` });
    if (cfg.rewrites?.length)
        out.push({ area: "vercel", name: "rewrites", level: "partial", note: `${cfg.rewrites.length}: worker.config.json (a later step) or the Worker's routes` });
    if (cfg.redirects?.length)
        out.push({ area: "vercel", name: "redirects", level: "partial", note: `${cfg.redirects.length}: the Worker's routes` });
    if (cfg.headers?.length)
        out.push({ area: "vercel", name: "headers", level: "partial", note: `${cfg.headers.length}: the Worker sets them` });
    for (const [path, f] of Object.entries(cfg.functions ?? {})) {
        if ((f.maxDuration ?? 0) > 30)
            out.push({ area: "vercel", name: path, level: "partial", note: `runs up to ${f.maxDuration} s: a Worker waits as long, but its CPU time is 30 s (5 min when raised); long work goes to a Queue` });
    }
    return out;
}
const LEVELS = { auto: "moves by itself", partial: "moves, with a difference", manual: "by hand" };
function markdown(c, items, options) {
    const areas = [...new Set(items.map((i) => i.area))];
    const count = (area, level) => items.filter((i) => i.area === area && i.level === level).length;
    const lines = [
        `# ${options.project ? `${options.project}: ` : ""}moving from Supabase to Unisites`,
        "",
        `Read from Postgres ${c.version}: ${c.tables.length} tables, ${c.policies.length} policies, ${c.functions.length} functions, ${c.auth.users} people.`,
        "Nothing was changed, in Supabase or here: `schema.sql` and `access.json` beside this report are drafts.",
        "`catalog.json` holds the functions' and triggers' source as Supabase has it, so it is kept out of git (`.gitignore`).",
        "",
        "| | moves by itself | with a difference | by hand |",
        "| --- | --- | --- | --- |",
        ...areas.map((a) => `| ${a} | ${count(a, "auto")} | ${count(a, "partial")} | ${count(a, "manual")} |`),
        "",
    ];
    for (const area of areas) {
        lines.push(`## ${area[0].toUpperCase()}${area.slice(1)}`, "");
        for (const level of ["manual", "partial", "auto"]) {
            const these = items.filter((i) => i.area === area && i.level === level);
            if (!these.length)
                continue;
            lines.push(`**${LEVELS[level]}**`, "");
            for (const i of these)
                lines.push(`- \`${i.name}\`: ${i.note}`);
            lines.push("");
        }
    }
    return lines.join("\n");
}
function fmtRows(n) {
    return `${n.toLocaleString("en")} row${n === 1 ? "" : "s"}`;
}
function fmtBytes(n) {
    if (n < 1024 * 1024)
        return `${Math.round(n / 1024)} KB`;
    if (n < 1024 ** 3)
        return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
/** base's storage_objects (base_0005.sql), as a table of the catalog, for the storage policies to be rules of. */
function storageObjects() {
    const all = { select: true, insert: true, update: true, delete: true };
    const col = (name, udt = "text") => ({ name, type: udt, udt, category: "S", notnull: false, default: null, identity: null, generated: null, enum: null, grants: { anon: { select: true, insert: true, update: true }, authenticated: { select: true, insert: true, update: true } } });
    return {
        name: "storage_objects",
        rls: true,
        rows: 0,
        bytes: 0,
        replica: "d",
        privileges: { anon: all, authenticated: all },
        columns: [col("id"), col("bucket_id"), col("name"), col("owner"), col("folder1"), col("folder2"), col("folder3"), col("size", "int8"), col("mime_type"), col("cache_control"), col("created_at", "timestamptz"), col("updated_at", "timestamptz")],
        constraints: [{ name: "storage_objects_pkey", type: "p", columns: ["id"], references: null, definition: "PRIMARY KEY (id)" }],
        indexes: [],
        triggers: [],
    };
}
