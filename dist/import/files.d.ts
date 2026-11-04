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
export type Copied = {
    copied: number;
    skipped: number;
    failed: {
        bucket: string;
        name: string;
        why: string;
    }[];
    bytes: number;
};
export declare function copyFiles(o: CopyOptions): Promise<Copied>;
