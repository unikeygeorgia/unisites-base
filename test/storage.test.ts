import { createClient } from "@supabase/supabase-js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createData, type Exec } from "../src/data.ts";
import { createStorage, type Files } from "../src/storage.ts";

// supabase-js's storage, unchanged, against /storage/v1 on R2 (kept in memory), with rules shaped as
// Unichat's storage policies: a file goes into t/<space>/… only for the space's members, and only
// its owner changes or removes it.
const ORIGIN = "https://app.test";
const SERVICE = "service-key-for-the-server-code-only-0123456789";
const T = "t1";

function app() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/base_0005.sql", import.meta.url), "utf8"));
  db.exec(`create table memberships (tenant_id text, user_id text); insert into memberships values ('${T}', 'ana'), ('${T}', 'beka');`);
  const exec: Exec = async (sql, params) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  const member = "folder1 = 't' && exists(memberships, tenant_id = row.folder2 && user_id = auth.id)";
  const data = createData({
    exec,
    access: {
      tables: {
        storage_objects: { list: `(${member}) || owner = auth.id`, create: member, update: "owner = auth.id", delete: "owner = auth.id", fill: { owner: "auth.id" } },
        memberships: { list: "user_id = auth.id" },
      },
    },
  });
  const bytes = new Map<string, { body: Uint8Array; type?: string; cache?: string }>();
  const r2: Files = {
    put: async (key, value, o) => void bytes.set(key, { body: new Uint8Array(value as ArrayBuffer), type: o?.httpMetadata?.contentType, cache: o?.httpMetadata?.cacheControl }),
    get: async (key) => {
      const b = bytes.get(key);
      return b ? { body: new Response(b.body as BodyInit).body, size: b.body.byteLength, httpMetadata: { contentType: b.type, cacheControl: b.cache } } : null;
    },
    delete: async (keys) => void (Array.isArray(keys) ? keys : [keys]).forEach((k) => bytes.delete(k)),
  };
  const storage = createStorage({
    r2,
    data,
    auth: async (r) => (r.headers.get("x-test-user") ? { id: r.headers.get("x-test-user")! } : null),
    admin: (r) => r.headers.get("authorization") === `Bearer ${SERVICE}`,
    buckets: { media: { public: true, fileSizeLimit: 1024 * 1024, allowedMimeTypes: ["image/*", "text/plain"] }, private: {} },
    secret: "a-test-secret-that-is-long-enough-123",
  });
  const fetcher = (input: RequestInfo | URL, init?: RequestInit) => storage.handler(new Request(input, init));
  const client = (user?: string) =>
    createClient(ORIGIN, "unisites", { auth: { persistSession: false }, global: { headers: user ? { "x-test-user": user } : {}, fetch: fetcher } }).storage;
  const server = createClient(ORIGIN, SERVICE, { auth: { persistSession: false }, global: { fetch: fetcher } }).storage;
  const png = (n = 8) => new File([new Uint8Array(n).fill(7)], "a.png", { type: "image/png" });
  return { db, bytes, client, server, fetcher, png };
}

