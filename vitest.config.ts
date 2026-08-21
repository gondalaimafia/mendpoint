// Root Vitest config. It applies only to Vitest runs invoked from the repository
// root (for example the aggregated `vitest run packages/repair apps/api
// apps/worker` verification and `npm test`'s trailing `vitest run scripts`).
// Per-workspace runs (`npm test --workspaces`) load each workspace's own config
// instead, so this does not change how any individual package's suite runs in
// CI. It exists so the same file-parallelism cap that protects the heavy suites
// per package also protects them when they are run together from the root, where
// otherwise every file would stampede at once.
export { default } from "./vitest.shared.js";
