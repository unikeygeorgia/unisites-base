import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { createData, type Exec } from "../src/data.ts";
import { copyFiles } from "../src/import/files.ts";
import { createStorage, type Files } from "../src/storage.ts";

// import-supabase --files: storage.objects read from Postgres (PGlite), the bytes fetched from a
// Supabase-shaped source, and uploaded to a project's /storage/v1 (kept in memory) with its key.
const SOURCE = "https://ref.supabase.co";
const TARGET = "https://new.test";
const SERVICE = "service-key-for-the-server-code-only-0123456789";
const SUPABASE_KEY = "supabase-service-role";

async function setup() {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL("./support/supabase.sql", import.meta.url), "utf8").split("-- A Unichat-shaped project")[0]!);
  await pg.exec(`insert into storage.objects (id, bucket_id, name, metadata) values
    ('30000000-0000-0000-0000-000000000002', 'media', 't/x/doc.png', '{"size": 4, "mimetype": "image/png"}'),
    ('30000000-0000-0000-0000-000000000003', 'avatars', 'gone.png', '{"size": 2}');`);
  const source = new Map([
    ["/storage/v1/object/public/avatars/a/1.png", new Uint8Array(1200).fill(1)],
    ["/storage/v1/object/authenticated/media/t/x/doc.png", new Uint8Array([1, 2, 3, 4])],
  ]);

  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/base_0005.sql", import.meta.url), "utf8"));
  const exec: Exec = async (sql, params) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  const data = createData({ exec, access: { tables: { storage_objects: {} } } });
  const bytes = new Map<string, Uint8Array>();
  const r2: Files = {
    put: async (key, value) => void bytes.set(key, new Uint8Array(value as ArrayBuffer)),
    get: async (key) => {
      const b = bytes.get(key);
      return b ? { body: new Response(b as BodyInit).body, size: b.byteLength, httpMetadata: {} } : null;
    },
    delete: async () => undefined,
  };
  const storage = createStorage({
    r2,
    data,
    auth: async () => null,
    admin: (r) => r.headers.get("authorization") === `Bearer ${SERVICE}`,
    buckets: { avatars: { public: true }, media: {} },
    secret: "a-test-secret-that-is-long-enough-123",
  });
  const asked: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === TARGET) return storage.handler(new Request(url, init));
    asked.push(url.pathname);
    // A private bucket's file needs Supabase's service key.
    if (url.pathname.includes("/authenticated/") && new Headers(init?.headers).get("authorization") !== `Bearer ${SUPABASE_KEY}`) return new Response("no", { status: 400 });
    const b = source.get(url.pathname);
    return b ? new Response(b as BodyInit, { headers: { "content-type": "application/octet-stream" } }) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  const run = () =>
    copyFiles({ query: async (sql) => (await pg.query(sql)).rows as Record<string, unknown>[], source: SOURCE, sourceKey: SUPABASE_KEY, target: TARGET, targetKey: SERVICE, fetch: fetcher });
  return { db, bytes, asked, run };
}

describe("copying the files", () => {
  it("copies each file to where its row says, says which it could not, and goes on where it stopped", async () => {
    const { db, bytes, asked, run } = await setup();
    const first = await run();
    expect(first).toMatchObject({ copied: 2, skipped: 0, bytes: 1204 });
    expect(first.failed).toEqual([{ bucket: "avatars", name: "gone.png", why: "Supabase answered 404" }]);
    expect(bytes.get("avatars/a/1.png")?.byteLength).toBe(1200);
    expect([...bytes.get("media/t/x/doc.png")!]).toEqual([1, 2, 3, 4]);
    expect(db.prepare("select bucket_id, name, size, mime_type from storage_objects order by name").all()).toEqual([
      { bucket_id: "avatars", name: "a/1.png", size: 1200, mime_type: "application/octet-stream" },
      { bucket_id: "media", name: "t/x/doc.png", size: 4, mime_type: "image/png" },
    ]);
    // Again: what is there with its size is left, and only the missing one is asked for.
    asked.length = 0;
    const again = await run();
    expect(again).toMatchObject({ copied: 0, skipped: 2 });
    expect(asked).toEqual(["/storage/v1/object/public/avatars/gone.png"]);
  });
});
