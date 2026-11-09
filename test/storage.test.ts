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
    buckets: {
      media: { public: true, fileSizeLimit: 1024 * 1024, allowedMimeTypes: ["image/*", "text/plain"] },
      voice: { public: true, allowedMimeTypes: ["audio/*", "Video/MP4"] },
      // As access.json says "any type" (the report writes it so).
      private: { fileSizeLimit: null, allowedMimeTypes: null },
      closed: { allowedMimeTypes: [] },
    },
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

// A declared type is kept as one lowercase type/subtype without its parameters, so what a bucket's
// list checks is what is kept and served: "audio/webm, text/html" once passed "audio/*" by its
// prefix, and was served back with both types.
describe("a file's declared type", () => {
  const status = (r: { error: unknown }) => (r.error as { status?: number } | null)?.status;
  const page = "<p>Your session ended. <a href=https://example.test/>Sign in again</a></p>";
  const enc = new TextEncoder();
  /** A form as storage-js sends it, its file part declaring `type`. */
  const form = (type: string) => {
    const b = "----t";
    return {
      headers: { "content-type": `multipart/form-data; boundary=${b}` },
      body: enc.encode(
        `--${b}\r\nContent-Disposition: form-data; name="cacheControl"\r\n\r\n3600\r\n` +
          `--${b}\r\nContent-Disposition: form-data; name=""; filename="a"\r\nContent-Type: ${type}\r\n\r\n${page}\r\n--${b}--\r\n`,
      ),
    };
  };

  it("refuses two types in one, in a form (a File) and in a raw body", async () => {
    const { client, fetcher, bytes, db } = app();
    const two = "audio/webm, text/html";
    // supabase-js sends a File as a form, its type as the part's Content-Type …
    expect(status(await client("ana").from("voice").upload(`t/${T}/a.webm`, new File([page], "a.webm", { type: two })))).toBe(415);
    // … and anything else as a raw body, contentType as the request's Content-Type.
    expect(status(await client("ana").from("voice").upload(`t/${T}/b.webm`, enc.encode(page), { contentType: two }))).toBe(415);
    // A bucket that takes any type refuses it too, and so does a form written by hand.
    expect(status(await client("ana").from("private").upload(`t/${T}/c.webm`, new File([page], "c.webm", { type: two })))).toBe(415);
    const f = form(`${two}; charset=utf-8`);
    const res = await fetcher(`${ORIGIN}/storage/v1/object/voice/t/${T}/d.webm`, { method: "POST", body: f.body, headers: { ...f.headers, "x-test-user": "ana" } });
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([415, "invalid_mime_type"]);
    expect(bytes.size).toBe(0);
    expect(db.prepare("select count(*) as n from storage_objects").get()).toEqual({ n: 0 });
    // One type of the family is still taken, and a list's names compare without case.
    expect((await client("ana").from("voice").upload(`t/${T}/e.webm`, new File([new Uint8Array(4)], "e.webm", { type: "audio/webm" }))).error).toBeNull();
    expect((await client("ana").from("voice").upload(`t/${T}/f.mp4`, new File([new Uint8Array(4)], "f.mp4", { type: "video/mp4" }))).error).toBeNull();
  });

  it("refuses every declaration that is not one type/subtype, in every bucket", async () => {
    const { fetcher, bytes } = app();
    const post = (type: string) =>
      fetcher(`${ORIGIN}/storage/v1/object/private/t/${T}/x.bin`, { method: "POST", headers: { "x-test-user": "ana", "content-type": type }, body: enc.encode(page) });
    // A second Content-Type header reaches a Worker as the first, a comma and the second.
    const refused = ["audio/webm,text/html", "audio/webm text/html", "audio/webm/html", "image/*", "*/*", "audio", "audio/", "/webm", "; charset=utf-8"];
    for (const type of refused) {
      const res = await post(type);
      expect([type, res.status, ((await res.json()) as { error: string }).error]).toEqual([type, 415, "invalid_mime_type"]);
    }
    expect(bytes.size).toBe(0);
  });

  it("keeps and serves the type lowercase, without its parameters, from a form and from a raw body", async () => {
    const { fetcher, bytes, db } = app();
    const as = { "x-test-user": "ana" };
    const raw = await fetcher(`${ORIGIN}/storage/v1/object/media/t/${T}/a.png`, { method: "POST", headers: { ...as, "content-type": "IMAGE/PNG; charset=binary" }, body: new Uint8Array(4) });
    expect(raw.status).toBe(200);
    const f = form("Audio/WebM; codecs=opus");
    expect((await fetcher(`${ORIGIN}/storage/v1/object/voice/t/${T}/b.webm`, { method: "POST", body: f.body, headers: { ...f.headers, ...as } })).status).toBe(200);
    // Nothing declared is application/octet-stream.
    expect((await fetcher(`${ORIGIN}/storage/v1/object/private/t/${T}/c.bin`, { method: "POST", headers: as, body: new Uint8Array(4) })).status).toBe(200);
    expect([...bytes].map(([k, v]) => [k, v.type])).toEqual([
      [`media/t/${T}/a.png`, "image/png"],
      [`voice/t/${T}/b.webm`, "audio/webm"],
      [`private/t/${T}/c.bin`, "application/octet-stream"],
    ]);
    expect(db.prepare("select name, mime_type from storage_objects order by created_at, name").all()).toEqual([
      { name: `t/${T}/a.png`, mime_type: "image/png" },
      { name: `t/${T}/b.webm`, mime_type: "audio/webm" },
      { name: `t/${T}/c.bin`, mime_type: "application/octet-stream" },
    ]);
    expect((await fetcher(`${ORIGIN}/storage/v1/object/public/voice/t/${T}/b.webm`)).headers.get("content-type")).toBe("audio/webm");
  });

  it("takes any type where a bucket names none (null), and none where its list is empty ([])", async () => {
    const { client, bytes, png } = app();
    const pdf = () => new File(["%PDF-1.4"], "a.pdf", { type: "application/pdf" });
    expect((await client("ana").from("private").upload(`t/${T}/a.pdf`, pdf())).error).toBeNull();
    expect(status(await client("ana").from("closed").upload(`t/${T}/a.pdf`, pdf()))).toBe(415);
    expect(status(await client("ana").from("closed").upload(`t/${T}/a.png`, png()))).toBe(415);
    expect(status(await client("ana").from("closed").upload(`t/${T}/a.bin`, new Uint8Array(4), { contentType: "application/octet-stream" }))).toBe(415);
    expect([...bytes.keys()]).toEqual([`private/t/${T}/a.pdf`]);
  });
});

