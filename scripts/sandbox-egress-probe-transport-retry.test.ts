import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Alert #708: the scheduled sandbox egress renewal
 * (`.github/workflows/sandbox-egress-renewal.yml` -> `sandbox-egress-acceptance.yml`)
 * failed on run 36060414788 when a single `flyctl machine status` call in the
 * "Prove default deny and local execution" step hit a transient Fly Machines API
 * transport error (`... read tcp ...: read: connection reset by peer`) with no
 * retry. The receipt lives <24h and renewals run every 6h, so two blips in a row
 * crash-loop workers.
 *
 * These tests exercise the SHIPPED shell of that probe step and the SHIPPED
 * retry helper (`scripts/flyctl-transport-retry.sh`), not copies. The step region
 * is extracted verbatim from the YAML INCLUDING its `source` line, the real
 * helper is written into the harness's cwd so that `source` line resolves, and
 * the whole thing runs under `bash --noprofile --norc -e -o pipefail` against a
 * stubbed `flyctl`/`node` with a REAL `jq` so the verdict assertions are genuine.
 * Deleting the `source` line therefore breaks the step (O5 is load-bearing).
 *
 * Error shapes match what flyctl/fly-go actually print. fly-go wraps every
 * `flaps.Get` error as `could not get machine <id>: failed to get VM <id>:
 * <cause>`, so `machine not found` and `unauthorized` arrive under that prefix;
 * the classifier must NOT treat that prefix as transport (only `read tcp` /
 * `connection reset` etc. are transport). See FAILURE_MODES #19.
 */

const root = resolve(import.meta.dirname, "..");
const ENGINE_PATH = ".github/workflows/sandbox-egress-acceptance.yml";
const HELPER_PATH = "scripts/flyctl-transport-retry.sh";
const SEP = process.platform === "win32" ? ";" : ":";

function engineSource(): string {
  return readFileSync(resolve(root, ENGINE_PATH), "utf8");
}
function helperSource(): string {
  return readFileSync(resolve(root, HELPER_PATH), "utf8");
}

/** Slice a shell region out of the workflow, de-indented by `indent`. */
function extractRegion(startMarker: string, endMarker: string, indent = 10): string {
  const source = engineSource();
  const start = source.indexOf(startMarker);
  expect(start, `missing region start: ${startMarker}`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end, `missing region end: ${endMarker}`).toBeGreaterThan(-1);
  const pad = " ".repeat(indent);
  return source
    .slice(start, end + endMarker.length)
    .split("\n")
    .map((line) => (line.startsWith(pad) ? line.slice(indent) : line))
    .join("\n");
}

/**
 * The probe step from its `source` line through the forbidden verdict assertion.
 * The `source` line is included so deleting it (mutation O5) breaks the step.
 */
function probeStep(): string {
  return extractRegion(
    "source scripts/flyctl-transport-retry.sh",
    "test-results/sandbox-egress/forbidden-outbound.json >/dev/null",
  );
}

const IPV4_STDOUT =
  "-P OUTPUT DROP\n-A OUTPUT -o lo -j ACCEPT\n-A OUTPUT -j REJECT --reject-with icmp-admin-prohibited\nmendpoint-exec-ok\n";
const IPV6_STDOUT =
  "-P OUTPUT DROP\n-A OUTPUT -o lo -j ACCEPT\n-A OUTPUT -j REJECT --reject-with icmp6-adm-prohibited\nmendpoint-exec-ok\n";
const EXEC_OK = (stdout: string) => JSON.stringify({ stdout, stderr: "", exit_code: 0 });

const IMAGE = `registry.fly.io/mendpoint-sandbox@sha256:${"a".repeat(64)}`;
const TAG = "registry.fly.io/mendpoint-sandbox:deploy-1";

