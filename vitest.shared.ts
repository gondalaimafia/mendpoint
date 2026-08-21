import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// Shared Vitest configuration for the workspaces whose tests are filesystem- and
// subprocess-heavy (they shell out to git, tsx, and spawned Node verifiers, and
// materialize real repositories on disk). At Vitest's default of one test file
// per core, several such files run at once and their subprocess spawns, disk
// writes, and TypeScript transforms all contend for the same few CI cores. The
// work itself is fine in isolation; under that contention a spawn or a transform
// that normally takes well under a second stretches past a test's timeout, so a
// green suite goes red purely because the runner was busy.
//
// Capping file-level parallelism to half the available cores bounds how many of
// those heavy files run concurrently, which keeps per-operation latency inside
// the existing timeouts. This changes only scheduling and wall-clock time; it
// does not touch any test's logic, assertions, or the product code under test.
// On a runner with two or fewer available cores this collapses to a single fork,
// trading maximum throughput for a check that stays informative.
const halfCores = Math.max(1, Math.floor(availableParallelism() / 2));

export const ioBoundTestConfig = defineConfig({
  test: {
    poolOptions: {
      forks: {
        maxForks: halfCores,
        minForks: 1,
      },
    },
  },
});

export default ioBoundTestConfig;
