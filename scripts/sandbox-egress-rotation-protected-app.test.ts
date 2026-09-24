import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * These tests exercise the SHIPPED rotation shell of
 * `.github/workflows/sandbox-egress-acceptance.yml`, not a copy: the protected-app
 * determination, `contain_current_machines`, and the post-rotation readiness
 * block are extracted verbatim from the workflow and run against a stubbed
 * `flyctl`/`curl`. "No customer machine was stopped" is therefore proved by the
 * ABSENCE of a real `flyctl machine stop` invocation, and "a stopped machine was
 * recovered" by the PRESENCE of a real `flyctl machine start`.
 *
 * Incident context (run 33890068837): a scheduled rotation stopped the customer
 * production machine mendpoint-fettler-production/84e696a22eee68 via
 * contain_current_machines; with auto_start_machines=false it stayed stopped for
 * 4.5h. The fix makes protected consuming apps start-not-stop and fail loudly.
 */

const root = resolve(import.meta.dirname, "..");
const ENGINE_PATH = ".github/workflows/sandbox-egress-acceptance.yml";
const SEP = process.platform === "win32" ? ";" : ":";

function engineSource(): string {
  return readFileSync(resolve(root, ENGINE_PATH), "utf8");
}

/** Slice a shell region out of the workflow, de-indented, failing loudly. */
function extractRegion(startMarker: string, endMarker: string): string {
  const source = engineSource();
  const start = source.indexOf(startMarker);
  expect(start, `missing region start: ${startMarker}`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end, `missing region end: ${endMarker}`).toBeGreaterThan(-1);
  return source
    .slice(start, end + endMarker.length)
    .split("\n")
    .map((line) => (line.startsWith("            ") ? line.slice(12) : line))
    .join("\n");
}

/** The protected-vs-not determination at the top of the per-app loop. */
function determinationBlock(): string {
  return extractRegion(
    "            # Is THIS app protected (customer production that must never be",
    "            done < <(printf '%s\\n' \"$protected_prefixes\" | tr ',' '\\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')",
  );
}

/**
 * The shipped contain_current_machines. With `stripGuard`, the protected branch
 * is removed so a test can prove the guard is load-bearing (mutation).
 */
function containFn(stripGuard = false): string {
  let fn = extractRegion("            contain_current_machines() {", "\n            }\n");
  if (stripGuard) {
    const guardStart = fn.indexOf('if [ "${is_protected_app:-true}" = true ]; then');
    const guardEnd = fn.indexOf("# --- NON-PROTECTED consuming apps: fail-closed containment ---");
    expect(guardStart, "protected guard start not found").toBeGreaterThan(-1);
    expect(guardEnd, "protected guard end not found").toBeGreaterThan(guardStart);
    fn = fn.slice(0, guardStart) + fn.slice(guardEnd);
  }
  return fn;
}

/** The bounded readiness wait + post-state block. */
function healthBlock(): string {
  return extractRegion(
    "            # Bounded readiness wait + post-state assertion (replaces the old",
    'echo "The app $app did not become healthy after receipt rotation"\n              exit 1\n            fi',
  );
}

interface Machine {
  id: string;
  state: "started" | "stopped";
}

interface ScenarioOptions {
  app: string;
  /** Repo var value. Empty string exercises the safe default (fettler). */
  protectedPrefixes?: string;
  /** BEFORE snapshot (what the Launch guard saw: every machine started). */
  beforeMachines: Machine[];
  /** AFTER-update live state the flyctl stub starts from. */
  currentMachines: Machine[];
  /** Successive /livez HTTP codes; the last value repeats. */
  livez?: number[];
  healthz?: number;
  readinessTimeoutSeconds?: number | string;
  stripGuard?: boolean;
}

interface ScenarioResult {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
  startCalls: string[];
  stopCalls: string[];
  livezCalls: string[];
  recovery: string;
}