interface ProbeOptions {
  /** `machine run` per-attempt behaviour (last repeats): ok | transport | transport-after-create | nontransport. */
  runBehavior?: string;
  /** `machine status` per-attempt behaviour (last repeats): ok | transport | notfound | unauthorized | auth-noise. */
  statusBehavior?: string;
  /** `machine list` behaviour: ok (default) | transport. */
  listBehavior?: string;
  /** `machine destroy` behaviour: ok (default) | transport. */
  destroyBehavior?: string;
  /** forbidden verdict probe behaviour: blocked (default) | violation | transport. */
  forbiddenBehavior?: string;
  // Helper mutations (applied to the sourced helper file).
  mutateClassifyWholeLog?: boolean;
  mutateRetryNonTransport?: boolean;
  // Region mutations (applied to the extracted step).
  mutateRetryVerdict?: boolean;
  mutateDropOrphanCleanup?: boolean;
  mutateOrphanFailSilent?: boolean;
  mutateCreateRetryNonTransport?: boolean;
  mutateDeleteSource?: boolean;
}

interface ProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
  runCalls: string[];
  statusCalls: string[];
  destroyCalls: string[];
  forbiddenExecCalls: string[];
  machinesAtEnd: Array<{ id: string; name: string; state: string }>;
}

function runProbe(opts: ProbeOptions = {}): ProbeResult {
  const dir = mkdtempSync(join(tmpdir(), "egress-probe-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "test-results", "sandbox-egress"), { recursive: true });
  const callLog = join(dir, "calls.log").replace(/\\/g, "/");
  const machinesFile = join(dir, "machines.json").replace(/\\/g, "/");
  writeFileSync(machinesFile, "[]");

  // Stubbed, stateful flyctl emitting flyctl/fly-go-shaped errors.
  writeFileSync(
    join(binDir, "flyctl"),
    [
      "#!/usr/bin/env bash",
      `printf 'flyctl %s\\n' "$*" >>"${callLog}"`,
      'case "$*" in',
      '  *"machine run"*)',
      '    rn=0; [ -f "$RUN_COUNT" ] && rn="$(cat "$RUN_COUNT")"; rn=$((rn + 1)); printf "%s" "$rn" > "$RUN_COUNT"',
      '    read -ra __rb <<< "$RUN_BEHAVIOR"; ri=$((rn - 1)); [ "$ri" -ge "${#__rb[@]}" ] && ri=$(( ${#__rb[@]} - 1 ))',
      '    name=""; prev=""; for a in "$@"; do [ "$prev" = "--name" ] && name="$a"; prev="$a"; done',
      '    id="m${rn}"',
      '    add_machine() { jq --arg id "$id" --arg name "$name" \'. + [{"id":$id,"name":$name,"state":"started"}]\' "$MACHINES" > "$MACHINES.t" && mv "$MACHINES.t" "$MACHINES"; }',
      '    case "${__rb[$ri]}" in',
      '      ok) add_machine; printf "Machine ID: %s\\n" "$id"; exit 0 ;;',
      '      transport-after-create) add_machine; echo "Error: failed to launch VM $id: Post \\"https://api.machines.dev/...\\": read tcp 1->2:443: read: connection reset by peer" >&2; exit 1 ;;',
      '      transport) echo "Error: failed to launch VM: read tcp 1->2:443: read: connection reset by peer" >&2; exit 1 ;;',
      '      nontransport) echo "Error: failed to launch VM: unauthorized" >&2; exit 1 ;;',
      '    esac',
      '    ;;',
      '  *"machine destroy"*)',
      '    if [ "${DESTROY_BEHAVIOR:-ok}" = "transport" ]; then echo "Error: could not get machine: failed to get VM: read tcp 1->2:443: read: connection reset by peer" >&2; exit 1; fi',
      '    id="${!#}"',
      '    jq --arg id "$id" \'map(select(.id != $id))\' "$MACHINES" > "$MACHINES.t" && mv "$MACHINES.t" "$MACHINES"',
      '    exit 0 ;;',
      '  *"machine status"*)',
      '    sc=0; [ -f "$STATUS_COUNT" ] && sc="$(cat "$STATUS_COUNT")"; sc=$((sc + 1)); printf "%s" "$sc" > "$STATUS_COUNT"',
      '    read -ra __sb <<< "$STATUS_BEHAVIOR"; si=$((sc - 1)); [ "$si" -ge "${#__sb[@]}" ] && si=$(( ${#__sb[@]} - 1 ))',
      '    case "${__sb[$si]}" in',
      '      ok) printf "%s\\n" "$STATUS_JSON"; exit 0 ;;',
      '      transport) echo "Error: could not get machine m1: failed to get VM m1: Get \\"https://api.machines.dev/v1/apps/mendpoint-sandbox/machines/m1\\": read tcp 1->2:443: read: connection reset by peer" >&2; exit 1 ;;',
      '      notfound) echo "Error: could not get machine m1: failed to get VM m1: machine not found" >&2; exit 1 ;;',
      '      unauthorized) echo "Error: could not get machine m1: failed to get VM m1: unauthorized" >&2; exit 1 ;;',
      '      auth-noise) echo "Failed to fetch machine details: connection reset by peer" >&2; echo "Error: could not get machine m1: failed to get VM m1: unauthorized" >&2; exit 1 ;;',
      '    esac',
      '    ;;',
      '  *"machine exec"*ip6tables*) printf "%s\\n" "$IPV6_JSON"; exit 0 ;;',
      '  *"machine exec"*iptables*) printf "%s\\n" "$IPV4_JSON"; exit 0 ;;',
      '  *"machine exec"*MENDPOINT_FORBIDDEN_PROBE*)',
      '    case "$FORBIDDEN_BEHAVIOR" in',
      '      transport) echo "Error: could not exec: read tcp 1->2:443: read: connection reset by peer" >&2; exit 1 ;;',
      '      violation) printf "%s\\n" "$FORBIDDEN_VIOLATION_JSON"; exit 0 ;;',
      '      *) printf "%s\\n" "$FORBIDDEN_OK_JSON"; exit 0 ;;',
      '    esac',
      '    ;;',
      '  *"machine exec"*MENDPOINT_ALLOWED_PROBE*) printf "%s\\n" "$ALLOWED_JSON"; exit 0 ;;',
      '  *"machine list"*)',
      '    if [ "${LIST_BEHAVIOR:-ok}" = "transport" ]; then echo "Error: could not list machines: read tcp 1->2:443: read: connection reset by peer" >&2; exit 1; fi',
      '    cat "$MACHINES"; exit 0 ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "flyctl"), 0o755);

  writeFileSync(
    join(binDir, "node"),
    ["#!/usr/bin/env bash", `printf '%s' '{"allowed":"MENDPOINT_ALLOWED_PROBE","forbidden":"MENDPOINT_FORBIDDEN_PROBE"}'`, ""].join("\n"),
  );
  chmodSync(join(binDir, "node"), 0o755);

  // Write the (optionally mutated) SHIPPED helper where the step's `source` line resolves.
  let helper = helperSource();
  if (opts.mutateClassifyWholeLog) {
    const from = 'grep -qiE "$FLY_TRANSPORT_SIGNAL" <<<"$error_line"';
    expect(helper, "classify line not found").toContain(from);
    helper = helper.replace(from, 'grep -qiE "$FLY_TRANSPORT_SIGNAL" "$@"');
  }
  if (opts.mutateRetryNonTransport) {
    const from = 'if ! fly_is_transport_failure "$err_file" "$out_file"; then';
    expect(helper, "classification guard not found").toContain(from);
    helper = helper.replace(from, "if false; then");
  }
  writeFileSync(join(dir, "scripts", "flyctl-transport-retry.sh"), helper);

  let region = probeStep();
  if (opts.mutateDeleteSource) {
    const before = region;
    region = region.replace(/^source scripts\/flyctl-transport-retry\.sh\n/m, "");
    expect(region, "delete-source mutation did not apply").not.toBe(before);
  }
  if (opts.mutateRetryVerdict) {
    const before = region;
    region = region.replace(
      /flyctl machine exec "\$machine_id" \\\n\s*--app "\$MENDPOINT_SANDBOX_EGRESS_APP" \\\n\s*--json "runuser -u node -- \$forbidden_probe" \\\n\s*>test-results\/sandbox-egress\/forbidden-outbound\.json/,
      [
        'fly_retry verdict -- flyctl machine exec "$machine_id" \\',
        '  --app "$MENDPOINT_SANDBOX_EGRESS_APP" \\',
        '  --json "runuser -u node -- $forbidden_probe"',
        "printf '%s\\n' \"$FLY_RETRY_STDOUT\" >test-results/sandbox-egress/forbidden-outbound.json",
      ].join("\n"),
    );
    expect(region, "verdict-retry mutation did not apply").not.toBe(before);
  }
  if (opts.mutateDropOrphanCleanup) {
    const start = region.indexOf("# probe-orphan-destroy-begin");
    const endMarker = "# probe-orphan-destroy-end";
    const end = region.indexOf(endMarker);
    expect(start, "orphan-destroy start marker not found").toBeGreaterThan(-1);
    expect(end, "orphan-destroy end marker not found").toBeGreaterThan(start);
    region = region.slice(0, start) + region.slice(end + endMarker.length);
  }
  if (opts.mutateOrphanFailSilent) {
    // Revert the loud fail-on-orphan-error back to the old `|| true` blind retry.
    const before = region;
    region = region
      .replace(
        /if ! fly_retry create-orphan-list -- flyctl machine list --app "\$MENDPOINT_SANDBOX_EGRESS_APP" --json; then\n[\s\S]*?exit 1\n\s*fi/,
        'fly_retry create-orphan-list -- flyctl machine list --app "$MENDPOINT_SANDBOX_EGRESS_APP" --json || true',
      )
      .replace(
        /if ! fly_retry create-orphan-destroy -- flyctl machine destroy --force --app "\$MENDPOINT_SANDBOX_EGRESS_APP" "\$orphan_id"; then\n[\s\S]*?exit 1\n\s*fi/,
        'fly_retry create-orphan-destroy -- flyctl machine destroy --force --app "$MENDPOINT_SANDBOX_EGRESS_APP" "$orphan_id" || true',
      );
    expect(region, "orphan-fail-silent mutation did not apply").not.toBe(before);
  }
  if (opts.mutateCreateRetryNonTransport) {
    const from = 'if ! fly_is_transport_failure "$create_err" "$create_out"; then';
    expect(region, "create-loop classification guard not found").toContain(from);
    region = region.replace(from, "if false; then");
  }

  const harness = [
    "set -euo pipefail",
    "sleep() { :; }",
    `export FLY_RETRY_BACKOFF_SECONDS=0`,
    `export SANDBOX_IMAGE_TAG="${TAG}"`,
    `export MENDPOINT_SANDBOX_EGRESS_APP="mendpoint-sandbox"`,
    `export MENDPOINT_SANDBOX_EGRESS_IMAGE="${IMAGE}"`,
    `export GITHUB_RUN_ID="900"`,
    `export GITHUB_RUN_ATTEMPT="1"`,
    region,
    "",
  ].join("\n");
  writeFileSync(join(dir, "harness.sh"), harness);

  const result = spawnSync("bash", ["--noprofile", "--norc", "harness.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${SEP}${process.env.PATH ?? ""}`,
      RUN_COUNT: join(dir, "run.count").replace(/\\/g, "/"),
      STATUS_COUNT: join(dir, "status.count").replace(/\\/g, "/"),
      MACHINES: machinesFile,
      RUN_BEHAVIOR: opts.runBehavior ?? "ok",
      STATUS_BEHAVIOR: opts.statusBehavior ?? "ok",
      LIST_BEHAVIOR: opts.listBehavior ?? "ok",
      DESTROY_BEHAVIOR: opts.destroyBehavior ?? "ok",
      FORBIDDEN_BEHAVIOR: opts.forbiddenBehavior ?? "blocked",
      STATUS_JSON: JSON.stringify({ image: IMAGE }),
      IPV4_JSON: EXEC_OK(IPV4_STDOUT),
      IPV6_JSON: EXEC_OK(IPV6_STDOUT),
      ALLOWED_JSON: EXEC_OK("mendpoint-egress-allowed\n"),
      FORBIDDEN_OK_JSON: EXEC_OK("mendpoint-egress-blocked\n"),
      FORBIDDEN_VIOLATION_JSON: EXEC_OK("mendpoint-egress-allowed\n"),
    },
  });

  const calls = existsSync(callLog) ? readFileSync(callLog, "utf8").split("\n").filter(Boolean) : [];
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    calls,
    runCalls: calls.filter((l) => l.includes("machine run")),
    statusCalls: calls.filter((l) => l.includes("machine status")),
    destroyCalls: calls.filter((l) => l.includes("machine destroy")),
    forbiddenExecCalls: calls.filter((l) => l.includes("machine exec") && l.includes("MENDPOINT_FORBIDDEN_PROBE")),
    machinesAtEnd: JSON.parse(readFileSync(machinesFile, "utf8")),
  };
}

describe("sandbox egress probe — transport blips are retried, verdicts are not", () => {
  it("a transport reset on the machine status read, then success: the step passes", () => {
    const r = runProbe({ statusBehavior: "transport ok" });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.statusCalls.length).toBe(2);
    expect(r.destroyCalls.length).toBeGreaterThan(0);
    expect(r.machinesAtEnd).toEqual([]);
  }, 60_000);

  it("a persistent transport failure on the status read fails loudly (renewal-failure alert fires)", () => {
    const r = runProbe({ statusBehavior: "transport" });
    expect(r.status).not.toBe(0);
    expect(r.statusCalls.length).toBe(3);
    expect(r.stderr).toContain("failing loudly");
    expect(r.destroyCalls.length).toBeGreaterThan(0);
    expect(r.machinesAtEnd).toEqual([]);
  }, 60_000);

  it("a real default-deny violation fails on the first observation, with no retry, even after a transport blip", () => {
    const r = runProbe({ statusBehavior: "transport ok", forbiddenBehavior: "violation" });
    expect(r.status).not.toBe(0);
    expect(r.statusCalls.length).toBe(2);
    expect(r.forbiddenExecCalls.length).toBe(1);
  }, 60_000);

  it("a machine-run transport error after the machine was created leaves no orphan, and cleanup runs", () => {
    const r = runProbe({ runBehavior: "transport-after-create ok" });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.runCalls.length).toBe(2);
    expect(r.destroyCalls.some((l) => l.trim().endsWith(" m1"))).toBe(true);
    expect(r.machinesAtEnd).toEqual([]);
  }, 60_000);
});

