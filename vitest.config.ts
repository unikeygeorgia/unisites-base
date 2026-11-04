import { defineConfig } from "vitest/config";

// Only the project's tests: scratch/ holds reviews' proofs of concept, which fail once fixed.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
