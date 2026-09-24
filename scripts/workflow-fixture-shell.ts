import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { delimiter } from "node:path";

/**
 * Shared harness for running a SHIPPED workflow step script under the shell
 * GitHub actually uses, with the stubbed tools guaranteed to win over the host's.
 *
 * The single source of the #681 fix: Git Bash on Windows prepends its own tool
 * directories during shell startup, AHEAD of the PATH the parent handed it, so a
 * fixture directory placed first in the inherited PATH was silently defeated and
 * the real `sleep`/`curl`/`gh`/`flyctl` ran instead of the stub (issue #697).
 * This helper re-exports the fixture bin first INSIDE the invoked shell, clears
 * bash's command hash, and then refuses to run the step at all unless every
 * declared tool resolves to the fixture bin -- so a shadowed stub fails loudly
 * with `fixture_tool_selection_failed:<tool>` rather than the step quietly
 * exercising a host binary. Every backup/egress workflow-step harness routes
 * through here so a second private copy can never drift to a weaker guard.
 */

/** Exactly what GitHub passes for `shell: bash`. Not our own choice of flags. */
export const GITHUB_BASH_FLAGS = ["--noprofile", "--norc", "-e", "-o", "pipefail"] as const;

export interface FixtureShellStep {
  /** The step script, already written to disk, to run under GitHub's flags. */
  readonly scriptPath: string;
  /** Working directory for the step. */
  readonly cwd: string;
  /** Environment for the step (PATH is amended below when a fixture bin is set). */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Fixture bin whose stubs must beat the host's tools. When set it is placed
   * first on PATH (both in the child env and re-exported inside the shell after
   * Git Bash's startup prepend), and every tool in `guardTools` must resolve to
   * it before the step runs.
   */
  readonly fixtureBin?: string;
  /**
   * Tools that MUST resolve to `fixtureBin`. A tool that resolves anywhere else
   * (a host binary shadowing the stub, or no stub at all) aborts the step with
   * `fixture_tool_selection_failed:<tool>` and exit 127. Requires `fixtureBin`.
   */
  readonly guardTools?: readonly string[];
}

/**
 * Runs `scriptPath` under GitHub's `shell: bash` flags. With a `fixtureBin` the
 * step is sourced only after the fixture PATH is restored and every `guardTools`
 * entry is proven to resolve to the fixture; without one it runs the script
 * directly. Returns the raw spawn result (encoding "utf8").
 */
export function runFixtureShellStep(step: FixtureShellStep): SpawnSyncReturns<string> {
  const scriptPath = step.scriptPath.replace(/\\/g, "/");
  const baseEnv = step.env ?? process.env;

  if (step.fixtureBin === undefined) {
    return spawnSync("bash", [...GITHUB_BASH_FLAGS, scriptPath], {
      cwd: step.cwd,
      encoding: "utf8",
      env: baseEnv,
    });
  }

  const fixtureBin = step.fixtureBin.replace(/\\/g, "/");
  const guard = `
    fixture_bin="$(cd "$1" && pwd)"
    step_script="$2"
    shift 2
    export PATH="$fixture_bin:$PATH"
    hash -r
    for tool in "$@"; do
      [[ "$(command -v "$tool")" == "$fixture_bin/$tool" ]] || {
        echo "fixture_tool_selection_failed:$tool" >&2; exit 127;
      }
    done
    source "$step_script"
  `;
  return spawnSync(
    "bash",
    [
      ...GITHUB_BASH_FLAGS,
      "-c",
      guard,
      "workflow-fixture",
      fixtureBin,
      scriptPath,
      ...(step.guardTools ?? []),
    ],
    {
      cwd: step.cwd,
      encoding: "utf8",
      env: {
        ...baseEnv,
        PATH: `${step.fixtureBin}${delimiter}${baseEnv.PATH ?? ""}`,
      },
    },
  );
}