describe("sandbox egress probe — flyctl-shaped non-transport errors are NOT retried (blocker #708 fix)", () => {
  // fly-go wraps every flaps.Get error as "could not get machine X: failed to
  // get VM X: <cause>". The classifier must not treat that prefix as transport.
  it.each([
    ["notfound", "machine not found"],
    ["unauthorized", "a revoked token / unauthorized"],
  ])("a %s error under the `failed to get VM` prefix runs the status read exactly once", (behavior) => {
    const r = runProbe({ statusBehavior: behavior });
    expect(r.status).not.toBe(0);
    expect(r.statusCalls.length, "must not be retried as transport").toBe(1);
    expect(r.stderr).toContain("non-transport flyctl error");
  }, 60_000);

  it("the #708 line (read tcp / connection reset under the same prefix) IS still retried", () => {
    const r = runProbe({ statusBehavior: "transport ok" });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.statusCalls.length).toBe(2);
  }, 60_000);
});

describe("sandbox egress probe — orphan compound-fault fails loudly, never a blind retry", () => {
  it("fails loudly (no blind create retry, no silent mint) when the orphan LIST keeps transport-failing", () => {
    const r = runProbe({ runBehavior: "transport-after-create ok", listBehavior: "transport" });
    expect(r.status).not.toBe(0);
    // The create was attempted once; it was NOT retried blind into a second machine.
    expect(r.runCalls.length).toBe(1);
    expect(r.stderr).toContain("failing loudly rather than retrying the create blind");
  }, 60_000);

  it("fails loudly when the orphan DESTROY keeps transport-failing", () => {
    const r = runProbe({ runBehavior: "transport-after-create ok", destroyBehavior: "transport" });
    expect(r.status).not.toBe(0);
    expect(r.runCalls.length).toBe(1);
    expect(r.stderr).toContain("failing loudly rather than retrying the create blind");
  }, 60_000);
});

