import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const ENGINE_PATH = ".github/workflows/sandbox-egress-acceptance.yml";

function engineSource(): string {
  return readFileSync(resolve(root, ENGINE_PATH), "utf8");
}

/**
 * Pull the REAL guard + mutation loop out of the workflow so these tests
 * exercise the shipped shell, not a copy of it. If the workflow is reworded
 * the extraction fails loudly rather than silently testing nothing.
 */
function extractRotationShell(): string {
  const source = engineSource();
  const start = source.indexOf("            assert_mutable_image() {");
  expect(start, "guard function not found in workflow").toBeGreaterThan(-1);
  const endMarker = "            ] | @tsv' <<<\"$machines_json\")";
  const end = source.indexOf(endMarker, start);
  expect(end, "mutation loop terminator not found in workflow").toBeGreaterThan(-1);
  const block = source.slice(start, end + endMarker.length);
  // Strip the 12-space YAML block indent.
  return block
    .split("\n")
    .map((line) => (line.startsWith("            ") ? line.slice(12) : line))
    .join("\n");
}

/** The exact jq used to build the rollback verification baseline. */
function extractExpectedConfigsJq(): string {
  const source = engineSource();
  const start = source.indexOf('expected_machine_configs="$(jq -cS \'');
  expect(start, "expected_machine_configs not found").toBeGreaterThan(-1);
  const open = source.indexOf("'", start);
  const close = source.indexOf("' <<<\"$machines_json\")", open);
  expect(close).toBeGreaterThan(open);
  return source.slice(open + 1, close);
}

const PRODUCTION_DIGEST =
  "sha256:16f5182af0ff15f13ae990260b46e5e753c2bdf24cc0cca7bd239fb21093aaee";
const PRODUCTION_TAG_IMAGE =
  "registry.fly.io/mendpoint-fettler-production:deployment-01M18G71SEN4HKMQNXS21H0EJF";

/**
 * The exact production shape from run 33288965039: config.image is TAG-form
 * while image_ref carries the digest. Synthesising registry/repository@digest
 * therefore produces a string that is well-formed but is NOT the machine's
 * image, and flyctl doubles its digest when it resolves it.
 */
function productionMachinesJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      id: "84e696a22eee68",
      state: "started",
      image_ref: {
        registry: "registry.fly.io",
        repository: "mendpoint-fettler-production",
        tag: "deployment-01M18G71SEN4HKMQNXS21H0EJF",
        digest: PRODUCTION_DIGEST,
      },
      config: {
        image: PRODUCTION_TAG_IMAGE,
        metadata: { fly_process_group: "app", fly_platform_version: "v2" },
        ...overrides,
      },
    },
  ]);
}

interface HarnessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
  mutatingCalls: string[];
  recovery: string;
}

/**
 * Run the extracted rotation shell against a stubbed flyctl. The stub records
 * every invocation, so "no mutation happened" is proved by consequence rather
 * than asserted from the source text.
 */
