import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { staticIssues, liveIssues, loadManifest, parseIssues, hookIssues } from "./config-completeness-check.js";

const temporaries: string[] = [];

function workflowDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "config-gate-"));
  temporaries.push(root);
  const dir = join(root, "workflows");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf8");
  return dir;
}

afterEach(() => {
  while (temporaries.length > 0) {
    const path = temporaries.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

const manifest = (entries: unknown[]) => ({ schemaVersion: 1 as const, entries: entries as never });

describe("configuration completeness gate", () => {
  it("fails when a workflow references configuration the manifest does not declare", () => {
    // The customer-backup incident: a workflow shipped naming a secret nobody
    // ever provisioned, and every scheduled run failed for a day.
    const dir = workflowDir({
      "a.yml": "jobs:\n  go:\n    environment: prod\n    steps:\n      - env:\n          T: ${{ secrets.NEVER_DECLARED }}\n",
    });
    const codes = staticIssues(manifest([]), dir).map((issue) => issue.code);
    expect(codes).toContain("CONFIG_UNDECLARED");
  });

  it("fails when a job uses an environment-scoped secret without declaring the environment", () => {
    // The #474 incident: mint steps were added to three jobs whose secrets live
    // in an environment only one job declared; the token resolved empty.
    const dir = workflowDir({
      "a.yml": "jobs:\n  go:\n    steps:\n      - env:\n          T: ${{ secrets.SCOPED }}\n",
    });
    const entries = [{ name: "SCOPED", type: "secret", scope: { kind: "environment", environment: "prod" }, status: "required" }];
    const codes = staticIssues(manifest(entries), dir).map((issue) => issue.code);
    expect(codes).toContain("CONFIG_ENVIRONMENT_UNBOUND");
  });

  it("accepts an environment-scoped secret when the job delegates with secrets: inherit", () => {
    const dir = workflowDir({
      "a.yml": "jobs:\n  go:\n    uses: ./.github/workflows/b.yml\n    secrets: inherit\n    with:\n      environment: prod\n",
      "b.yml": "on:\n  workflow_call:\n    inputs:\n      environment:\n        type: string\njobs:\n  run:\n    environment: ${{ inputs.environment }}\n    steps:\n      - env:\n          T: ${{ secrets.SCOPED }}\n",
    });
    const entries = [{ name: "SCOPED", type: "secret", scope: { kind: "environment", environment: "prod" }, status: "required" }];
    const codes = staticIssues(manifest(entries), dir).map((issue) => issue.code);
    expect(codes).not.toContain("CONFIG_ENVIRONMENT_UNBOUND");
  });

  it("fails when a required=() loop asserts a name no env: provides", () => {
    const dir = workflowDir({
      "a.yml": 'jobs:\n  go:\n    steps:\n      - run: |\n          required=( MENDPOINT_ABSENT )\n          for name in "${required[@]}"; do test -n "${!name:-}"; done\n',
    });
    const codes = staticIssues(manifest([]), dir).map((issue) => issue.code);
    expect(codes).toContain("CONFIG_SHELL_REQUIRED_UNPROVIDED");
  });

  it("accepts a required=() name a prior step exports to GITHUB_ENV", () => {
    // regauge-production derives authority values at runtime before asserting
    // them; treating that as unprovided produced seven false positives.
    const dir = workflowDir({
      "a.yml": 'jobs:\n  go:\n    steps:\n      - run: echo "MENDPOINT_DERIVED=x" >> "$GITHUB_ENV"\n      - run: |\n          required=( MENDPOINT_DERIVED )\n          for name in "${required[@]}"; do test -n "${!name:-}"; done\n',
    });
    const codes = staticIssues(manifest([]), dir).map((issue) => issue.code);
    expect(codes).not.toContain("CONFIG_SHELL_REQUIRED_UNPROVIDED");
  });

  it("reports a gated absence without failing, and names the gate", () => {
    const entries = [
      { name: "GATED", type: "variable", scope: { kind: "repo" }, status: "optional_gated", gatedBy: "vars.FEATURE_ON != ''" },
    ];
    const { issues, gatedAbsent } = liveIssues(manifest(entries), "o/r", () => ({ variables: [] }));
    expect(issues).toEqual([]);
    expect(gatedAbsent.map((entry) => entry.name)).toEqual(["GATED"]);
    expect(gatedAbsent[0]?.gatedBy).toBeTruthy();
  });

  it("fails on a declared-required name that is absent", () => {
    const entries = [{ name: "NEEDED", type: "secret", scope: { kind: "environment", environment: "prod" }, status: "required" }];
    const { issues } = liveIssues(manifest(entries), "o/r", () => ({ secrets: [] }));
    expect(issues.map((issue) => issue.code)).toEqual(["CONFIG_MISSING"]);
  });

  it("treats an unreadable scope as unreadable, never as present", () => {
    const entries = [{ name: "NEEDED", type: "secret", scope: { kind: "repo" }, status: "required" }];
    const { issues } = liveIssues(manifest(entries), "o/r", () => {
      throw new Error("403");
    });
    expect(issues.map((issue) => issue.code)).toEqual(["CONFIG_SCOPE_UNREADABLE"]);
  });

  it("requires a multi-environment name in every environment its callers pass", () => {
    const entries = [
      { name: "SHARED", type: "secret", scope: { kind: "environments", environments: ["a", "b"] }, status: "required" },
    ];
    const { issues } = liveIssues(manifest(entries), "o/r", (path) =>
      path.includes("/environments/a/") ? { secrets: [{ name: "SHARED" }] } : { secrets: [] },
    );
    expect(issues.map((issue) => issue.code)).toEqual(["CONFIG_MISSING"]);
    expect(issues[0]?.subject).toContain("b");
  });

  it("fails on a config file of two concatenated JSON objects, and says so", () => {
    // The operator's personal settings.json was in this state: every hook,
    // plugin, and permission it declared was silently inert.
    const root = mkdtempSync(join(tmpdir(), "config-parse-"));
    temporaries.push(root);
    writeFileSync(join(root, "a.json"), ['{"a":1}', '{"b":2}', ""].join("\n"), "utf8");
    const issues = parseIssues(root, ["a.json"]);
    expect(issues.map((issue) => issue.code)).toEqual(["CONFIG_FILE_UNPARSEABLE"]);
    expect(issues[0]?.message).toContain("concatenated");
  });

  it("accepts a config file that parses", () => {
    const root = mkdtempSync(join(tmpdir(), "config-parse-ok-"));
    temporaries.push(root);
    writeFileSync(join(root, "a.json"), ['{"a":1}', ""].join("\n"), "utf8");
    expect(parseIssues(root, ["a.json"])).toEqual([]);
  });

  it("treats a tracked config that cannot be read as a failure, not an absence", () => {
    const root = mkdtempSync(join(tmpdir(), "config-missing-"));
    temporaries.push(root);
    expect(parseIssues(root, ["nope.json"]).map((issue) => issue.code)).toEqual([
      "CONFIG_FILE_UNREADABLE",
    ]);
  });

  it("fails when a hook points at a script that does not exist", () => {
    // A hook naming a missing script is configured, believed active, and doing
    // nothing — the same shape as the malformed settings file.
    const root = mkdtempSync(join(tmpdir(), "config-hook-"));
    temporaries.push(root);
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node .claude/hooks/gone.mjs" }] }] },
      }),
      "utf8",
    );
    expect(hookIssues(root).map((issue) => issue.code)).toEqual(["CONFIG_HOOK_SCRIPT_MISSING"]);
  });

  it("accepts a hook whose script exists", () => {
    const root = mkdtempSync(join(tmpdir(), "config-hook-ok-"));
    temporaries.push(root);
    mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(root, ".claude", "hooks", "here.mjs"), "", "utf8");
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node .claude/hooks/here.mjs" }] }] },
      }),
      "utf8",
    );
    expect(hookIssues(root)).toEqual([]);
  });

  it("parses every config file the repository actually tracks", () => {
    expect(parseIssues()).toEqual([]);
    expect(hookIssues()).toEqual([]);
  });

  it("passes the repository's real workflows and manifest", () => {
    expect(staticIssues(loadManifest())).toEqual([]);
  });

  it("registers every secret-lifecycle authority binding in its protected activation scope", () => {
    const runtimeEntries = loadManifest().runtimeEntries ?? [];
    const secretLifecycle = runtimeEntries.filter(
      (entry) => entry.activatedBy === "MENDPOINT_SECRET_LIFECYCLE_ENABLED=1",
    );
    expect(secretLifecycle.map((entry) => entry.name).sort()).toEqual([
      "MENDPOINT_ENVELOPE_KEY_CATALOG_JSON",
      "MENDPOINT_SECRET_BREAK_GLASS",
      "MENDPOINT_SECRET_IDEMPOTENCY_KEYRING_JSON",
      "MENDPOINT_SECRET_LINEAGE_KEYRING_JSON",
    ]);
    expect(secretLifecycle.every(
      (entry) => entry.scope === "protected_application_environment" &&
        entry.status === "required_when_active",
    )).toBe(true);
  });
});