/**
 * Rotation-step wraps: the two top-level non-verdict reads that gate the whole
 * rotation. Extracted verbatim from the YAML and run through the SHIPPED helper.
 */
interface RotationReadOptions {
  which: "apps" | "preflight";
  behavior: string; // machine list / apps list per-attempt: transport | ok
  revertWrap?: boolean; // MUTATION O6: revert to the pre-fix `$(...)` form.
}
function runRotationRead(opts: RotationReadOptions): { status: number | null; stderr: string; calls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "egress-rot-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const callLog = join(dir, "calls.log").replace(/\\/g, "/");
  writeFileSync(
    join(binDir, "flyctl"),
    [
      "#!/usr/bin/env bash",
      `printf 'flyctl %s\\n' "$*" >>"${callLog}"`,
      'n=0; [ -f "$C" ] && n="$(cat "$C")"; n=$((n + 1)); printf "%s" "$n" > "$C"',
      'read -ra b <<< "$BEHAVIOR"; i=$((n - 1)); [ "$i" -ge "${#b[@]}" ] && i=$(( ${#b[@]} - 1 ))',
      'case "${b[$i]}" in',
      '  ok) printf "%s\\n" "$JSON"; exit 0 ;;',
      '  transport) echo "Error: could not list: read tcp 1->2:443: read: connection reset by peer" >&2; exit 1 ;;',
      'esac',
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "flyctl"), 0o755);

  const shipped =
    opts.which === "apps"
      ? 'fly_retry apps-list -- flyctl apps list --json\napps_json="$FLY_RETRY_STDOUT"'
      : 'fly_retry preflight-list -- flyctl machine list --app "$app" --json\nmachines_json="$FLY_RETRY_STDOUT"';
  const reverted =
    opts.which === "apps"
      ? 'apps_json="$(flyctl apps list --json)"'
      : 'machines_json="$(flyctl machine list --app "$app" --json)"';
  // Confirm the shipped form is present verbatim in the workflow (guards drift).
  expect(engineSource(), `shipped ${opts.which} wrap not found in YAML`).toContain(
    opts.which === "apps"
      ? "fly_retry apps-list -- flyctl apps list --json"
      : 'fly_retry preflight-list -- flyctl machine list --app "$app" --json',
  );
  const body = opts.revertWrap ? reverted : shipped;

  const harness = [
    "set -euo pipefail",
    "sleep() { :; }",
    helperSource(),
    "export FLY_RETRY_BACKOFF_SECONDS=0",
    'app="mendpoint-warden-preview"',
    body,
    "",
  ].join("\n");
  writeFileSync(join(dir, "h.sh"), harness);
  const result = spawnSync("bash", ["--noprofile", "--norc", "h.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${SEP}${process.env.PATH ?? ""}`,
      C: join(dir, "c").replace(/\\/g, "/"),
      BEHAVIOR: opts.behavior,
      JSON: "[]",
    },
  });
  const calls = existsSync(callLog) ? readFileSync(callLog, "utf8").split("\n").filter(Boolean) : [];
  return { status: result.status, stderr: result.stderr ?? "", calls };
}

