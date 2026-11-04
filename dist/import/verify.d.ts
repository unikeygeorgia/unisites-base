import { type Access } from "../access.ts";
import type { Item } from "./report.ts";
/**
 * The drafts tried before anyone reads them: base's migrations and the draft schema on an empty
 * SQLite (as D1 runs them), then `check` of the draft access.json against what they made.
 * Node only: the CLI and the tests use it.
 */
export declare function verifyDrafts(schema: string, access: Access): Item[];
