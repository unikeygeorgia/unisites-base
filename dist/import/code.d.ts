import type { CodeUse } from "./report.ts";
export declare function scanCode(root: string): CodeUse[];
/** supabase.rpc("name") calls, for the functions they need. */
export declare function rpcCalls(root: string): Map<string, string[]>;
