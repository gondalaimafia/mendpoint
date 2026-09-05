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
