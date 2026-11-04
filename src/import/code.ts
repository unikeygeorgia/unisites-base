import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { CodeUse } from "./report.ts";

/**
 * What the project's code asks of supabase-js, from its text: what /rest/v1, Realtime and base
 * answer as it is, and what has to be written again. Node only.
 */
const LOOK: { what: string; re: RegExp; level: CodeUse["level"]; note: string }[] = [
  { what: "from()", re: /\.from\(\s*["'`]/g, level: "auto", note: "/rest/v1 answers it" },
  { what: "channel() postgres_changes", re: /["'`]postgres_changes["'`]/g, level: "auto", note: "the room answers it" },
  { what: "contains / containedBy / overlaps", re: /\.(contains|containedBy|overlaps)\(/g, level: "manual", note: "array and JSON containment is not served yet" },
  { what: "textSearch", re: /\.textSearch\(/g, level: "manual", note: "full-text search is a later step" },
  { what: "!inner", re: /!inner\b/g, level: "manual", note: "an inner embed: filter the parent in the code, or an rpc" },
  { what: "csv / explain / geojson", re: /\.(csv|explain|geojson)\(/g, level: "manual", note: "not served" },
  { what: "broadcast / presence", re: /["'`](broadcast|presence)["'`]/g, level: "manual", note: "Realtime's broadcast and presence are not served yet" },
  { what: "storage", re: /\.storage\s*\.\s*from\(/g, level: "manual", note: "files move to R2 (a later step)" },
  { what: "functions.invoke", re: /\.functions\s*\.\s*invoke\(/g, level: "manual", note: "an Edge Function: a route of the Worker's" },
  { what: "auth sign-in", re: /\.auth\s*\.\s*(signInWithPassword|signInWithOtp|signInWithOAuth|signInWithIdToken|signUp|verifyOtp|resetPasswordForEmail|updateUser|signOut|mfa)\b/g, level: "partial", note: "base's sign-in (better-auth's client): the same ways in, other calls" },
  { what: "auth session", re: /\.auth\s*\.\s*(getSession|getUser|onAuthStateChange|refreshSession|setSession)\b/g, level: "partial", note: "base's session: a cookie, so most of these become one getSession()" },
  { what: "service role", re: /SERVICE_ROLE|service_role/g, level: "partial", note: "the server's admin(): no rules, as before" },
];

const SKIP = new Set(["node_modules", "dist", "build", ".git", ".wrangler", ".next", ".vercel", "coverage", "android", "ios"]);

/** Every line of the project's own code, with where it is. */
function* lines(root: string, dir = root): Generator<{ line: string; at: string }> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) yield* lines(root, path);
    else if (/\.(m?[jt]sx?|vue|svelte|astro)$/.test(name) && !/\.(test|spec)\./.test(name) && st.size < 2_000_000) {
      const text = readFileSync(path, "utf8").split("\n");
      for (let i = 0; i < text.length; i++) yield { line: text[i]!, at: `${relative(root, path)}:${i + 1}` };
    }
  }
}

export function scanCode(root: string): CodeUse[] {
  const found = new Map<string, string[]>();
  for (const { line, at } of lines(root)) {
    for (const l of LOOK) {
      l.re.lastIndex = 0;
      if (l.re.test(line)) found.set(l.what, [...(found.get(l.what) ?? []), at]);
    }
  }
  return LOOK.filter((l) => found.has(l.what)).map((l) => ({ what: l.what, level: l.level, note: l.note, at: found.get(l.what)! }));
}

/** supabase.rpc("name") calls, for the functions they need. */
export function rpcCalls(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { line, at } of lines(root)) for (const m of line.matchAll(/\.rpc\(\s*["'`](\w+)["'`]/g)) out.set(m[1]!, [...(out.get(m[1]!) ?? []), at]);
  return out;
}