function runScenario(opts: ScenarioOptions): ScenarioResult {
  const dir = mkdtempSync(join(tmpdir(), "egress-protected-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  mkdirSync(join(dir, "test-results", "sandbox-egress"), { recursive: true });
  const callLog = join(dir, "calls.log").replace(/\\/g, "/");
  const curFile = join(dir, "machines-current.json").replace(/\\/g, "/");
  const livezCount = join(dir, "livez.count").replace(/\\/g, "/");
  writeFileSync(join(dir, "machines-current.json"), JSON.stringify(opts.currentMachines));

  // Stateful flyctl: `machine start` flips every machine to started, `machine
  // stop` flips to stopped, `machine list` reports the current state. A single
  // machine is enough for these tests, so flipping all is faithful.
  writeFileSync(
    join(binDir, "flyctl"),
    [
      "#!/usr/bin/env bash",
      `printf 'flyctl %s\\n' "$*" >>"${callLog}"`,
      `CUR="${curFile}"`,
      'case "$*" in',
      "  *\"machine start\"*) jq 'map(.state = \"started\")' \"$CUR\" > \"$CUR.tmp\" && mv \"$CUR.tmp\" \"$CUR\" ;;",
      "  *\"machine stop\"*) jq 'map(.state = \"stopped\")' \"$CUR\" > \"$CUR.tmp\" && mv \"$CUR.tmp\" \"$CUR\" ;;",
      '  *"machine list"*) cat "$CUR" ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "flyctl"), 0o755);

  // curl as a FUNCTION so the readiness loop does not spawn a process per poll.
  // /livez returns the Nth code from LIVEZ_SEQ (clamped to last); /healthz honours
  // --output/--write-out exactly as the workflow consumes them.
  const curlStub = [
    "curl() {",
    '  local url="${!#}"',
    '  case "$url" in',
    "    */livez)",
    "      local n=0",
    `      [ -f "${livezCount}" ] && n=$(cat "${livezCount}")`,
    "      n=$((n + 1))",
    `      printf '%s' "$n" > "${livezCount}"`,
    "      local -a seq_arr",
    '      read -ra seq_arr <<< "$LIVEZ_SEQ"',
    "      local idx=$((n - 1))",
    '      if [ "$idx" -ge "${#seq_arr[@]}" ]; then idx=$(( ${#seq_arr[@]} - 1 )); fi',
    '      local status="${seq_arr[$idx]}"',
    `      printf 'curl %s -> %s\\n' "$url" "$status" >>"${callLog}"`,
    '      [ "$status" = "200" ] || return 22',
    "      return 0",
    "      ;;",
    "    */healthz)",
    '      local status="${HEALTHZ_STATUS:-200}"',
    '      local outfile="" prev=""',
    '      for a in "$@"; do [ "$prev" = "--output" ] && outfile="$a"; prev="$a"; done',
    `      printf 'curl %s -> %s\\n' "$url" "$status" >>"${callLog}"`,
    '      [ -n "$outfile" ] && printf \'{}\' > "$outfile"',
    "      for a in \"$@\"; do [ \"$a\" = \"--write-out\" ] && printf '%s' \"$status\"; done",
    "      return 0",
    "      ;;",
    "    *) return 0 ;;",
    "  esac",
    "}",
  ].join("\n");

  const harness = [
    "set -uo pipefail",
    `app="${opts.app}"`,
    `export SANDBOX_EGRESS_PROTECTED_APP_PREFIXES="${opts.protectedPrefixes ?? ""}"`,
    opts.readinessTimeoutSeconds != null
      ? `export SANDBOX_EGRESS_READINESS_TIMEOUT_SECONDS="${opts.readinessTimeoutSeconds}"`
      : "",
    `export LIVEZ_SEQ="${(opts.livez ?? [200]).join(" ")}"`,
    `export HEALTHZ_STATUS="${opts.healthz ?? 200}"`,
    // The BEFORE snapshot the health block reads for started_before_ids.
    `machines_json='${JSON.stringify(opts.beforeMachines)}'`,
    "sleep() { :; }",
    curlStub,
    determinationBlock(),
    containFn(opts.stripGuard),
    healthBlock(),
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
  writeFileSync(join(dir, "harness.sh"), harness);

  const result = spawnSync("bash", ["harness.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}${SEP}${process.env.PATH ?? ""}` },
  });

  const calls = existsSync(callLog)
    ? readFileSync(callLog, "utf8").split("\n").filter(Boolean)
    : [];
  const recoveryPath = join(
    dir,
    "test-results",
    "sandbox-egress",
    `rotation-recovery-${opts.app}.txt`,
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    calls,
    startCalls: calls.filter((line) => line.includes("machine start")),
    stopCalls: calls.filter((line) => line.includes("machine stop")),
    livezCalls: calls.filter((line) => line.includes("/livez")),
    recovery: existsSync(recoveryPath) ? readFileSync(recoveryPath, "utf8") : "",
  };
}

const STARTED: Machine[] = [{ id: "84e696a22eee68", state: "started" }];
const STOPPED: Machine[] = [{ id: "84e696a22eee68", state: "stopped" }];

describe("sandbox egress rotation — protected consuming apps are never stopped", () => {
  it("(a) starts, never stops, a protected app whose machine is stopped after the update", () => {
    // Default prefixes (empty var) must protect customer production.
    const result = runScenario({
      app: "mendpoint-fettler-production",
      protectedPrefixes: "",
      beforeMachines: STARTED,
      currentMachines: STOPPED,
      livez: [503],
      readinessTimeoutSeconds: 20,
    });

    expect(result.status, `stderr: ${result.stderr}`).not.toBe(0);
    // The load-bearing guarantees.
    expect(result.startCalls.length).toBeGreaterThan(0);
    expect(result.stopCalls).toEqual([]);
    // Fails loudly with a reason that names the app.
    expect(result.recovery).toContain("protect\t");
    expect(result.recovery).toContain("protected_not_stopped");
    expect(result.recovery).toContain("app=mendpoint-fettler-production");
    expect(result.stderr).toContain("PROTECTED app mendpoint-fettler-production was NOT stopped");
  }, 60_000);

  it("(b) leaves the previous stop-based containment unchanged for a non-protected app", () => {
    const result = runScenario({
      app: "mendpoint-warden-preview",
      protectedPrefixes: "mendpoint-fettler-production",
      beforeMachines: STARTED,
      currentMachines: STARTED,
      livez: [503],
      readinessTimeoutSeconds: 20,
    });

    expect(result.status).not.toBe(0);
    // Non-protected apps still fail closed by stopping, and never start.
    expect(result.stopCalls.length).toBeGreaterThan(0);
    expect(result.startCalls).toEqual([]);
    expect(result.recovery).toContain("contain\t");
    expect(result.recovery).toContain("containment_proven");
    expect(result.recovery).not.toContain("protected_not_stopped");
  }, 60_000);

  it("(c) readiness wait tolerates a /livez that turns 200 after 40s", () => {
    // interval 10s: attempt 5 == 40s. Window 60s (6 attempts) leaves headroom.
    const result = runScenario({
      app: "mendpoint-warden-preview",
      protectedPrefixes: "mendpoint-fettler-production",
      beforeMachines: STARTED,
      currentMachines: STARTED,
      livez: [503, 503, 503, 503, 200],
      readinessTimeoutSeconds: 60,
    });

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.livezCalls.length).toBe(5);
    expect(result.stopCalls).toEqual([]);
    expect(result.startCalls).toEqual([]);
  }, 60_000);

  it("(c) readiness wait fails after the window when /livez never recovers", () => {
    // Window 40s => exactly 4 polls, all 503, then judged not healthy.
    const result = runScenario({
      app: "mendpoint-warden-preview",
      protectedPrefixes: "mendpoint-fettler-production",
      beforeMachines: STARTED,
      currentMachines: STARTED,
      livez: [503],
      readinessTimeoutSeconds: 40,
    });

    expect(result.status).not.toBe(0);
    expect(result.livezCalls.length).toBe(4);
    // Non-protected app: the window elapsing drives the fail-closed stop.
    expect(result.stopCalls.length).toBeGreaterThan(0);
  }, 60_000);

  it("(d) mutation: deleting the protected guard lets the protected machine stay stopped (no start)", () => {
    // Identical to (a) but with the protected guard stripped from the shipped
    // contain_current_machines. Without it a protected app falls to the
    // non-protected path, which on an already-stopped machine neither starts nor
    // stops it -- reproducing the incident where the machine stayed down. So the
    // start that (a) proves disappears: the guard is load-bearing.
    const withGuard = runScenario({
      app: "mendpoint-fettler-production",
      protectedPrefixes: "",
      beforeMachines: STARTED,
      currentMachines: STOPPED,
      livez: [503],
      readinessTimeoutSeconds: 20,
    });
    expect(withGuard.startCalls.length, "control: guard present starts the machine").toBeGreaterThan(0);

    const withoutGuard = runScenario({
      app: "mendpoint-fettler-production",
      protectedPrefixes: "",
      beforeMachines: STARTED,
      currentMachines: STOPPED,
      livez: [503],
      readinessTimeoutSeconds: 20,
      stripGuard: true,
    });
    // The mutation removes the recovery: the machine is never started.
    expect(withoutGuard.startCalls).toEqual([]);
    expect(withoutGuard.recovery).not.toContain("protected_not_stopped");
  }, 60_000);

  it("(S3) never stops a protected machine that is STARTED at containment; deleting the guard reintroduces the stop", () => {
    // The real incident shape: the production machine is RUNNING when
    // containment fires (run 33890068837 stopped a started machine). The
    // stopped-fixture mutation in (d) is vacuous for the stop assertion because
    // an already-stopped machine is never stopped either way; this case makes
    // the "never stops" guarantee load-bearing.
    const base = {
      app: "mendpoint-fettler-production",
      protectedPrefixes: "",
      beforeMachines: STARTED,
      currentMachines: STARTED, // started when containment runs
      livez: [503] as number[],
      readinessTimeoutSeconds: 20,
    };

    const withGuard = runScenario(base);
    expect(withGuard.status, `stderr: ${withGuard.stderr}`).not.toBe(0);
    expect(withGuard.stopCalls, "a running protected machine must never be stopped").toEqual([]);
    expect(withGuard.recovery).toContain("protected_not_stopped");

    // Mutation: without the guard the non-protected path stops the RUNNING
    // machine -- exactly the incident. So the "never stops" assertion fails.
    const withoutGuard = runScenario({ ...base, stripGuard: true });
    expect(
      withoutGuard.stopCalls.length,
      "deleting the guard reintroduces the incident stop of a running machine",
    ).toBeGreaterThan(0);
  }, 60_000);

  it("(S1/S2) protects production even when the var is whitespace-only", () => {
    // A whitespace-only var must not unprotect production: the union prepends
    // mendpoint-fettler-production, and per-entry trim skips the blank entry.
    const result = runScenario({
      app: "mendpoint-fettler-production",
      protectedPrefixes: "   ",
      beforeMachines: STARTED,
      currentMachines: STARTED,
      livez: [503],
      readinessTimeoutSeconds: 20,
    });
    expect(result.status).not.toBe(0);
    expect(result.stopCalls).toEqual([]);
    expect(result.recovery).toContain("protected_not_stopped");
  }, 60_000);

  it("(S1/S2) protects production even when the configured list omits it", () => {
    // A list that names only another app must not unprotect production.
    const result = runScenario({
      app: "mendpoint-fettler-production",
      protectedPrefixes: "mendpoint-talal",
      beforeMachines: STARTED,
      currentMachines: STARTED,
      livez: [503],
      readinessTimeoutSeconds: 20,
    });
    expect(result.status).not.toBe(0);
    expect(result.stopCalls).toEqual([]);
    expect(result.recovery).toContain("protected_not_stopped");
  }, 60_000);

  it.each(["5m", "300s", "", "-30", "abc"])(
    "(S4) falls back to 300 with a notice on invalid readiness timeout %j, never aborting",
    (bad) => {
      const result = runScenario({
        app: "mendpoint-warden-preview",
        protectedPrefixes: "mendpoint-fettler-production",
        beforeMachines: STARTED,
        currentMachines: STARTED,
        livez: [200], // ready on the first poll once the window is a valid int
        readinessTimeoutSeconds: bad,
      });
      // Never aborts: /livez 200 => ready => exit 0.
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("falling back to 300s");
    },
    60_000,
  );
});

/**
 * The SHIPPED protected file-delivery branch of the same rotation step. It is
 * extracted verbatim from the workflow and run against a stubbed `flyctl` whose
 * `ssh console` answers the install command and the in-machine /ready read. The
 * guarantees a protected renewal must hold are proved by the ABSENCE of any
 * `machine update`, `secrets set`, `machine stop`, or `machine start` call (no
 * restart, no containment) and the PRESENCE of exactly one ssh install plus one
 * ssh /ready read that must agree before the branch reports success.
 */
function protectedBranch(stripReadinessGuard = false): string {
  let branch = extractRegion(
    '            if [ "$is_protected_app" = true ]; then',
    "              continue\n            fi",
  );
  if (stripReadinessGuard) {
    const start = branch.indexOf("# readiness-confirmation-guard (mutation strips");
    const endMarker = "# readiness-confirmation-guard-end";
    const end = branch.indexOf(endMarker);
    expect(start, "readiness confirmation guard start not found").toBeGreaterThan(-1);
    expect(end, "readiness confirmation guard end not found").toBeGreaterThan(start);
    branch = branch.slice(0, start) + branch.slice(end + endMarker.length);
  }
  return branch;
}

interface ProtectedOptions {
  readyJson?: string;
  installFail?: boolean;
  stageFail?: boolean;
  stripReadinessGuard?: boolean;
  expiresAt?: string;
  /**
   * Per-attempt behaviour of the ssh install, space-separated; the last entry
   * repeats. Each is one of: `ok` (installs and the machine now serves the
   * receipt), `hang` (times out, nothing landed), `hang-landed` (times out but
   * the server-side install completed), `bad` (exits 0 but reports
   * installed:false), or anything else (exit 1). Defaults to `ok`, or `fail`
   * when `installFail` is set.
   */
  installBehavior?: string;
}

interface ProtectedResult {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
  installCalls: string[];
  readyCalls: string[];
  updateCalls: string[];
  secretsCalls: string[];
  stagedSecretsCalls: string[];
  stopCalls: string[];
  startCalls: string[];
  recovery: string;
}

function runProtected(opts: ProtectedOptions = {}): ProtectedResult {
  const dir = mkdtempSync(join(tmpdir(), "egress-protected-file-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  mkdirSync(join(dir, "test-results", "sandbox-egress"), { recursive: true });
  const callLog = join(dir, "calls.log").replace(/\\/g, "/");
  const installCount = join(dir, "install.count").replace(/\\/g, "/");
  const landed = join(dir, "receipt.landed").replace(/\\/g, "/");
  const app = "mendpoint-fettler-production";
  const expiresAt = opts.expiresAt ?? "2026-08-19T19:00:00.000Z";
  const installJson = JSON.stringify({
    installed: true,
    path: "/data/sandbox-egress/attestation.b64",
    testedAt: "2026-08-18T19:55:00.000Z",
    expiresAt,
    sha256: "a".repeat(64),
  });
  const installJsonBad = JSON.stringify({ installed: false, reason: "verify_failed" });
  const readyJson = opts.readyJson ?? JSON.stringify({
    name: "sandbox_egress_receipt",
    ok: true,
    detail: JSON.stringify({ status: "verified", source: "file", expiresAt }),
  });
  // What /ready reports before the receipt has landed on the machine: a pending,
  // not-yet-serving reading, distinct from a matching one.
  const readyJsonPending = JSON.stringify({
    name: "sandbox_egress_receipt",
    ok: false,
    detail: JSON.stringify({ status: "pending" }),
  });
  const machinesJson = '[{"id":"84e696a22eee68","state":"started"}]';
  const installBehavior = opts.installBehavior ?? (opts.installFail ? "fail" : "ok");

  // Stubbed flyctl. The install is per-attempt (INSTALL_BEHAVIOR, one word per
  // attempt, last repeats): `ok` installs and touches the LANDED marker; `hang`
  // times out (exit 124) with nothing landed; `hang-landed` times out but the
  // server-side install completed (LANDED touched); `bad` exits 0 with
  // installed:false; anything else exits 1. `ssh console ...sandbox_egress_receipt...`
  // answers the in-machine /ready read: the matching READY_JSON once the receipt
  // has LANDED, the pending reading otherwise. Every invocation is logged so the
  // test can assert what was and was NOT called.
  writeFileSync(
    join(binDir, "flyctl"),
    [
      "#!/usr/bin/env bash",
      `printf 'flyctl %s\\n' "$*" >>"${callLog}"`,
      'case "$*" in',
      '  *"ssh console"*"install.ts"*)',
      '    n=0; [ -f "$INSTALL_COUNT" ] && n="$(cat "$INSTALL_COUNT")"; n=$((n + 1)); printf "%s" "$n" > "$INSTALL_COUNT"',
      '    read -ra __beh <<< "$INSTALL_BEHAVIOR"',
      '    __idx=$((n - 1)); [ "$__idx" -ge "${#__beh[@]}" ] && __idx=$(( ${#__beh[@]} - 1 ))',
      '    case "${__beh[$__idx]}" in',
      '      ok) : > "$LANDED"; printf "%s\\n" "$INSTALL_JSON"; exit 0 ;;',
      '      hang) exit 124 ;;',
      '      hang-landed) : > "$LANDED"; exit 124 ;;',
      '      bad) printf "%s\\n" "$INSTALL_JSON_BAD"; exit 0 ;;',
      '      *) exit 1 ;;',
      '    esac',
      "    ;;",
      '  *"ssh console"*"sandbox_egress_receipt"*)',
      '    if [ -f "$LANDED" ]; then printf "%s\\n" "$READY_JSON"; else printf "%s\\n" "$READY_JSON_PENDING"; fi',
      "    ;;",
      '  *"secrets set"*)',
      '    if [ "${STAGE_FAIL:-0}" = "1" ]; then exit 1; fi',
      "    ;;",
      '  *"secrets list"*)',
      "    printf '%s\\n' '[{\"name\":\"MENDPOINT_SANDBOX_EGRESS_ATTESTATION_BASE64\",\"status\":\"Staged\"}]'",
      "    ;;",
      '  *"machine list"*)',
      "    printf '%s\\n' \"$MACHINES_JSON\"",
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "flyctl"), 0o755);

  const harness = [
    "set -uo pipefail",
    `app="${app}"`,
    'attestation="dGVzdC1hdHRlc3RhdGlvbg=="',
    `expires_at="${expiresAt}"`,
    "is_protected_app=true",
    `machines_json='${machinesJson}'`,
    // timeout is stubbed to strip the bound and run the command directly.
    'timeout() { shift; "$@"; }',
    "sleep() { :; }",
    // Wrap in a one-shot loop so the branch's `continue` is meaningful (it ends
    // the loop, i.e. success), while any `exit 1` still aborts the whole run.
    "for __protected_iter in 1; do",
    protectedBranch(opts.stripReadinessGuard),
    "done",
    "",
  ].join("\n");
  writeFileSync(join(dir, "harness.sh"), harness);

  const result = spawnSync("bash", ["harness.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${SEP}${process.env.PATH ?? ""}`,
      INSTALL_JSON: installJson,
      INSTALL_JSON_BAD: installJsonBad,
      READY_JSON: readyJson,
      READY_JSON_PENDING: readyJsonPending,
      MACHINES_JSON: machinesJson,
      INSTALL_BEHAVIOR: installBehavior,
      INSTALL_COUNT: installCount,
      LANDED: landed,
      STAGE_FAIL: opts.stageFail ? "1" : "0",
    },
  });

  const calls = existsSync(callLog)
    ? readFileSync(callLog, "utf8").split("\n").filter(Boolean)
    : [];
  const recoveryPath = join(dir, "test-results", "sandbox-egress", `rotation-recovery-${app}.txt`);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    calls,
    installCalls: calls.filter((line) => line.includes("install.ts")),
    readyCalls: calls.filter((line) => line.includes("sandbox_egress_receipt")),
    updateCalls: calls.filter((line) => line.includes("machine update")),
    secretsCalls: calls.filter((line) => line.includes("secrets set")),
    stagedSecretsCalls: calls.filter((line) => line.includes("secrets set") && line.includes("--stage")),
    stopCalls: calls.filter((line) => line.includes("machine stop")),
    startCalls: calls.filter((line) => line.includes("machine start")),
    recovery: existsSync(recoveryPath) ? readFileSync(recoveryPath, "utf8") : "",
  };
}

describe("sandbox egress rotation — protected apps get the receipt as a file, never a restart", () => {
  it("installs over ssh, confirms /ready, and stages the env fallback with no machine update / stop / start", () => {
    const result = runProtected();
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    // Exactly one ssh install and one ssh /ready read.
    expect(result.installCalls.length).toBe(1);
    expect(result.readyCalls.length).toBe(1);
    // Exactly one secrets set, and it is STAGED (skips deployment) -- never a
    // deploying set that would restart the machine.
    expect(result.secretsCalls.length).toBe(1);
    expect(result.stagedSecretsCalls.length).toBe(1);
    // No restart, no containment: none of these mutating calls happen.
    expect(result.updateCalls).toEqual([]);
    expect(result.stopCalls).toEqual([]);
    expect(result.startCalls).toEqual([]);
    expect(result.recovery).toContain("protected_file_delivery_ok");
    expect(result.recovery).toContain("protected_env_fallback_staged");
  }, 60_000);

  it("(S1) refreshes the env fallback only with a --stage secrets set, and a staging failure is non-fatal", () => {
    const result = runProtected({ stageFail: true });
    // The receipt file was already installed and confirmed, so a staging failure
    // must NOT fail the run and must NOT restart anything.
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.secretsCalls.length).toBe(1);
    expect(result.stagedSecretsCalls.length).toBe(1);
    expect(result.updateCalls).toEqual([]);
    expect(result.stopCalls).toEqual([]);
    expect(result.startCalls).toEqual([]);
    expect(result.recovery).toContain("protected_env_fallback_stage_failed");
  }, 60_000);

  it("fails with a named reason and no containment when /ready reports source:env", () => {
    const result = runProtected({
      readyJson: JSON.stringify({
        name: "sandbox_egress_receipt",
        ok: true,
        detail: JSON.stringify({ status: "verified", source: "env", expiresAt: "2026-08-19T19:00:00.000Z" }),
      }),
    });
    expect(result.status).not.toBe(0);
    expect(result.recovery).toContain("readiness_disagreed");
    expect(result.stopCalls).toEqual([]);
    expect(result.startCalls).toEqual([]);
    expect(result.updateCalls).toEqual([]);
    expect(result.secretsCalls).toEqual([]);
  }, 60_000);

  it("fails with a named reason when /ready reports a different expiresAt", () => {
    const result = runProtected({
      readyJson: JSON.stringify({
        name: "sandbox_egress_receipt",
        ok: true,
        detail: JSON.stringify({ status: "verified", source: "file", expiresAt: "2020-01-01T00:00:00.000Z" }),
      }),
    });
    expect(result.status).not.toBe(0);
    expect(result.recovery).toContain("readiness_disagreed");
    expect(result.stopCalls).toEqual([]);
    expect(result.startCalls).toEqual([]);
  }, 60_000);

  it("retries the ssh install up to 3 times and fails loudly, never containing, when every attempt fails", () => {
    const result = runProtected({ installFail: true });
    expect(result.status).not.toBe(0);
    // Bounded retries: three install attempts, not one.
    expect(result.installCalls.length).toBe(3);
    // Between attempts it re-reads /ready to detect a hung-but-landed install
    // (attempts 2 and 3), but here nothing ever lands, so it fails loudly.
    expect(result.readyCalls.length).toBe(2);
    expect(result.recovery).toContain("protected_install_attempt_failed");
    expect(result.recovery).toContain("protected_install_failed");
    expect(result.stderr).toContain("after 3 attempts");
    // A protected app is never contained on install failure.
    expect(result.stopCalls).toEqual([]);
    expect(result.startCalls).toEqual([]);
    expect(result.updateCalls).toEqual([]);
    expect(result.secretsCalls).toEqual([]);
  }, 60_000);

  it("recovers when the first ssh install hangs past the timeout and a retry succeeds", () => {
    // Attempt 1 times out (the flyctl ssh connection hangs) with nothing landed;
    // the between-attempt /ready probe confirms it did NOT land, so attempt 2
    // installs and the app then serves the receipt. The renewal succeeds instead
    // of failing loudly (the run 35921243289 / 36029373235 failure mode).
    const result = runProtected({ installBehavior: "hang ok" });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    // The retry is load-bearing: two install invocations, the second one landing.
    expect(result.installCalls.length).toBe(2);
    expect(result.recovery).toContain("protected_install_attempt_failed");
    expect(result.recovery).toContain("protected_file_delivery_ok");
    // Still a protected file delivery: no restart, no containment.
    expect(result.updateCalls).toEqual([]);
    expect(result.stopCalls).toEqual([]);
    expect(result.startCalls).toEqual([]);
  }, 60_000);

  it("detects a hung install that actually landed via /ready and does NOT reinstall", () => {
    // Attempt 1 times out but the server-side install completed. The
    // between-attempt /ready probe sees the app already serving the new receipt,
    // so the loop stops early: exactly one install invocation, no second install.
    const result = runProtected({ installBehavior: "hang-landed ok" });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.installCalls.length).toBe(1);
    expect(result.recovery).toContain("protected_install_confirmed_after_hang");
    expect(result.recovery).toContain("protected_file_delivery_ok");
    expect(result.updateCalls).toEqual([]);
    expect(result.stopCalls).toEqual([]);
    expect(result.startCalls).toEqual([]);
  }, 60_000);

  it("(mutation) deleting the /ready confirmation lets a source:env disagreement pass — the confirmation is load-bearing", () => {
    const disagreeing = {
      readyJson: JSON.stringify({
        name: "sandbox_egress_receipt",
        ok: true,
        detail: JSON.stringify({ status: "verified", source: "env", expiresAt: "2026-08-19T19:00:00.000Z" }),
      }),
    };
    const withGuard = runProtected(disagreeing);
    expect(withGuard.status, "control: the confirmation catches the disagreement").not.toBe(0);

    const withoutGuard = runProtected({ ...disagreeing, stripReadinessGuard: true });
    expect(
      withoutGuard.status,
      `mutation: without the confirmation a source:env disagreement passes; stderr: ${withoutGuard.stderr}`,
    ).toBe(0);
  }, 60_000);
});
