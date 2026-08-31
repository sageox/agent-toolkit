import { defineConfig } from "vitest/config";

// `test/` at the root is for invariants that belong to no single package — see
// test/naming.test.ts, which reads the whole tracked tree.
export default defineConfig({
  test: { include: ["packages/**/test/**/*.test.ts", "test/**/*.test.ts"] },
});