describe("sandbox egress rotation — the top-level reads are transport-retried (O6)", () => {
  it.each(["apps", "preflight"] as const)("%s list: a transport blip then success is retried", (which) => {
    const r = runRotationRead({ which, behavior: "transport ok" });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.calls.length, "retried past the blip").toBe(2);
  }, 60_000);

  it.each(["apps", "preflight"] as const)("(mutation) reverting the %s wrap loses the retry", (which) => {
    const control = runRotationRead({ which, behavior: "transport ok" });
    expect(control.status, "control: shipped wrap retries").toBe(0);
    const mutated = runRotationRead({ which, behavior: "transport ok", revertWrap: true });
    // The bare $(...) form aborts under set -e on the first blip: one call, non-zero.
    expect(mutated.status, "mutation: bare command substitution is not retried").not.toBe(0);
    expect(mutated.calls.length).toBe(1);
  }, 60_000);
});

describe("sandbox egress probe — mutations each killed", () => {
  it("(mutation) retrying a verdict: wrapping the forbidden probe in the transport retry retries it", () => {
    const control = runProbe({ forbiddenBehavior: "transport" });
    expect(control.status).not.toBe(0);
    expect(control.forbiddenExecCalls.length, "shipped: verdict observed once").toBe(1);
    const mutated = runProbe({ forbiddenBehavior: "transport", mutateRetryVerdict: true });
    expect(mutated.status).not.toBe(0);
    expect(mutated.forbiddenExecCalls.length, "mutation retries the verdict").toBe(3);
  }, 60_000);

  it("(mutation) classifying the whole log: a non-transport error with transport noise is wrongly retried", () => {
    const control = runProbe({ statusBehavior: "auth-noise" });
    expect(control.status).not.toBe(0);
    expect(control.statusCalls.length, "shipped: classify the Error: line only").toBe(1);
    const mutated = runProbe({ statusBehavior: "auth-noise", mutateClassifyWholeLog: true });
    expect(mutated.statusCalls.length, "mutation retries on log noise").toBe(3);
  }, 60_000);

  it("(mutation) retrying non-transport errors (helper): a not-found failure is retried", () => {
    const control = runProbe({ statusBehavior: "notfound" });
    expect(control.statusCalls.length, "shipped: not-found not retried").toBe(1);
    const mutated = runProbe({ statusBehavior: "notfound", mutateRetryNonTransport: true });
    expect(mutated.statusCalls.length, "mutation retries everything").toBe(3);
  }, 60_000);

  it("(mutation O8) create loop retries a non-transport error", () => {
    const control = runProbe({ runBehavior: "nontransport" });
    expect(control.status).not.toBe(0);
    expect(control.runCalls.length, "shipped: create not retried on a non-transport error").toBe(1);
    const mutated = runProbe({ runBehavior: "nontransport", mutateCreateRetryNonTransport: true });
    expect(mutated.runCalls.length, "mutation retries the create on a non-transport error").toBe(3);
  }, 60_000);

  it("(mutation) dropping the orphan cleanup: a retried create leaves a second orphaned machine", () => {
    const control = runProbe({ runBehavior: "transport-after-create ok" });
    expect(control.machinesAtEnd, "shipped: no orphan").toEqual([]);
    const mutated = runProbe({ runBehavior: "transport-after-create ok", mutateDropOrphanCleanup: true });
    expect(mutated.machinesAtEnd.length, "mutation leaves an orphan").toBe(1);
    expect(mutated.machinesAtEnd[0]?.id).toBe("m1");
  }, 60_000);

  it("(mutation) orphan list/destroy failing silently: a blind create retry mints with an orphan running", () => {
    const control = runProbe({ runBehavior: "transport-after-create ok", listBehavior: "transport" });
    expect(control.status, "shipped: fails loudly").not.toBe(0);
    expect(control.runCalls.length, "shipped: no blind create retry").toBe(1);
    const mutated = runProbe({
      runBehavior: "transport-after-create ok",
      listBehavior: "transport",
      mutateOrphanFailSilent: true,
    });
    // With the old `|| true`, the create is retried blind: a second machine is
    // created and the step succeeds with the m1 orphan still running.
    expect(mutated.runCalls.length, "mutation retries the create blind").toBe(2);
    expect(mutated.machinesAtEnd.some((m) => m.id === "m1"), "mutation leaks the orphan").toBe(true);
  }, 60_000);

  it("(mutation O5) deleting the `source` line breaks the shipped step", () => {
    const control = runProbe({});
    expect(control.status, "control: sourced helper works").toBe(0);
    const mutated = runProbe({ mutateDeleteSource: true });
    // Without the source, fly_retry is undefined: the step cannot run.
    expect(mutated.status, "mutation: no helper, step fails").not.toBe(0);
    expect(mutated.stderr).toMatch(/fly_retry: (command )?not found/);
  }, 60_000);
});

