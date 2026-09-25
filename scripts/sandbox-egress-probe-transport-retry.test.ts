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
 * retry helper (`scripts/flyctl-transport-retry.sh`), not copies: the probe core
 * is extracted verbatim from the workflow between the `# probe-machine-create`
 * markers / the machine-create..forbidden-verdict span and run under
 * `bash --noprofile --norc -e -o pipefail` against a stubbed `flyctl`/`node`,
 * with a REAL `jq` so the verdict assertions are genuine.
 *
 * The safety property proved by mutation: only the act of REACHING the Fly API
 * is retried, and only on a transport-class failure classified from flyctl's
 * final `Error:` line. A verdict-bearing `flyctl machine exec` probe is never
 * retried; a real default-deny violation fails on the first observation.
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

/** Slice a shell region out of the workflow, de-indented by 10 (run: content). */
function extractRegion(startMarker: string, endMarker: string): string {
  const source = engineSource();
  const start = source.indexOf(startMarker);
  expect(start, `missing region start: ${startMarker}`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end, `missing region end: ${endMarker}`).toBeGreaterThan(-1);
  return source
    .slice(start, end + endMarker.length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

/** The probe core: machine create (idempotent retry) + status + the four exec verdicts. */
function probeCore(): string {
  return extractRegion(
    'machine_name="egress-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
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
  /** `flyctl machine run` per-attempt behaviour (last repeats): ok | transport | transport-after-create | auth. */
  runBehavior?: string;
  /** `flyctl machine status` per-attempt behaviour (last repeats): ok | transport | auth | auth-noise. */
  statusBehavior?: string;
  /** forbidden verdict probe behaviour: blocked (default) | violation | transport. */
  forbiddenBehavior?: string;
  /** MUTATION: helper classifies the whole log instead of the final Error: line. */
  mutateClassifyWholeLog?: boolean;
  /** MUTATION: helper retries regardless of classification (retries non-transport). */
  mutateRetryNonTransport?: boolean;
  /** MUTATION: route the verdict-bearing forbidden exec through the transport retry. */
  mutateRetryVerdict?: boolean;
  /** MUTATION: drop the pre-retry orphan destroy from the machine-create loop. */
  mutateDropOrphanCleanup?: boolean;
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
  mkdirSync(join(dir, "test-results", "sandbox-egress"), { recursive: true });
  const callLog = join(dir, "calls.log").replace(/\\/g, "/");
  const machinesFile = join(dir, "machines.json").replace(/\\/g, "/");
  writeFileSync(machinesFile, "[]");

  // Stubbed, stateful flyctl. `machine run` appends a machine (deterministic id
  // mN) and honours a per-attempt behaviour; `machine destroy <id>` removes it;
  // `machine list` reports current state; `machine status` honours its own
  // per-attempt behaviour; the four `machine exec` probes emit fixed policy /
  // egress JSON that the REAL jq in the region asserts. Every call is logged.
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
      '      auth) echo "Error: authentication required" >&2; exit 1 ;;',
      '    esac',
      '    ;;',
      '  *"machine destroy"*)',
      '    id="${!#}"',
      '    jq --arg id "$id" \'map(select(.id != $id))\' "$MACHINES" > "$MACHINES.t" && mv "$MACHINES.t" "$MACHINES"',
      '    exit 0 ;;',
      '  *"machine status"*)',
      '    sc=0; [ -f "$STATUS_COUNT" ] && sc="$(cat "$STATUS_COUNT")"; sc=$((sc + 1)); printf "%s" "$sc" > "$STATUS_COUNT"',
      '    read -ra __sb <<< "$STATUS_BEHAVIOR"; si=$((sc - 1)); [ "$si" -ge "${#__sb[@]}" ] && si=$(( ${#__sb[@]} - 1 ))',
      '    case "${__sb[$si]}" in',
      '      ok) printf "%s\\n" "$STATUS_JSON"; exit 0 ;;',
      '      transport) echo "Error: could not get machine m1: failed to get VM m1: Get \\"https://api.machines.dev/v1/apps/mendpoint-sandbox/machines/m1\\": read tcp 1->2:443: read: connection reset by peer" >&2; exit 1 ;;',
      '      auth) echo "Error: authentication required" >&2; exit 1 ;;',
      '      auth-noise) echo "warning: transient socket note: connection reset by peer" >&2; echo "Error: authentication required" >&2; exit 1 ;;',
      '    esac',
      '    ;;',
      '  *"machine exec"*ip6tables*) printf "%s\\n" "$IPV6_JSON"; exit 0 ;;',
      '  *"machine exec"*iptables*) printf "%s\\n" "$IPV4_JSON"; exit 0 ;;',
      '  *"machine exec"*MENDPOINT_FORBIDDEN_PROBE*)',
      '    fc=0; [ -f "$FORBID_COUNT" ] && fc="$(cat "$FORBID_COUNT")"; fc=$((fc + 1)); printf "%s" "$fc" > "$FORBID_COUNT"',
      '    case "$FORBIDDEN_BEHAVIOR" in',
      '      transport) echo "Error: could not exec: read tcp 1->2:443: read: connection reset by peer" >&2; exit 1 ;;',
      '      violation) printf "%s\\n" "$FORBIDDEN_VIOLATION_JSON"; exit 0 ;;',
      '      *) printf "%s\\n" "$FORBIDDEN_OK_JSON"; exit 0 ;;',
      '    esac',
      '    ;;',
      '  *"machine exec"*MENDPOINT_ALLOWED_PROBE*) printf "%s\\n" "$ALLOWED_JSON"; exit 0 ;;',
      '  *"machine list"*) cat "$MACHINES"; exit 0 ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "flyctl"), 0o755);

  // `node --import tsx ... -e '<probe fetch>'` -> the two probe command tokens
  // the exec calls are built from. The stub ignores all args.
  writeFileSync(
    join(binDir, "node"),
    [
      "#!/usr/bin/env bash",
      `printf '%s' '{"allowed":"MENDPOINT_ALLOWED_PROBE","forbidden":"MENDPOINT_FORBIDDEN_PROBE"}'`,
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "node"), 0o755);

  // Build the helper (optionally mutated) and the region (optionally mutated).
  let helper = helperSource();
  if (opts.mutateClassifyWholeLog) {
    // Classify the WHOLE log (grep the files) instead of the final Error: line.
    const from = 'grep -qiE "$FLY_TRANSPORT_SIGNAL" <<<"$error_line"';
    expect(helper, "classify line not found").toContain(from);
    helper = helper.replace(from, 'grep -qiE "$FLY_TRANSPORT_SIGNAL" "$@"');
  }
  if (opts.mutateRetryNonTransport) {
    // Never take the non-transport early return: retry regardless of class.
    const from = 'if ! fly_is_transport_failure "$err_file" "$out_file"; then';
    expect(helper, "classification guard not found").toContain(from);
    helper = helper.replace(from, "if false; then");
  }

  let region = probeCore();
  if (opts.mutateRetryVerdict) {
    // Route the verdict-bearing forbidden exec through the transport retry.
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

  const harness = [
    "set -euo pipefail",
    "sleep() { :; }",
    helper,
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
      FORBID_COUNT: join(dir, "forbid.count").replace(/\\/g, "/"),
      MACHINES: machinesFile,
      RUN_BEHAVIOR: opts.runBehavior ?? "ok",
      STATUS_BEHAVIOR: opts.statusBehavior ?? "ok",
      FORBIDDEN_BEHAVIOR: opts.forbiddenBehavior ?? "blocked",
      STATUS_JSON: JSON.stringify({ image: IMAGE }),
      IPV4_JSON: EXEC_OK(IPV4_STDOUT),
      IPV6_JSON: EXEC_OK(IPV6_STDOUT),
      ALLOWED_JSON: EXEC_OK("mendpoint-egress-allowed\n"),
      FORBIDDEN_OK_JSON: EXEC_OK("mendpoint-egress-blocked\n"),
      FORBIDDEN_VIOLATION_JSON: EXEC_OK("mendpoint-egress-allowed\n"),
    },
  });

  const calls = existsSync(callLog)
    ? readFileSync(callLog, "utf8").split("\n").filter(Boolean)
    : [];
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
    // The status read was retried past the reset (two calls), then succeeded.
    expect(r.statusCalls.length).toBe(2);
    // Cleanup ran on the success path: the probe machine was destroyed.
    expect(r.destroyCalls.length).toBeGreaterThan(0);
    expect(r.machinesAtEnd).toEqual([]);
  }, 60_000);

  it("a persistent transport failure on the status read fails loudly (renewal-failure alert fires)", () => {
    const r = runProbe({ statusBehavior: "transport" });
    expect(r.status).not.toBe(0);
    // Bounded at 3 attempts, then a loud failure -- the workflow's failure()-
    // guarded "Alert on renewal failure" step opens the #708-style alert.
    expect(r.statusCalls.length).toBe(3);
    expect(r.stderr).toContain("failing loudly");
    // Cleanup still runs on the failure path (EXIT trap).
    expect(r.destroyCalls.length).toBeGreaterThan(0);
    expect(r.machinesAtEnd).toEqual([]);
  }, 60_000);

  it("a real default-deny violation fails on the first observation, with no retry, even after a transport blip", () => {
    const r = runProbe({ statusBehavior: "transport ok", forbiddenBehavior: "violation" });
    expect(r.status).not.toBe(0);
    // The earlier transport blip WAS retried (status called twice)...
    expect(r.statusCalls.length).toBe(2);
    // ...but the verdict-bearing forbidden probe is observed exactly once and
    // never retried: the violation fails on first observation.
    expect(r.forbiddenExecCalls.length).toBe(1);
  }, 60_000);

  it("a machine-run transport error after the machine was created leaves no orphan, and cleanup runs", () => {
    const r = runProbe({ runBehavior: "transport-after-create ok" });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    // Two create attempts: the first landed server-side then transport-failed.
    expect(r.runCalls.length).toBe(2);
    // The orphan from attempt 1 (m1) was destroyed before the retry, and the
    // final probe machine (m2) was destroyed by cleanup: no machine survives.
    expect(r.destroyCalls.some((l) => l.trim().endsWith(" m1"))).toBe(true);
    expect(r.machinesAtEnd).toEqual([]);
  }, 60_000);

  it("a non-transport flyctl error (auth) is not retried", () => {
    const r = runProbe({ statusBehavior: "auth" });
    expect(r.status).not.toBe(0);
    // Exactly one status call: an auth error is returned immediately, no retry.
    expect(r.statusCalls.length).toBe(1);
    expect(r.stderr).toContain("non-transport flyctl error");
  }, 60_000);
});

