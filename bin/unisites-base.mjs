#!/usr/bin/env node
// npx unisites-base migrations [dir]
//   copies base's migrations into the project's migrations folder (default
//   ./migrations), so Unisites applies them on deploy with the project's own.
//   A file already there with the same content is left; a different one is
//   an error, never overwritten.
//
// npx unisites-base check [project]
//   checks the project's access rules (access.json, or worker.config.json's
//   "access") against its migrations, and lists every place in its code that
//   reads the database without them (data.admin(), env.DB). Exits 1 on an
//   error; warnings and those places are for a person to read.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const [command, arg] = process.argv.slice(2);

if (command === "migrations") migrations(arg ?? "migrations");
else if (command === "check") await check(arg ?? ".");
else {
  console.error("npx unisites-base migrations [dir]\nnpx unisites-base check [project]");
  process.exit(2);
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
