import { defineConfig } from "vitest/config";
import { ioBoundTestConfig } from "./vitest.shared.js";

// Root Vitest config. It applies only to Vitest runs invoked from the repository
// root (for example the aggregated `vitest run packages/repair apps/api
// apps/worker` verification, `npm test`'s trailing `vitest run scripts`, and
// `eval:synthetic:check`'s `vitest run evals`). Per-workspace runs
// (`npm test --workspaces`) load each workspace's own config instead, so this
// does not change how any individual package's suite runs in CI.
//
// It carries two things a root-level run needs:
//   1. The file-parallelism cap from vitest.shared.ts, so the same cap that
//      protects the heavy suites per package also protects them when they are
//      run together from the root, where otherwise every file would stampede at
//      once.
//   2. The automatic JSX runtime. A root-level `vitest run apps/web` loads this
//      config rather than apps/web/vitest.config.ts, so without setting it here
//      Vitest's default esbuild classic transform emits `React.createElement`
//      and requires a `React` import in every rendered module. The server page
//      components and DS views intentionally omit that import, so they threw
//      "React is not defined" under a root-level run while passing per-workspace.
//      `jsx: "automatic"` is inert for the non-JSX .ts files in the backend
//      packages, scripts, and evals, so it is safe to apply to every root run.
export default defineConfig({
  test: {
    ...ioBoundTestConfig.test,
  },
  esbuild: { jsx: "automatic" },
});