describe("sandbox egress probe — mutations each killed", () => {
  it("(mutation) retrying a verdict: wrapping the forbidden probe in the transport retry retries it", () => {
    // Control: the shipped step observes the verdict-bearing forbidden probe
    // exactly once even when it transport-fails -- the verdict is not retried.
    const control = runProbe({ forbiddenBehavior: "transport" });
    expect(control.status).not.toBe(0);
    expect(control.forbiddenExecCalls.length, "shipped: verdict observed once").toBe(1);

    // Mutation: route the verdict through the transport retry. Now the same
    // transport failure on the verdict is retried three times -- exactly what
    // the shipped step must never do.
    const mutated = runProbe({ forbiddenBehavior: "transport", mutateRetryVerdict: true });
    expect(mutated.status).not.toBe(0);
    expect(mutated.forbiddenExecCalls.length, "mutation retries the verdict").toBe(3);
  }, 60_000);

  it("(mutation) classifying the whole log: a non-transport error with transport noise is wrongly retried", () => {
    // Control: the final Error: line is an auth error, so no retry -- even though
    // an earlier diagnostic line contains "connection reset by peer".
    const control = runProbe({ statusBehavior: "auth-noise" });
    expect(control.status).not.toBe(0);
    expect(control.statusCalls.length, "shipped: classify the Error: line only").toBe(1);

    // Mutation: classify the whole log. The stray "connection reset" now flips
    // an auth failure into a transport retry (3 attempts).
    const mutated = runProbe({ statusBehavior: "auth-noise", mutateClassifyWholeLog: true });
    expect(mutated.statusCalls.length, "mutation retries on log noise").toBe(3);
  }, 60_000);

  it("(mutation) retrying non-transport errors: an auth failure is retried", () => {
    const control = runProbe({ statusBehavior: "auth" });
    expect(control.statusCalls.length, "shipped: auth not retried").toBe(1);

    const mutated = runProbe({ statusBehavior: "auth", mutateRetryNonTransport: true });
    expect(mutated.statusCalls.length, "mutation retries everything").toBe(3);
  }, 60_000);

  it("(mutation) dropping the orphan cleanup: a retried create leaves a second orphaned machine", () => {
    // Control: the pre-retry orphan destroy leaves no machine behind (above).
    const control = runProbe({ runBehavior: "transport-after-create ok" });
    expect(control.machinesAtEnd, "shipped: no orphan").toEqual([]);

    // Mutation: without the pre-retry orphan destroy, m1 (created by the failed
    // attempt) survives -- cleanup only tears down the final machine id (m2).
    const mutated = runProbe({ runBehavior: "transport-after-create ok", mutateDropOrphanCleanup: true });
    expect(mutated.machinesAtEnd.length, "mutation leaves an orphan").toBe(1);
    expect(mutated.machinesAtEnd[0]?.id).toBe("m1");
  }, 60_000);
});

