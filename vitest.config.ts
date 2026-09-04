import { defineConfig } from "vitest/config";

// `test/` at the root is for invariants that belong to no single package — see
// test/naming.test.ts, which reads the whole tracked tree.
export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "test/**/*.test.ts"],
    /**
     * Vitest's 5s default is calibrated for work that happens in this process. The slow
     * tests here are not that: they spawn `bin/sageox-agent` as a real child process, or
     * wait on a real socket, so their wall time is a CI runner's load rather than anything
     * the test does. Six tests in four files had already escaped the default one at a time
     * — `20_000`, `10_000`, `30_000` twice over. The seventh had not, and a `job run` case
     * that spawns the CLI four times (1.8s here) timed out on a loaded runner instead, on a
     * diff that changed only comments.
     *
     * Raised once here rather than a seventh time in place, since the next test found this
     * way is the argument against finding them this way. An explicit per-test timeout still
     * wins, so the six that name their own wait keep saying what they are waiting for.
     */
    testTimeout: 15_000,
  },
});
