import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFixtureShellStep } from "./workflow-fixture-shell.js";

/**
 * Proves the shared fixture-shell guard is load-bearing (issue #697). Every
 * backup-workflow harness routes its shipped step through runFixtureShellStep;
 * these tests exercise the guard directly so a regression in the ONE helper is
 * caught here rather than depending on a Windows host actually shadowing a stub.
 */

function stub(dir: string, name: string, body: string): string {
  const bin = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(bin, body, "utf8");
  chmodSync(bin, 0o755);
  return bin;
}

describe("runFixtureShellStep — the fixture tool-selection guard", () => {
  it("runs the step when every guarded tool resolves to the fixture bin", () => {
    const dir = mkdtempSync(join(tmpdir(), "fixture-shell-ok-"));
    const bin = join(dir, "bin");
    stub(bin, "flyctl", "#!/bin/sh\necho fixture-flyctl-ran\n");
    const scriptPath = join(dir, "step.sh");
    writeFileSync(scriptPath, "set -euo pipefail\nflyctl anything\n", "utf8");

    const result = runFixtureShellStep({
      scriptPath,
      cwd: dir,
      fixtureBin: bin,
      guardTools: ["flyctl"],
    });

    expect(result.status, result.stderr ?? "").toBe(0);
    expect(result.stdout).toContain("fixture-flyctl-ran");
  });

  it("refuses with fixture_tool_selection_failed when a guarded tool is not the fixture's", () => {
    // The fixture stubs flyctl but NOT gh; a decoy dir on PATH provides gh, so gh
    // resolves to the decoy (a host-tool stand-in) rather than the fixture. The
    // guard must abort BEFORE the step runs. This is the mutation sentinel: delete
    // the guard from runFixtureShellStep and the step below runs to exit 0, so
    // this expectation fails.
    const dir = mkdtempSync(join(tmpdir(), "fixture-shell-shadow-"));
    const fixtureBin = join(dir, "fixture");
    stub(fixtureBin, "flyctl", "#!/bin/sh\nexit 0\n");
    const decoyBin = join(dir, "decoy");
    stub(decoyBin, "gh", "#!/bin/sh\necho decoy-gh-ran\n");
    const scriptPath = join(dir, "step.sh");
    // If the guard were gone, this step would succeed (exit 0).
    writeFileSync(scriptPath, "set -euo pipefail\ngh whatever\n", "utf8");

    const result = runFixtureShellStep({
      scriptPath,
      cwd: dir,
      fixtureBin,
      guardTools: ["flyctl", "gh"],
      env: {
        ...process.env,
        // The decoy sits behind the fixture on PATH; because the fixture lacks gh,
        // gh still resolves to the decoy, exactly as a host tool would.
        PATH: `${decoyBin}${delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain("fixture_tool_selection_failed:gh");
    expect(result.stdout).not.toContain("decoy-gh-ran");
  });

  it("runs the step directly under GitHub's flags when no fixture bin is declared", () => {
    const dir = mkdtempSync(join(tmpdir(), "fixture-shell-nofixture-"));
    const scriptPath = join(dir, "step.sh");
    writeFileSync(scriptPath, "set -euo pipefail\necho no-fixture-ok\n", "utf8");

    const result = runFixtureShellStep({ scriptPath, cwd: dir });

    expect(result.status, result.stderr ?? "").toBe(0);
    expect(result.stdout).toContain("no-fixture-ok");
  });
});