describe("flyctl-transport-retry.sh — classification unit checks", () => {
  function classify(errorLine: string, mutateWholeLog = false): { retried: number; status: number | null } {
    const dir = mkdtempSync(join(tmpdir(), "fly-retry-unit-"));
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const countFile = join(dir, "count").replace(/\\/g, "/");
    // flyctl always fails, writing the given Error: line (plus stray transport
    // noise on a non-Error line) so whole-log vs Error-line classification differ.
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
      helper = helper.replace(
        'grep -qiE "$FLY_TRANSPORT_SIGNAL" <<<"$error_line"',
        'grep -qiE "$FLY_TRANSPORT_SIGNAL" "$@"',
      );
    }
    const harness = [
      "set -euo pipefail",
      "sleep() { :; }",
      helper,
      "export FLY_RETRY_BACKOFF_SECONDS=0",
      "fly_retry probe -- flyctl x || true",
      "",
    ].join("\n");
    writeFileSync(join(dir, "h.sh"), harness);
    const result = spawnSync("bash", ["--noprofile", "--norc", "h.sh"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}${SEP}${process.env.PATH ?? ""}` },
    });
    return {
      retried: Number(readFileSync(countFile, "utf8")),
      status: result.status,
    };
  }

  it.each([
    "Error: read tcp 1->2:443: read: connection reset by peer",
    "Error: net/http: TLS handshake timeout",
    'Error: Get "https://api.machines.dev/...": read tcp 1->2:443: i/o timeout',
    "Error: Post ...: EOF",
    "Error: could not get machine m1: failed to get VM m1: read tcp ...",
    "Error: server returned a non-200 status code: 503 Service Unavailable",
  ])("retries a transport-class Error line up to 3 times: %j", (line) => {
    expect(classify(line).retried).toBe(3);
  });

  it.each([
    "Error: authentication required",
    "Error: machine not found",
    "Error: config.image: invalid image identifier",
  ])("does not retry a non-transport Error line: %j", (line) => {
    expect(classify(line).retried).toBe(1);
  });

  it("classifies from the final Error: line, not the whole log", () => {
    // The Error line is auth; a stray non-Error line elsewhere says "connection
    // reset by peer" (added by the stub). Shipped: 1 attempt; whole-log: 3.
    const line = "Error: authentication required";
    expect(classify(line).retried).toBe(1);
    // Prove the noise line would flip a whole-log classifier.
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
    const helper = helperSource().replace(
      'grep -qiE "$FLY_TRANSPORT_SIGNAL" <<<"$error_line"',
      'grep -qiE "$FLY_TRANSPORT_SIGNAL" "$@"',
    );
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
