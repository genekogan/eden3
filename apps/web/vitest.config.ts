import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest needs the same `@/*` path alias tsconfig gives Next — without it,
 * any test that (transitively) imports "@/lib/..." fails to collect.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    passWithNoTests: true,
  },
});