// A file never runs as a page of the app's own origin, however it is read: the sandbox gives it no
// scripts, no forms and no origin, nothing loads from elsewhere, and nosniff keeps it the type it was
// kept with. Nothing else would notice if a change dropped these headers.
describe("serving a file", () => {
  function expectSandboxed(res: Response, type: string) {
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(type);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const policy = new Map(
      (res.headers.get("content-security-policy") ?? "")
        .split(";")
        .map((d) => d.trim().split(/\s+/))
        .filter((d) => d[0])
        .map(([name, ...values]) => [name!.toLowerCase(), values.join(" ")]),
    );
    expect(policy.get("sandbox")).toBe(""); // no allow-scripts, allow-same-origin, allow-forms …
    expect(policy.get("default-src")).toBe("'none'");
    expect([...policy.keys()].filter((name) => name.startsWith("script-src"))).toEqual([]);
  }

  it("sends the sandbox and nosniff on public, signed and authenticated reads, GET and HEAD", async () => {
    const { client, fetcher, png } = app();
    expect((await client("ana").from("media").upload(`t/${T}/a.png`, png())).error).toBeNull();
    expect((await client("ana").from("private").upload(`t/${T}/doc.pdf`, new File(["%PDF-1.4"], "doc.pdf", { type: "application/pdf" }))).error).toBeNull();
    const publicUrl = client().from("media").getPublicUrl(`t/${T}/a.png`).data.publicUrl;
    const signedUrl = (await client("beka").from("private").createSignedUrl(`t/${T}/doc.pdf`, 60)).data!.signedUrl;
    const as = { "x-test-user": "beka" };
    for (const method of ["GET", "HEAD"]) {
      expectSandboxed(await fetcher(publicUrl, { method }), "image/png");
      expectSandboxed(await fetcher(signedUrl, { method }), "application/pdf");
      expectSandboxed(await fetcher(`${ORIGIN}/storage/v1/object/authenticated/private/t/${T}/doc.pdf`, { method, headers: as }), "application/pdf");
      expectSandboxed(await fetcher(`${ORIGIN}/storage/v1/object/private/t/${T}/doc.pdf`, { method, headers: as }), "application/pdf");
    }
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
