#!/usr/bin/env node
// npx unisites-base migrations [dir]
//   copies base's migrations into the project's migrations folder (default
//   ./migrations), so Unisites applies them on deploy with the project's own.
//   A file already there with the same content is left; a different one is
//   an error, never overwritten.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [command, dir = "migrations"] = process.argv.slice(2);
if (command !== "migrations") {
  console.error("npx unisites-base migrations [dir]");
  process.exit(2);
}
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