describe("flyctl-transport-retry.sh — classification unit checks", () => {
  function classify(errorLine: string, mutateWholeLog = false): { retried: number; status: number | null } {
    const dir = mkdtempSync(join(tmpdir(), "fly-retry-unit-"));
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const countFile = join(dir, "count").replace(/\\/g, "/");
    writeFileSync(
      join(binDir, "flyctl"),
      [
        "#!/usr/bin/env bash",
        `n=0; [ -f "${countFile}" ] && n="$(cat "${countFile}")"; n=$((n + 1)); printf '%s' "$n" > "${countFile}"`,
        'echo "note: some unrelated line" >&2',
        `echo ${JSON.stringify(errorLine)} >&2`,
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, "flyctl"), 0o755);
    let helper = helperSource();
    if (mutateWholeLog) {
      helper = helper.replace('grep -qiE "$FLY_TRANSPORT_SIGNAL" <<<"$error_line"', 'grep -qiE "$FLY_TRANSPORT_SIGNAL" "$@"');
    }
    writeFileSync(
      join(dir, "h.sh"),
      ["set -euo pipefail", "sleep() { :; }", helper, "export FLY_RETRY_BACKOFF_SECONDS=0", "fly_retry probe -- flyctl x || true", ""].join("\n"),
    );
    const result = spawnSync("bash", ["--noprofile", "--norc", "h.sh"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}${SEP}${process.env.PATH ?? ""}` },
    });
    return { retried: Number(readFileSync(countFile, "utf8")), status: result.status };
  }

  it.each([
    "Error: read tcp 1->2:443: read: connection reset by peer",
    "Error: net/http: TLS handshake timeout",
    'Error: Get "https://api.machines.dev/...": read tcp 1->2:443: i/o timeout',
    "Error: Post ...: EOF",
    // The exact #708 shape: transport under the `failed to get VM` prefix.
    'Error: could not get machine 80537dc6644038: failed to get VM 80537dc6644038: Get "https://api.machines.dev/v1/apps/mendpoint-sandbox/machines/80537dc6644038": read tcp 1->2:443: read: connection reset by peer',
    "Error: server returned a non-200 status code: 503 Service Unavailable",
  ])("retries a transport-class Error line up to 3 times: %j", (line) => {
    expect(classify(line).retried).toBe(3);
  });

  it.each([
    // flyctl/fly-go real shapes: non-transport causes under the Get wrapper.
    "Error: could not get machine 80537dc6644038: failed to get VM 80537dc6644038: machine not found",
    "Error: could not get machine 80537dc6644038: failed to get VM 80537dc6644038: unauthorized",
    "Error: failed to launch VM: invalid image identifier",
  ])("does not retry a non-transport Error line (incl. the `failed to get VM` prefix): %j", (line) => {
    expect(classify(line).retried).toBe(1);
  });

  it("classifies from the final Error: line, not the whole log", () => {
    const line = "Error: could not get machine m1: failed to get VM m1: unauthorized";
    expect(classify(line).retried).toBe(1);
    // A stray non-Error noise line with transport text flips a whole-log classifier.
    const dir = mkdtempSync(join(tmpdir(), "fly-retry-noise-"));
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const countFile = join(dir, "count").replace(/\\/g, "/");
    writeFileSync(
      join(binDir, "flyctl"),
      [
        "#!/usr/bin/env bash",
        `n=0; [ -f "${countFile}" ] && n="$(cat "${countFile}")"; n=$((n + 1)); printf '%s' "$n" > "${countFile}"`,
        'echo "diagnostic: connection reset by peer" >&2',
        `echo ${JSON.stringify(line)} >&2`,
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, "flyctl"), 0o755);
    const helper = helperSource().replace('grep -qiE "$FLY_TRANSPORT_SIGNAL" <<<"$error_line"', 'grep -qiE "$FLY_TRANSPORT_SIGNAL" "$@"');
    writeFileSync(
      join(dir, "h.sh"),
      ["set -euo pipefail", "sleep() { :; }", helper, "export FLY_RETRY_BACKOFF_SECONDS=0", "fly_retry probe -- flyctl x || true", ""].join("\n"),
    );
    const result = spawnSync("bash", ["--noprofile", "--norc", "h.sh"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}${SEP}${process.env.PATH ?? ""}` },
    });
    expect(result.status).toBe(0);
    expect(Number(readFileSync(countFile, "utf8")), "whole-log classifier retries on noise").toBe(3);
  });
});
