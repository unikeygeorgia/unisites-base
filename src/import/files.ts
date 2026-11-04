import type { Query } from "./data.ts";

/**
 * A Supabase project's files into a Unisites project's R2 (unisites ADR 0030, §4): each object of
 * storage.objects downloaded from Supabase Storage and uploaded through the new project's
 * /storage/v1 with its service key, so the bytes land where its storage_objects rows say
 * (`import-supabase --data` moved those first). A file already there with the same size is
 * left, so a copy stopped halfway goes on where it stopped. Node only (the CLI and the tests).
 */

export type CopyOptions = {
  /** storage.objects, read with the Management API (one SELECT). */
  query: Query;
  /** https://<ref>.supabase.co */
  source: string;
  /** Supabase's service role key, for a private bucket's files; none needed for public ones. */
  sourceKey?: string;
  /** The new project's address, and its service key (SUPABASE_SERVICE_ROLE_KEY there). */
  target: string;
  targetKey: string;
  /** Downloads and uploads at once. */
  parallel?: number;
  fetch?: typeof fetch;
  /** How many times a rate-limited (429) or failed (5xx) download is asked again, and the first wait. */
  retries?: number;
  retryMs?: number;
  onProgress?: (done: number, all: number) => void;
};

export type Copied = { copied: number; skipped: number; failed: { bucket: string; name: string; why: string }[]; bytes: number };

export async function copyFiles(o: CopyOptions): Promise<Copied> {
  const get = o.fetch ?? fetch;
  const objects: { bucket: string; name: string; size: number | null; type: string | null; cache: string | null; isPublic: boolean }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await o.query(
      `select coalesce(json_agg(json_build_array(o.bucket_id, o.name, o.metadata->>'size', o.metadata->>'mimetype', o.metadata->>'cacheControl', b.public)), '[]'::json)::text as rows
         from (select * from storage.objects order by bucket_id, name limit 1000 offset ${offset}) o join storage.buckets b on b.id = o.bucket_id`,
    );
    const got = JSON.parse(String(page[0]?.rows ?? "[]")) as [string, string, string | null, string | null, string | null, boolean][];
    for (const [bucket, name, size, type, cache, isPublic] of got) objects.push({ bucket, name, size: size ? Number(size) : null, type, cache, isPublic });
    if (got.length < 1000) break;
  }

  const path = (name: string) => name.split("/").map(encodeURIComponent).join("/");
  const out: Copied = { copied: 0, skipped: 0, failed: [], bytes: 0 };
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const f = objects[next++];
      if (!f) return;
      try {
        const there = await get(`${o.target}/storage/v1/object/authenticated/${f.bucket}/${path(f.name)}`, { method: "HEAD", headers: { authorization: `Bearer ${o.targetKey}` } });
        if (there.ok && f.size !== null && Number(there.headers.get("content-length")) === f.size) {
          out.skipped++;
        } else {
          const from = f.isPublic || !o.sourceKey
            ? `${o.source}/storage/v1/object/public/${f.bucket}/${path(f.name)}`
            : `${o.source}/storage/v1/object/authenticated/${f.bucket}/${path(f.name)}`;
          const init = f.isPublic || !o.sourceKey ? {} : { headers: { authorization: `Bearer ${o.sourceKey}`, apikey: o.sourceKey } };
          // Supabase limits how fast its files are read: a 429 or a 5xx is asked again, after a wait.
          let res = await get(from, init);
          for (let attempt = 1; (res.status === 429 || res.status >= 500) && attempt <= (o.retries ?? 5); attempt++) {
            const after = Number(res.headers.get("retry-after"));
            await new Promise((r) => setTimeout(r, after > 0 ? Math.min(after, 60) * 1000 : (o.retryMs ?? 1000) * 2 ** (attempt - 1)));
            res = await get(from, init);
          }
          if (!res.ok) throw new Error(`Supabase answered ${res.status}`);
          const bytes = new Uint8Array(await res.arrayBuffer());
          const put = await get(`${o.target}/storage/v1/object/${f.bucket}/${path(f.name)}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${o.targetKey}`,
              "content-type": f.type ?? res.headers.get("content-type") ?? "application/octet-stream",
              "cache-control": f.cache && /^max-age=\d+$/.test(f.cache) ? f.cache : "max-age=3600",
              "x-upsert": "true",
            },
            body: bytes,
          });
          if (!put.ok) throw new Error(`the new project answered ${put.status}: ${(await put.text()).slice(0, 200)}`);
          out.copied++;
          out.bytes += bytes.byteLength;
        }
      } catch (e) {
        out.failed.push({ bucket: f.bucket, name: f.name, why: (e as Error).message });
      }
      o.onProgress?.(++done, objects.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.parallel ?? 6, 16)) }, worker));
  return out;
}
