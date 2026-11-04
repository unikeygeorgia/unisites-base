#!/usr/bin/env node
// npx unisites-base migrations [dir]
//   copies base's migrations into the project's migrations folder (default
//   ./migrations), so Unisites applies them on deploy with the project's own.
//   A file already there with the same content is left; a different one is
//   an error, never overwritten.
//
// npx unisites-base import-supabase --report [--project <ref> | --catalog <file>] [--code <dir>] [--out <dir>]
//   reads a Supabase project's catalog (its tables, policies, functions, triggers, realtime,
//   buckets and sign-in counts; never a row of its data, and it changes nothing there) and writes
//   a report of what moves by itself, what partly and what by hand, with drafts of schema.sql and
//   access.json, into ./supabase-import. --project reads it through Supabase's Management API
//   (SUPABASE_ACCESS_TOKEN); --catalog takes the answer of `import-supabase --sql`, run in
//   Supabase's SQL editor.
//
// npx unisites-base check [project]
//   checks the project's access rules (access.json, or worker.config.json's
//   "access") against its migrations, and lists every place in its code that
//   reads the database without them (data.admin(), env.DB). Exits 1 on an
//   error; warnings and those places are for a person to read.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const [command, arg] = process.argv.slice(2);

if (command === "migrations") migrations(arg ?? "migrations");
else if (command === "check") await check(arg ?? ".");
else if (command === "import-supabase") await importSupabase(process.argv.slice(3));
else {
  console.error(
    "npx unisites-base migrations [dir]\nnpx unisites-base check [project]\n" +
      "npx unisites-base import-supabase --report [--project <ref> | --catalog <file>] [--code <dir>] [--out <dir>]\nnpx unisites-base import-supabase --sql",
  );
  process.exit(2);
}

