export async function copyFiles(o) {
    const get = o.fetch ?? fetch;
    const objects = [];
    for (let offset = 0;; offset += 1000) {
        const page = await o.query(`select coalesce(json_agg(json_build_array(o.bucket_id, o.name, o.metadata->>'size', o.metadata->>'mimetype', o.metadata->>'cacheControl', b.public)), '[]'::json)::text as rows
         from (select * from storage.objects order by bucket_id, name limit 1000 offset ${offset}) o join storage.buckets b on b.id = o.bucket_id`);
        const got = JSON.parse(String(page[0]?.rows ?? "[]"));
        for (const [bucket, name, size, type, cache, isPublic] of got)
            objects.push({ bucket, name, size: size ? Number(size) : null, type, cache, isPublic });
        if (got.length < 1000)
            break;
    }
    const path = (name) => name.split("/").map(encodeURIComponent).join("/");
    const out = { copied: 0, skipped: 0, failed: [], bytes: 0 };
    let next = 0;
    let done = 0;
    const worker = async () => {
        for (;;) {
            const f = objects[next++];
            if (!f)
                return;
            try {
                const there = await get(`${o.target}/storage/v1/object/authenticated/${f.bucket}/${path(f.name)}`, { method: "HEAD", headers: { authorization: `Bearer ${o.targetKey}` } });
                if (there.ok && f.size !== null && Number(there.headers.get("content-length")) === f.size) {
                    out.skipped++;
                }
                else {
                    const from = f.isPublic || !o.sourceKey
                        ? `${o.source}/storage/v1/object/public/${f.bucket}/${path(f.name)}`
                        : `${o.source}/storage/v1/object/authenticated/${f.bucket}/${path(f.name)}`;
                    const res = await get(from, f.isPublic || !o.sourceKey ? {} : { headers: { authorization: `Bearer ${o.sourceKey}`, apikey: o.sourceKey } });
                    if (!res.ok)
                        throw new Error(`Supabase answered ${res.status}`);
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
                    if (!put.ok)
                        throw new Error(`the new project answered ${put.status}: ${(await put.text()).slice(0, 200)}`);
                    out.copied++;
                    out.bytes += bytes.byteLength;
                }
            }
            catch (e) {
                out.failed.push({ bucket: f.bucket, name: f.name, why: e.message });
            }
            o.onProgress?.(++done, objects.length);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.parallel ?? 6, 16)) }, worker));
    return out;
}
