// This workspace's suite is filesystem- and subprocess-heavy; see the shared
// config for why file parallelism is capped. Re-exported so the cap applies when
// CI runs `vitest run` inside this package (npm test --workspaces).
export { default } from "../../vitest.shared.js";