describe("/storage/v1", () => {
  it("lets a member upload into the space's folder, and serves a public bucket's file to anyone", async () => {
    const { client, bytes, fetcher, png, db } = app();
    const up = await client("ana").from("media").upload(`t/${T}/2026-11-04/a.png`, png(), { cacheControl: "31536000", upsert: false });
    expect(up.error).toBeNull();
    expect(up.data?.fullPath).toBe(`media/t/${T}/2026-11-04/a.png`);
    expect(bytes.get(`media/t/${T}/2026-11-04/a.png`)?.type).toBe("image/png");
    expect(db.prepare("select owner, folder1, folder2, size from storage_objects").get()).toEqual({ owner: "ana", folder1: "t", folder2: T, size: 8 });
    const url = client().from("media").getPublicUrl(`t/${T}/2026-11-04/a.png`).data.publicUrl;
    const res = await fetcher(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("max-age=31536000");
    expect((await res.arrayBuffer()).byteLength).toBe(8);
  });

  it("refuses an upload outside one's spaces, of a type or size the bucket refuses, and a path that climbs", async () => {
    const { client, bytes, png } = app();
    expect((await client("gio").from("media").upload(`t/${T}/x.png`, png())).error).toBeTruthy();
    expect((await client().from("media").upload(`t/${T}/x.png`, png())).error).toBeTruthy();
    expect((await client("ana").from("media").upload(`t/${T}/x.exe`, new File(["x"], "x.exe", { type: "application/x-msdownload" }))).error).toBeTruthy();
    expect((await client("ana").from("media").upload(`t/${T}/big.png`, png(2 * 1024 * 1024))).error).toBeTruthy();
    expect((await client("ana").from("media").upload(`t/${T}/../../etc.png`, png())).error).toBeTruthy();
    expect((await client("ana").from("nope").upload(`t/${T}/a.png`, png())).error).toBeTruthy();
    expect(bytes.size).toBe(0);
  });

  it("changes a file only for its owner, and says a duplicate without upsert", async () => {
    const { client, png, bytes } = app();
    const path = `t/${T}/a.png`;
    await client("ana").from("media").upload(path, png(8));
    expect((await client("ana").from("media").upload(path, png(9))).error).toBeTruthy();
    expect((await client("beka").from("media").upload(path, png(10), { upsert: true })).error).toBeTruthy();
    expect(bytes.get(`media/${path}`)?.body.byteLength).toBe(8);
    expect((await client("ana").from("media").upload(path, png(11), { upsert: true })).error).toBeNull();
    expect(bytes.get(`media/${path}`)?.body.byteLength).toBe(11);
  });

  it("removes only what the rules let remove, and its bytes with it", async () => {
    const { client, bytes, png } = app();
    await client("ana").from("media").upload(`t/${T}/a.png`, png());
    const theirs = await client("beka").from("media").remove([`t/${T}/a.png`]);
    expect(theirs.data).toEqual([]);
    expect(bytes.size).toBe(1);
    const mine = await client("ana").from("media").remove([`t/${T}/a.png`]);
    expect(mine.data?.map((o) => o.name)).toEqual([`t/${T}/a.png`]);
    expect(bytes.size).toBe(0);
  });

  it("signs only files one may read, and refuses a signature that is not ours", async () => {
    const { client, server, fetcher, png } = app();
    await client("ana").from("private").upload(`t/${T}/doc.png`, png()).catch(() => undefined);
    await server.from("private").upload(`t/${T}/doc.txt`, new Blob(["secret"], { type: "text/plain" }));
    const signedByMember = await client("beka").from("private").createSignedUrls([`t/${T}/doc.txt`, `t/other/none.txt`], 60);
    expect(signedByMember.data?.[0]?.signedUrl).toBeTruthy();
    expect(signedByMember.data?.[1]?.error).toBeTruthy();
    const ok = await fetcher(signedByMember.data![0]!.signedUrl!);
    expect(await ok.text()).toBe("secret");
    const forged = signedByMember.data![0]!.signedUrl!.replace(/token=\d+\./, "token=9999999999.");
    expect((await fetcher(forged)).status).toBe(400);
    expect((await client("gio").from("private").createSignedUrls([`t/${T}/doc.txt`], 60)).data?.[0]?.error).toBeTruthy();
    // A private bucket is never public, and a stranger's download is refused.
    expect((await fetcher(client().from("private").getPublicUrl(`t/${T}/doc.txt`).data.publicUrl)).status).toBe(400);
    expect((await client("gio").from("private").download(`t/${T}/doc.txt`)).error).toBeTruthy();
    expect(await (await client("beka").from("private").download(`t/${T}/doc.txt`)).data?.text()).toBe("secret");
  });

  it("lets the server's own code upload a raw body, as the service role does", async () => {
    const { server, bytes, db } = app();
    const up = await server.from("media").upload(`c/avatar.jpg`, new Uint8Array([1, 2, 3]), { contentType: "image/jpeg", upsert: true });
    expect(up.error).toBeNull();
    expect(bytes.get("media/c/avatar.jpg")?.type).toBe("image/jpeg");
    expect(db.prepare("select owner from storage_objects where name = 'c/avatar.jpg'").get()).toEqual({ owner: null });
    expect((await server.from("media").upload(`c/avatar.jpg`, new Uint8Array([4]), { contentType: "image/jpeg", upsert: true })).error).toBeNull();
    expect(bytes.get("media/c/avatar.jpg")?.body.byteLength).toBe(1);
  });
});

describe("multipart (supabase-js's upload body)", () => {
  it("reads a file part with an empty name, binary bytes intact, and cacheControl", async () => {
    const { multipart } = await import("../src/storage.ts");
    const audio = new Uint8Array([0x1a, 0x45, 0x0d, 0x0a, 0x0d, 0x0a, 0x2d, 0x2d, 0xff, 0x00]);
    const b = "----x";
    const enc = new TextEncoder();
    const body = new Uint8Array([
      ...enc.encode(`--${b}\r\nContent-Disposition: form-data; name="cacheControl"\r\n\r\n31536000\r\n`),
      ...enc.encode(`--${b}\r\nContent-Disposition: form-data; name=""; filename="a.webm"\r\nContent-Type: audio/webm\r\n\r\n`),
      ...audio,
      ...enc.encode(`\r\n--${b}--\r\n`),
    ]);
    const parts = multipart(body, `multipart/form-data; boundary=${b}`);
    expect(parts.map((p) => [p.name, p.filename, p.type])).toEqual([["cacheControl", null, null], ["", "a.webm", "audio/webm"]]);
    expect([...parts[1]!.body]).toEqual([...audio]);
    expect(new TextDecoder().decode(parts[0]!.body)).toBe("31536000");
  });
});
