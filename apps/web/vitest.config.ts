import { defineConfig } from "vitest/config";

// Transform JSX with the automatic runtime, matching the Next.js production
// build (tsconfig `jsx: preserve` -> Next automatic runtime). Without this,
// Vitest's default esbuild classic transform emits `React.createElement` and
// requires a `React` import in every rendered module. The server page components
// (and DS views that use no `React.*` member) intentionally omit that import, so
// the classic transform threw "React is not defined" when a test rendered them.
export default defineConfig({
  esbuild: { jsx: "automatic" },
});