function runRotation(machinesJson: string, derivation?: string): HarnessResult {
  const dir = mkdtempSync(join(tmpdir(), "egress-guard-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  mkdirSync(join(dir, "test-results", "sandbox-egress"), { recursive: true });
  const callLog = join(dir, "flyctl-calls.log");

  writeFileSync(
    join(binDir, "flyctl"),
    ['#!/usr/bin/env bash', `printf '%s\\n' "$*" >>"${callLog.replace(/\\/g, "/")}"`, "exit 0", ""].join(
      "\n",
    ),
  );
  chmodSync(join(binDir, "flyctl"), 0o755);

  let shell = extractRotationShell();
  if (derivation) {
    // Swap only the tsv derivation, to compare old vs new behaviour through
    // the identical guard and loop.
    shell = shell.replace("  .config.image,\n", `  ${derivation},\n`);
  }

  const harness = [
    "set -uo pipefail",
    'app="mendpoint-fettler-production"',
    'MENDPOINT_SANDBOX_EGRESS_IMAGE="registry.fly.io/mendpoint-sandbox@sha256:3aadc8555de5bc2fc4b03f0c135c4b4a845d5a21de9fffd3a0056b98f062f15a"',
    "machines_json=$(cat machines.json)",
    "attempted_machine_ids=()",
    // Rollback must never be needed when the guard fires pre-mutation.
    'rollback_attempted_machines() { printf \'ROLLBACK %s\\n\' "$1" >>"' +
      callLog.replace(/\\/g, "/") +
      '"; return 1; }',
    shell,
    "",
  ].join("\n");

  writeFileSync(join(dir, "machines.json"), machinesJson);
  writeFileSync(join(dir, "harness.sh"), harness);

  const result = spawnSync("bash", ["harness.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` },
  });

  const calls = existsSync(callLog)
    ? readFileSync(callLog, "utf8").split("\n").filter(Boolean)
    : [];
  const recoveryPath = join(dir, "test-results", "sandbox-egress", "rotation-recovery-mendpoint-fettler-production.txt");
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    calls,
    mutatingCalls: calls.filter((line) => line.includes("machine update") || line.startsWith("ROLLBACK")),
    recovery: existsSync(recoveryPath) ? readFileSync(recoveryPath, "utf8") : "",
  };
}

describe("sandbox egress rotation — the image passed to a production mutation", () => {
  it("passes the machine's own config.image through unchanged and mutates exactly once", () => {
    const result = runRotation(productionMachinesJson());

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const updates = result.calls.filter((line) => line.includes("machine update"));
    expect(updates).toHaveLength(1);
    // Byte-equal to config.image: no synthesis, no digest appended by us.
    // Scope this to the --image argument; the unrelated --env sandbox image
    // legitimately carries a digest.
    const passedImage = /--image (\S+)/.exec(updates[0])?.[1];
    expect(passedImage).toBe(PRODUCTION_TAG_IMAGE);
    expect(passedImage).not.toContain("@sha256:");
    expect(result.recovery).toBe("");
  });

  it("REJECTS the old synthesised registry/repository@digest derivation before any mutation", () => {
    // This is the real production input, not a synthetic doubled string: the
    // old derivation yields a single well-formed digest ref that is simply not
    // the machine's image. flyctl then appends the resolved digest to it,
    // producing repo@sha256:X@sha256:X and "invalid image identifier".
    const result = runRotation(
      productionMachinesJson(),
      '(.image_ref | "\\(.registry)/\\(.repository)@\\(.digest)")',
    );

    expect(result.status).not.toBe(0);
    // The load-bearing assertion: production was never touched.
    expect(result.mutatingCalls).toEqual([]);
    expect(result.calls.filter((l) => l.includes("machine update"))).toHaveLength(0);
    expect(result.recovery).toContain("image_guard_not_canonical");
    expect(result.recovery).toContain(
      `registry.fly.io/mendpoint-fettler-production@${PRODUCTION_DIGEST}`,
    );
  });

  it("REJECTS an already digest-pinned config.image, because flyctl appends a second digest", () => {
    const machines = JSON.parse(productionMachinesJson());
    machines[0].config.image = `${PRODUCTION_TAG_IMAGE}@${PRODUCTION_DIGEST}`;
    const result = runRotation(JSON.stringify(machines));

    expect(result.status).not.toBe(0);
    expect(result.mutatingCalls).toEqual([]);
    expect(result.recovery).toContain("image_guard_digest_form");
  });

  it("REJECTS a malformed reference before any mutation", () => {
    const machines = JSON.parse(productionMachinesJson());
    machines[0].config.image = "not a valid reference";
    const result = runRotation(JSON.stringify(machines));

    expect(result.status).not.toBe(0);
    expect(result.mutatingCalls).toEqual([]);
    expect(result.recovery).toContain("image_guard_malformed");
  });

  it("accepts a plain tag-form reference and mutates once", () => {
    const machines = JSON.parse(productionMachinesJson());
    machines[0].config.image = "registry.fly.io/mendpoint-regauge-production:deployment-01ABC";
    const result = runRotation(JSON.stringify(machines));

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const updates = result.calls.filter((line) => line.includes("machine update"));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("--image registry.fly.io/mendpoint-regauge-production:deployment-01ABC");
  });
});

describe("sandbox egress rotation — a successful rollback is not scored as a failure", () => {
  /** Evaluate the shipped baseline jq, then the shipped comparison, by consequence. */
  function rollbackVerdict(beforeJson: string, restoredJson: string): boolean {
    const dir = mkdtempSync(join(tmpdir(), "egress-rollback-"));
    writeFileSync(join(dir, "before.json"), beforeJson);
    writeFileSync(join(dir, "restored.json"), restoredJson);
    const expectedJq = extractExpectedConfigsJq();
    writeFileSync(join(dir, "expected.jq"), expectedJq);

    const script = [
      "set -euo pipefail",
      "machines_json=$(cat before.json)",
      'expected_machine_configs="$(jq -cS -f expected.jq <<<"$machines_json")"',
      // The shipped restored-side comparison.
      'if jq -e --argjson expected "$expected_machine_configs" \'',
      "    ([.[]",
      "      | {id, state, config: (.config | .image |= split(\"@sha256:\")[0])}",
      "    ] | sort_by(.id)) == $expected",
      "  ' <restored.json >/dev/null; then echo MATCH; else echo MISMATCH; fi",
      "",
    ].join("\n");
    writeFileSync(join(dir, "verify.sh"), script);
    const r = spawnSync("bash", ["verify.sh"], { cwd: dir, encoding: "utf8" });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    // "MISMATCH" contains "MATCH", so compare the exact token.
    const verdict = (r.stdout ?? "").trim();
    expect(["MATCH", "MISMATCH"]).toContain(verdict);
    return verdict === "MATCH";
  }

  it("scores an exact restore as a match, so containment does not fire", () => {
    // This is the case that took production down: the restore SUCCEEDED and
    // was still scored rollback_failed, which stopped the machine.
    const json = productionMachinesJson();
    expect(rollbackVerdict(json, json)).toBe(true);
  });

  it("still scores a restore as a match when Fly pins the tag to a digest", () => {
    const restored = JSON.parse(productionMachinesJson());
    restored[0].config.image = `${PRODUCTION_TAG_IMAGE}@${PRODUCTION_DIGEST}`;
    expect(rollbackVerdict(productionMachinesJson(), JSON.stringify(restored))).toBe(true);
  });

  it("still detects a genuinely wrong restore", () => {
    const restored = JSON.parse(productionMachinesJson());
    restored[0].config.metadata.fly_process_group = "worker";
    expect(rollbackVerdict(productionMachinesJson(), JSON.stringify(restored))).toBe(false);
  });

  it("still detects a restore onto a different image", () => {
    const restored = JSON.parse(productionMachinesJson());
    restored[0].config.image = "registry.fly.io/mendpoint-fettler-production:deployment-OTHER";
    expect(rollbackVerdict(productionMachinesJson(), JSON.stringify(restored))).toBe(false);
  });
});

/** Extract a shell region from the workflow, de-indented, failing loudly. */
function extractRegion(startMarker: string, endMarker: string): string {
  const source = engineSource();
  const start = source.indexOf(startMarker);
  expect(start, `missing: ${startMarker}`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end, `missing: ${endMarker}`).toBeGreaterThan(-1);
  return source
    .slice(start, end + endMarker.length)
    .split("\n")
    .map((line) => (line.startsWith("            ") ? line.slice(12) : line))
    .join("\n");
}

interface HealthResult {
  status: number | null;
  stderr: string;
  calls: string[];
  stopCalls: string[];
  contained: boolean;
}

/**
 * Run the SHIPPED post-rotation health block together with the SHIPPED
 * contain_current_machines, against a stubbed curl and flyctl. Containment is
 * real here, so "no machine was stopped" is proved by the absence of actual
 * stop invocations rather than by reading the source.
 */
function runHealthGate(livezStatus: number, healthzStatus: number): HealthResult {
  const dir = mkdtempSync(join(tmpdir(), "egress-health-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  mkdirSync(join(dir, "test-results", "sandbox-egress"), { recursive: true });
  const callLog = join(dir, "calls.log").replace(/\\/g, "/");

  writeFileSync(join(dir, "machines.json"), productionMachinesJson());

  // curl is a shell FUNCTION rather than a script on PATH: the retry loop runs
  // 24 times and spawning 24 processes per test made the suite slow enough to
  // tip unrelated tests over their timeouts.
  const curlStub = [
    "curl() {",
    '  local url="${!#}"',
    '  case "$url" in',
    `    */livez) local status=${livezStatus} ;;`,
    `    */healthz) local status=${healthzStatus} ;;`,
    "    *) local status=404 ;;",
    "  esac",
    `  printf 'curl %s -> %s\\n' "$url" "$status" >>"${callLog}"`,
    '  local outfile="" prev=""',
    '  for a in "$@"; do [ "$prev" = "--output" ] && outfile="$a"; prev="$a"; done',
    "  if [ -n \"$outfile\" ]; then printf '{}' >\"$outfile\"; else printf '{}'; fi",
    "  for a in \"$@\"; do [ \"$a\" = \"--write-out\" ] && printf '%s' \"$status\"; done",
    '  [ "$status" = "200" ] || return 22',
    "  return 0",
    "}",
  ].join("\n");

  writeFileSync(
    join(binDir, "flyctl"),
    [
      "#!/usr/bin/env bash",
      `printf 'flyctl %s\\n' "$*" >>"${callLog}"`,
      'case "$*" in',
      `  *"machine list"*) cat "${join(dir, "machines.json").replace(/\\/g, "/")}" ;;`,
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "flyctl"), 0o755);

  const containment = extractRegion("            contain_current_machines() {", "\n            }\n");
  const healthBlock = extractRegion(
    "            # This job rotates egress attestation.",
    'echo "The app $app did not become healthy after receipt rotation"\n              exit 1\n            fi',
  );

  const harness = [
    "set -uo pipefail",
    'app="mendpoint-fettler-production"',
    "machines_json=$(cat machines.json)",
    "sleep() { :; }", // keep the 24-attempt backoff instant
    curlStub,
    containment,
    healthBlock,
    "",
  ].join("\n");
  writeFileSync(join(dir, "harness.sh"), harness);

  const result = spawnSync("bash", ["harness.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    },
  });

  const calls = existsSync(callLog) ? readFileSync(callLog, "utf8").split("\n").filter(Boolean) : [];
  const recoveryPath = join(
    dir,
    "test-results/sandbox-egress/rotation-recovery-mendpoint-fettler-production.txt",
  );
  const recovery = existsSync(recoveryPath) ? readFileSync(recoveryPath, "utf8") : "";
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    calls,
    stopCalls: calls.filter((line) => line.includes("machine stop")),
    contained: recovery.includes("contain\t"),
  };
}

describe("sandbox egress rotation — the post-rotation gate may only conclude 'not alive'", () => {
  it("does NOT stop production when /livez is 200 and /healthz is 503", () => {
    // A stale backup makes /healthz 503 for reasons unrelated to egress.
    // Before this change that stopped customer production on a 6-hourly cron.
    const result = runHealthGate(200, 503);

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stopCalls).toEqual([]);
    expect(result.contained).toBe(false);
    // /healthz is still observed, just not gating.
    expect(result.calls.some((line) => line.includes("/healthz"))).toBe(true);
  }, 60_000);

  it("still contains and stops machines when /livez itself fails", () => {
    const result = runHealthGate(503, 200);

    expect(result.status).not.toBe(0);
    expect(result.stopCalls.length).toBeGreaterThan(0);
    expect(result.contained).toBe(true);
  }, 60_000);

  it("does not gate on /healthz even when both are healthy", () => {
    const result = runHealthGate(200, 200);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stopCalls).toEqual([]);
  }, 60_000);
});
