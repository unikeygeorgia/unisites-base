import type { Auth, createData } from "./data.ts";
/**
 * `/storage/v1/*` as Supabase Storage answers it, on R2, so supabase-js's `supabase.storage`
 * works unchanged: upload (and upsert), remove, signed URLs, public URLs, downloads
 * (unisites ADR 0030, §4).
 *
 *   const storage = createStorage({ r2: env.FILES, data, auth: gotrue.person, admin: gotrue.isService,
 *     buckets: access.buckets, secret: env.BASE_SECRET });
 *   if (url.pathname.startsWith("/storage/v1/")) return storage.handler(request);
 *
 * Each file is a row in storage_objects (base_0005.sql), and every read, upload and removal of a
 * person's goes through that table's rules in access.json, as Supabase's policies on
 * storage.objects did: `folder1`..`folder3` are the path's first folders
 * (storage.foldername(name)[1..3]), `owner` is filled from the session. The bytes are in R2 under
 * "<bucket>/<name>". A public bucket's files are read by anyone, as Supabase's are.
 */
/** The part of an R2 bucket used (env.FILES), so the tests can keep the bytes in memory. */
export type Files = {
    put(key: string, value: ArrayBuffer | Uint8Array, options?: {
        httpMetadata?: {
            contentType?: string;
            cacheControl?: string;
        };
    }): Promise<unknown>;
    get(key: string): Promise<{
        body: ReadableStream | null;
        size: number;
        httpEtag?: string;
        httpMetadata?: {
            contentType?: string;
            cacheControl?: string;
        };
    } | null>;
    delete(keys: string | string[]): Promise<void>;
};
export type Bucket = {
    /** Read by anyone at /object/public/…, without rules. */
    public?: boolean;
    /** Bytes a file may have. */
    fileSizeLimit?: number | null;
    /** Types a file may be: "image/png", "image/*". */
    allowedMimeTypes?: string[] | null;
};
export type StorageConfig = {
    r2: Files;
    data: ReturnType<typeof createData>;
    /** The person a request is from (gotrue.person). */
    auth: (request: Request) => Promise<Auth | null>;
    /** The server's own code (gotrue.isService): no rules, as Supabase's service role. */
    admin?: (request: Request) => boolean | Promise<boolean>;
    buckets: Record<string, Bucket>;
    /** Signs the signed URLs (BASE_SECRET); a key is made from it. */
    secret: string;
    prefix?: string;
    /** The largest file any bucket takes, when a bucket says none. */
    maxBytes?: number;
};
export declare function createStorage(config: StorageConfig): {
    handler: (request: Request) => Promise<Response>;
};