async function importSupabase(args) {
  const { CATALOG_SQL } = await import("../dist/import/catalog.js");
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args.includes("--sql")) {
    console.log(CATALOG_SQL.trim());
    return;
  }
  if (!args.includes("--report")) {
    console.error("only --report so far: it reads, writes a report and drafts, and changes nothing");
    process.exit(2);
  }
  const { buildReport } = await import("../dist/import/report.js");
  const { verifyDrafts } = await import("../dist/import/verify.js");
  const { scanCode, rpcCalls } = await import("../dist/import/code.js");

  let catalog;
  const ref = flag("project");
  if (flag("catalog")) {
    const raw = JSON.parse(readFileSync(flag("catalog"), "utf8"));
    // The SQL editor's answer is a row with one column; the catalog itself is that column.
    catalog = Array.isArray(raw) ? (raw[0]?.catalog ?? raw[0]) : (raw.catalog ?? raw);
  } else if (ref) {
    const token = process.env.SUPABASE_ACCESS_TOKEN;
    if (!token) {
      console.error("SUPABASE_ACCESS_TOKEN: a personal access token (supabase.com/dashboard/account/tokens)");
      process.exit(2);
    }
    if (!/^[a-z0-9]{20}$/.test(ref)) {
      console.error(`${ref}: a project's ref is its 20 letters, as in <ref>.supabase.co`);
      process.exit(2);
    }
    const api = (path, init) =>
      fetch(`https://api.supabase.com/v1/projects/${ref}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    const res = await api("/database/query", { method: "POST", body: JSON.stringify({ query: CATALOG_SQL }) });
    if (!res.ok) {
      console.error(`Supabase answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      process.exit(1);
    }
    catalog = (await res.json())[0].catalog;
    const fns = await api("/functions");
    if (fns.ok) catalog.edgeFunctions = (await fns.json()).map((f) => ({ slug: f.slug, name: f.name }));
  } else {
    console.error("--project <ref> or --catalog <file>");
    process.exit(2);
  }

  const code = flag("code") ?? ".";
  const vercelFile = join(code, "vercel.json");
  const all = buildReport(catalog, {
    project: ref ?? flag("name"),
    code: scanCode(code),
    rpc: rpcCalls(code),
    vercel: existsSync(vercelFile) ? JSON.parse(readFileSync(vercelFile, "utf8")) : undefined,
    verify: verifyDrafts,
  });

  const out = flag("out") ?? "supabase-import";
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "report.md"), all.markdown);
  writeFileSync(join(out, "schema.sql"), all.schema);
  writeFileSync(join(out, "access.json"), JSON.stringify(all.access, null, 2) + "\n");
  // The catalog holds every function's and trigger's source, where a key may be written: never in git.
  writeFileSync(join(out, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
  writeFileSync(join(out, ".gitignore"), "catalog.json\n");
  const n = (level) => all.items.filter((i) => i.level === level).length;
  console.log(`${n("auto")} move by themselves, ${n("partial")} with a difference, ${n("manual")} by hand`);
  console.log(`${join(out, "report.md")}, schema.sql, access.json (drafts; nothing was changed)`);
}

function migrations(dir) {
  const source = new URL("../migrations/", import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  let copied = 0;
  for (const file of readdirSync(source).filter((f) => f.endsWith(".sql")).sort()) {
    const target = join(dir, file);
    if (existsSync(target)) {
      if (readFileSync(target, "utf8") !== readFileSync(join(source, file), "utf8")) {
        console.error(`${target} differs from unisites-base's; it is never overwritten`);
        process.exit(1);
      }
      continue;
    }
    copyFileSync(join(source, file), target);
    copied++;
    console.log(`+ ${target}`);
  }
  console.log(copied ? `${copied} migration(s) copied` : "migrations are up to date");
}

async function check(root) {
  const { checkAccess } = await import("../dist/access.js");
  const { DatabaseSync } = await import("node:sqlite");

  let access = null;
  const accessFile = join(root, "access.json");
  const configFile = join(root, "worker.config.json");
  if (existsSync(accessFile)) access = JSON.parse(readFileSync(accessFile, "utf8"));
  else if (existsSync(configFile)) access = JSON.parse(readFileSync(configFile, "utf8")).access ?? null;

  // The schema as D1 will have it: the project's migrations, in order, on an empty SQLite.
  let schema;
  const migrationsDir = join(root, "migrations");
  if (existsSync(migrationsDir)) {
    const db = new DatabaseSync(":memory:");
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      try {
        db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      } catch (e) {
        console.error(`error  migrations/${file}: ${e.message}`);
        process.exitCode = 1;
      }
    }
    schema = new Map();
    for (const { name } of db.prepare("select name from sqlite_master where type = 'table'").all()) {
      schema.set(name, new Set(db.prepare(`pragma table_info("${name.replaceAll('"', '""')}")`).all().map((c) => c.name)));
    }
  }

  if (access) {
    const found = checkAccess(access, schema);
    for (const f of found) console.log(`${f.level.padEnd(9)}${f.table}: ${f.message}`);
    if (found.some((f) => f.level === "error")) process.exitCode = 1;
    const tables = Object.keys(access.tables ?? {}).length;
    console.log(`${tables} table(s) with rules${schema ? `, ${schema.size} in the migrations` : ", no migrations folder"}`);
  } else {
    console.log("no access rules (access.json or worker.config.json's \"access\"): the data API serves no table");
  }

  // Reads without rules: allowed, but each one is the project's own promise.
  const raw = [];
  const skip = new Set(["node_modules", "dist", ".git", ".wrangler", "migrations"]);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(m?[jt]sx?)$/.test(name)) {
        readFileSync(path, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (/\.admin\(\)|\benv\.DB\b/.test(line)) raw.push(`${relative(root, path)}:${i + 1}: ${line.trim().slice(0, 120)}`);
          });
      }
    }
  };
  walk(root);
  if (raw.length) {
    console.log(`\n${raw.length} place(s) read the database without the rules; each must be server code that never takes the table, column or filter from a request:`);
    for (const r of raw) console.log(`  ${r}`);
  }
}
