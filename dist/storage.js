import { AccessError } from "./access.js";
class StorageError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
const enc = new TextEncoder();
const TABLE = "storage_objects";
const NOT_FOUND = () => new StorageError(404, "not_found", "Object not found");
/** A path as storage-js sends it: folders and a name, nothing that climbs or hides. */
function cleanPath(path) {
    if (!path || path.length > 1024 || path.startsWith("/") || path.endsWith("/"))
        throw new StorageError(400, "InvalidKey", "Invalid key");
    for (const part of path.split("/")) {
        if (!part || part === "." || part === ".." || /[\u0000-\u001f\u007f\\]/.test(part))
            throw new StorageError(400, "InvalidKey", "Invalid key");
    }
    return path;
}
function folders(name) {
    const parts = name.split("/").slice(0, -1);
    return { folder1: parts[0] ?? null, folder2: parts[1] ?? null, folder3: parts[2] ?? null };
}
function mimeAllowed(type, allowed) {
    if (!allowed?.length)
        return true;
    return allowed.some((a) => a === type || (a.endsWith("/*") && type.startsWith(a.slice(0, -1))));
}
export function createStorage(config) {
    if (!config.secret || config.secret.length < 32)
        throw new Error("unisites-base: the secret must be at least 32 characters");
    const prefix = config.prefix ?? "/storage/v1/";
    const maxBytes = config.maxBytes ?? 50 * 1024 * 1024;
    const key = (async () => {
        const raw = await crypto.subtle.importKey("raw", enc.encode(config.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const derived = await crypto.subtle.sign("HMAC", raw, enc.encode("unisites-base/storage/sign"));
        return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    })();
    const b64url = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    /** A token for one file until a time: "<expires>.<signature>". */
    async function sign(bucket, name, expires) {
        return `${expires}.${b64url(await crypto.subtle.sign("HMAC", await key, enc.encode(`${bucket}\n${name}\n${expires}`)))}`;
    }
    async function signed(bucket, name, token) {
        const m = /^(\d{1,12})\.([A-Za-z0-9_-]{20,100})$/.exec(token ?? "");
        if (!m || Number(m[1]) * 1000 <= Date.now())
            return false;
        try {
            return await crypto.subtle.verify("HMAC", await key, fromB64url(m[2]), enc.encode(`${bucket}\n${name}\n${m[1]}`));
        }
        catch {
            return false;
        }
    }
    const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    function fail(e) {
        const say = (status, error, message) => answer(status, { statusCode: String(status), error, message });
        if (e instanceof StorageError)
            return say(e.status, e.code, e.message);
        if (e instanceof AccessError) {
            if (e.code === "conflict")
                return say(409, "Duplicate", "The resource already exists");
            if (e.code === "refused" || e.code === "forbidden" || e.code === "readonly_column")
                return say(403, "Unauthorized", "new row violates row-level security policy");
            if (e.code === "unknown_table")
                return say(500, "internal", "storage_objects has no rules in access.json");
            return say(400, "InvalidRequest", e.message);
        }
        console.error("storage:", e);
        return say(500, "internal", "internal error");
    }
    function bucketOf(id) {
        if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(id) || !Object.hasOwn(config.buckets, id))
            throw new StorageError(404, "Bucket not found", "Bucket not found");
        return config.buckets[id];
    }
    /** A file's bytes, as R2 keeps them. */
    async function serve(bucket, name, request) {
        const object = await config.r2.get(`${bucket}/${name}`);
        if (!object)
            throw NOT_FOUND();
        const headers = new Headers({
            "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
            "cache-control": object.httpMetadata?.cacheControl ?? "no-cache",
            "x-content-type-options": "nosniff",
            // A file never runs as a page of the app's own origin.
            "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
        });
        if (object.httpEtag)
            headers.set("etag", object.httpEtag);
        headers.set("content-length", String(object.size));
        return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
    }
    /** The upload's bytes, type and cache: storage-js's FormData (a browser File), or a raw body. */
    async function received(request, bucket) {
        const limit = Math.min(bucket.fileSizeLimit ?? maxBytes, maxBytes);
        const declared = Number(request.headers.get("content-length") ?? 0);
        if (declared > limit + 64 * 1024)
            throw new StorageError(413, "Payload too large", "The object exceeded the maximum allowed size");
        let bytes;
        let type;
        let cache;
        if (/^multipart\/form-data/i.test(request.headers.get("content-type") ?? "")) {
            // Read by hand: supabase-js sends the file as a part named "", which the Workers runtime's
            // formData() refuses ("Content-Disposition header in FormData part is missing a name").
            const form = multipart(new Uint8Array(await request.arrayBuffer()), request.headers.get("content-type") ?? "");
            const file = form.find((p) => p.filename !== null || p.type !== null);
            if (!file)
                throw new StorageError(400, "InvalidRequest", "no file");
            bytes = file.body;
            type = file.type || "application/octet-stream";
            const c = form.find((p) => p.name === "cacheControl" && p.filename === null);
            const seconds = c ? new TextDecoder().decode(c.body).trim() : "";
            cache = /^\d{1,9}$/.test(seconds) ? `max-age=${seconds}` : "max-age=3600";
        }
        else {
            bytes = new Uint8Array(await request.arrayBuffer());
            type = (request.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim() || "application/octet-stream";
            const c = /^max-age=(\d{1,9})$/.exec(request.headers.get("cache-control") ?? "");
            cache = c ? `max-age=${c[1]}` : "max-age=3600";
        }
        if (bytes.byteLength > limit)
            throw new StorageError(413, "Payload too large", "The object exceeded the maximum allowed size");
        if (!mimeAllowed(type, bucket.allowedMimeTypes))
            throw new StorageError(415, "invalid_mime_type", `mime type ${type} is not supported`);
        return { bytes, type, cache };
    }
    async function handle(request) {
        const url = new URL(request.url);
        let path;
        try {
            path = decodeURIComponent(url.pathname.slice(prefix.length));
        }
        catch {
            throw NOT_FOUND();
        }
        const method = request.method.toUpperCase();
        const isAdmin = config.admin ? await config.admin(request) : false;
        const person = isAdmin ? null : await config.auth(request);
        const db = isAdmin ? config.data.admin() : config.data.as(person);
        const at = (s) => /^([^/]+)\/(.+)$/.exec(s);
        // Anyone, a public bucket's file.
        let m = /^object\/public\/(.+)$/.exec(path);
        if (m && (method === "GET" || method === "HEAD")) {
            const [, bucket, name] = at(m[1]) ?? [];
            if (!bucket || !name || !bucketOf(bucket).public)
                throw new StorageError(400, "Bucket not found", "Bucket not found");
            return serve(bucket, cleanPath(name), request);
        }
        // Anyone with the signed URL, until it expires.
        m = /^object\/sign\/(.+)$/.exec(path);
        if (m && (method === "GET" || method === "HEAD")) {
            const [, bucket, name] = at(m[1]) ?? [];
            if (!bucket || !name)
                throw NOT_FOUND();
            bucketOf(bucket);
            if (!(await signed(bucket, cleanPath(name), url.searchParams.get("token"))))
                throw new StorageError(400, "InvalidSignature", "Invalid signature");
            return serve(bucket, name, request);
        }
        // Signing: only files the person may read (the table's list rule).
        if (m && method === "POST") {
            const body = (await request.json().catch(() => ({})));
            const expiresIn = Math.min(Math.max(Math.floor(Number(body.expiresIn) || 0), 1), 7 * 24 * 3600);
            const rest = m[1];
            const one = at(rest);
            const many = !one || Array.isArray(body.paths);
            const bucket = many ? rest : one[1];
            bucketOf(bucket);
            const names = (many ? (Array.isArray(body.paths) ? body.paths : []) : [one[2]]).map((p) => cleanPath(String(p)));
            if (names.length > 1000)
                throw new StorageError(400, "InvalidRequest", "at most 1000 paths");
            const seen = new Set(names.length ? (await db.list(TABLE, { columns: ["name"], where: [{ column: "bucket_id", op: "eq", value: bucket }, { column: "name", op: "in", value: names }] })).map((r) => r.name) : []);
            const expires = Math.floor(Date.now() / 1000) + expiresIn;
            const out = await Promise.all(names.map(async (name) => seen.has(name)
                ? { error: null, path: name, signedURL: `/object/sign/${bucket}/${name.split("/").map(encodeURIComponent).join("/")}?token=${await sign(bucket, name, expires)}` }
                : { error: "Either the object does not exist or you do not have access to it", path: name, signedURL: null }));
            if (many)
                return answer(200, out);
            if (!out[0].signedURL)
                throw NOT_FOUND();
            return answer(200, { signedURL: out[0].signedURL });
        }
        // A file the person may read (authenticated download).
        m = /^object\/(?:authenticated\/)?(.+)$/.exec(path);
        if (m && (method === "GET" || method === "HEAD")) {
            const [, bucket, name] = at(m[1]) ?? [];
            if (!bucket || !name)
                throw NOT_FOUND();
            bucketOf(bucket);
            const rows = await db.list(TABLE, { columns: ["name"], where: [{ column: "bucket_id", op: "eq", value: bucket }, { column: "name", op: "eq", value: cleanPath(name) }], limit: 1 });
            if (!rows.length)
                throw NOT_FOUND();
            return serve(bucket, name, request);
        }
        // Removing: the files the person may remove (the delete rule), then their bytes.
        m = /^object\/([^/]+)$/.exec(path);
        if (m && method === "DELETE") {
            const bucket = m[1];
            bucketOf(bucket);
            const body = (await request.json().catch(() => ({})));
            const names = (Array.isArray(body.prefixes) ? body.prefixes : []).map((p) => cleanPath(String(p)));
            if (!names.length)
                return answer(200, []);
            if (names.length > 1000)
                throw new StorageError(400, "InvalidRequest", "at most 1000 paths");
            const gone = await db.delete(TABLE, [{ column: "bucket_id", op: "eq", value: bucket }, { column: "name", op: "in", value: names }], { returning: true });
            const rows = gone.rows ?? [];
            if (rows.length)
                await config.r2.delete(rows.map((r) => `${bucket}/${r.name}`));
            return answer(200, rows.map((r) => ({ ...r, metadata: { size: r.size, mimetype: r.mime_type, cacheControl: r.cache_control } })));
        }
        // Uploading: POST adds (x-upsert: true also changes), PUT changes; the row first, under the rules.
        m = /^object\/(.+)$/.exec(path);
        if (m && (method === "POST" || method === "PUT")) {
            const [, bucket, raw] = at(m[1]) ?? [];
            if (!bucket || !raw)
                throw new StorageError(400, "InvalidKey", "Invalid key");
            const b = bucketOf(bucket);
            const name = cleanPath(raw);
            const file = await received(request, b);
            const now = new Date().toISOString();
            const filter = [
                { column: "bucket_id", op: "eq", value: bucket },
                { column: "name", op: "eq", value: name },
            ];
            const meta = { size: file.bytes.byteLength, mime_type: file.type, cache_control: file.cache, updated_at: now };
            const upsert = method === "POST" && request.headers.get("x-upsert") === "true";
            const existed = upsert ? (await config.data.admin().list(TABLE, { columns: ["id"], where: filter, limit: 1 }))[0] : undefined;
            // Uploading needs the rules to add or change, not to read: nothing comes back from the row.
            let id = existed?.id ?? null;
            if (method === "PUT" || existed) {
                const changed = await db.update(TABLE, filter, meta);
                if (!changed.count)
                    throw method === "PUT" ? NOT_FOUND() : new StorageError(403, "Unauthorized", "new row violates row-level security policy");
            }
            else {
                id = crypto.randomUUID();
                await db.create(TABLE, { id, bucket_id: bucket, name, ...folders(name), ...meta, created_at: now });
            }
            try {
                await config.r2.put(`${bucket}/${name}`, file.bytes, { httpMetadata: { contentType: file.type, cacheControl: file.cache } });
            }
            catch (e) {
                // No row for bytes that are not there.
                if (!existed && method === "POST")
                    await config.data.admin().delete(TABLE, filter);
                throw e;
            }
            return answer(200, { Key: `${bucket}/${name}`, Id: id });
        }
        throw new StorageError(404, "not_found", `${method} ${prefix}${path} is not served`);
    }
    return {
        handler: async (request) => {
            try {
                return await handle(request);
            }
            catch (e) {
                return fail(e);
            }
        },
    };
}
/** A multipart/form-data body's parts, whatever their names (an empty one included). */
export function multipart(body, contentType) {
    const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
    if (!m)
        throw new StorageError(400, "InvalidRequest", "no multipart boundary");
    const enc = new TextEncoder();
    const delim = enc.encode(`--${m[1] ?? m[2]}`);
    const at = (from) => {
        outer: for (let i = from; i <= body.length - delim.length; i++) {
            for (let j = 0; j < delim.length; j++)
                if (body[i + j] !== delim[j])
                    continue outer;
            return i;
        }
        return -1;
    };
    const parts = [];
    let start = at(0);
    while (start >= 0) {
        let head = start + delim.length;
        if (body[head] === 0x2d && body[head + 1] === 0x2d)
            break; // "--": the closing delimiter
        if (body[head] === 0x0d && body[head + 1] === 0x0a)
            head += 2;
        const next = at(head);
        if (next < 0)
            break;
        // The part runs to the CRLF before the next delimiter; its headers end at the first blank line.
        const end = next >= 2 && body[next - 2] === 0x0d && body[next - 1] === 0x0a ? next - 2 : next;
        let split = -1;
        for (let i = head; i + 3 < end; i++) {
            if (body[i] === 0x0d && body[i + 1] === 0x0a && body[i + 2] === 0x0d && body[i + 3] === 0x0a) {
                split = i;
                break;
            }
        }
        if (split >= 0) {
            const headers = new TextDecoder().decode(body.subarray(head, split));
            const disposition = /^content-disposition:(.*)$/im.exec(headers)?.[1] ?? "";
            const name = /\bname="([^"]*)"/i.exec(disposition)?.[1] ?? null;
            const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
            const type = /^content-type:\s*([^;\r\n]+)/im.exec(headers)?.[1]?.trim() ?? null;
            parts.push({ name, filename, type, body: body.slice(split + 4, end) });
        }
        start = next;
    }
    return parts;
}
