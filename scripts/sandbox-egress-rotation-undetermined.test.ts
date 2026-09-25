import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Issue #728: in `.github/workflows/sandbox-egress-acceptance.yml`, the
 * "Rotate the egress authority" step's NON-protected success path made
 * unretried flyctl READS after a mutation. A single transient Fly Machines API
 * blip on one of them either aborted the step with the update already applied,
 * or (on the `secrets list` read) was read as a failed rotation and drove
 * `contain_current_machines`, which STOPS a non-protected app's machines. That
 * is the third-state defect (docs/agents/FAILURE_MODES.md §1): a read that
 * could not complete ("don't know") collapsed into "verified failed", and the
 * same outage shape as the earlier renewal-containment incidents.
 *
 * These tests run the SHIPPED rotation shell EXTRACTED verbatim from the YAML
 * (the non-protected body from `launch_groups_before` through the readiness
 * outcome, plus the pre-flight read) against a stubbed flyctl with a REAL jq,
 * under `bash --noprofile --norc -e -o pipefail`. The rotation step's own
 * `source scripts/flyctl-transport-retry.sh` line is extracted from the YAML
 * (scoped to the rotation step) and prepended, and the real helper is written
 * into the harness cwd, so deleting ONLY that line breaks these tests (#726
 * review gap O5b). The reads are run as extracted, not as a hard-coded copy of
 * the wrap, so a second bare flyctl read is caught (#726 review gap O6b).
 *
 * Three outcomes must be honoured after the mutation:
 *   - VERIFIED OK      -> proceed;
 *   - VERIFIED FAILED  -> the app answered and is genuinely not healthy/updated;
 *                         containment applies exactly as today;
 *   - UNDETERMINED     -> reads still failing after retries; NO machine is
 *                         stopped, the run fails loudly with
 *                         `rotation_post_update_undetermined`, machines are
 *                         left running (the update itself succeeded).
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

// The native Windows jq.exe on the dev host emits CRLF line terminators, which
// break the shipped `read`-from-jq loops and the `$`-anchored id regex in the
// extracted step (CI's Linux jq emits LF, so the workflow is correct there). A
// `jq` shim runs the real jq and strips CR, so this host behaves like CI; on
// CI `tr -d '\r'` is a no-op. The real jq path is resolved before the harness
// bin dir shadows it.
const REAL_JQ = (() => {
  const r = spawnSync("bash", ["--noprofile", "--norc", "-c", "command -v jq"], { encoding: "utf8" });
  const p = (r.stdout ?? "").trim().split("\n")[0]?.trim() ?? "";
  expect(p, "jq not found on PATH").not.toBe("");
  return p;
})();
function writeJqShim(binDir: string): void {
  writeFileSync(join(binDir, "jq"), ['#!/usr/bin/env bash', '"$REAL_JQ" "$@" | tr -d \'\\r\'', 'exit "${PIPESTATUS[0]}"', ""].join("\n"));
  chmodSync(join(binDir, "jq"), 0o755);
}

/** Slice a shell region out of the workflow, de-indented by `indent`. */
function extractRegion(startMarker: string, endMarker: string, indent = 12): string {
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
 * The rotation step's OWN `source` line, located after the rotation step's
 * name so it is distinct from the probe step's identical line. Returns "" if it
 * has been deleted, so a real deletion makes every harness below lose fly_retry
 * (gap O5b: deleting ONLY the rotation source line must break a test).
 */
function rotationSourceLine(): string {
  const source = engineSource();
  const stepStart = source.indexOf("Rotate the egress authority to every consuming app");
  expect(stepStart, "rotation step not found").toBeGreaterThan(-1);
  const line = "source scripts/flyctl-transport-retry.sh";
  const idx = source.indexOf(line, stepStart);
  return idx > -1 ? line : "";
}

/** The pre-flight read region (fly_retry preflight-list + assign + shape guard). */
function preflightRegion(): string {
  return extractRegion(
    'fly_retry preflight-list -- flyctl machine list --app "$app" --json',
    '<<<"$machines_json" >/dev/null',
  );
}

/** The whole non-protected per-app rotation body (its four post-mutation reads). */
function nonProtectedBody(): string {
  return extractRegion(
    "launch_groups_before=\"$(jq -cS '[.[] | {",
    "# rotation-nonprotected-body-end",
  );
}

const DIGEST = `sha256:${"a".repeat(64)}`;
const SANDBOX_IMAGE = `registry.fly.io/mendpoint-sandbox@sha256:${"b".repeat(64)}`;

/** One fully-formed machine that satisfies the pre-flight and post-mutation invariants. */
function machineJson(state: "started" | "stopped"): string {
  return JSON.stringify([
    {
      id: "abc123",
      state,
      image_ref: { registry: "registry.fly.io", repository: "mendpoint-talal", digest: DIGEST },
      config: {
        image: "registry.fly.io/mendpoint-talal:deployment-01",
        metadata: { fly_process_group: "app", fly_platform_version: "v2" },
        env: { MENDPOINT_SANDBOX_FLY_IMAGE: SANDBOX_IMAGE },
      },
    },
  ]);
}

// The stubbed, stateful flyctl used by the body harness. `machine list` and
// `secrets list` are counter-driven (space-separated behaviour, last repeats)
// so a specific read can be blipped; mutating calls (`machine update`,
// `secrets set`) succeed by default. `machine stop`/`start` mutate the machine
// state so real containment converges, and every call is logged so "no machine
// stopped" is an assertion on the call log, not on a stub function.
function flyctlStub(callLog: string, mlist: string): string {
  return [
    "#!/usr/bin/env bash",
    `printf 'flyctl %s\\n' "$*" >>"${callLog}"`,
    'case "$*" in',
    "  *\"machine update\"*) exit 0 ;;",
    '  *"secrets set"*)',
    '    if [ "${SECRETS_SET_BEHAVIOR:-ok}" = "transport" ]; then echo "Error: failed to update secrets: read tcp 1->2:443: read: connection reset by peer" >&2; exit 1; fi',
    "    exit 0 ;;",
    '  *"secrets list"*)',
    '    sc=0; [ -f "$SLCOUNT" ] && sc="$(cat "$SLCOUNT")"; sc=$((sc + 1)); printf "%s" "$sc" > "$SLCOUNT"',
    '    read -ra __sb <<< "${SECRETS_LIST_BEHAVIOR:-ok}"; si=$((sc - 1)); [ "$si" -ge "${#__sb[@]}" ] && si=$(( ${#__sb[@]} - 1 ))',
    '    case "${__sb[$si]}" in',
    '      transport) echo "Error: could not retrieve secrets: read tcp 1->2:443: read: connection reset by peer" >&2; exit 1 ;;',
    '      *) cat "$SECRETS_FILE"; exit 0 ;;',
    "    esac ;;",
    '  *"machine stop"*)',
    "    jq 'map(.state = \"stopped\")' \"$MLIST\" > \"$MLIST.t\" && mv \"$MLIST.t\" \"$MLIST\"; exit 0 ;;",
    '  *"machine start"*)',
    "    jq 'map(.state = \"started\")' \"$MLIST\" > \"$MLIST.t\" && mv \"$MLIST.t\" \"$MLIST\"; exit 0 ;;",
    '  *"machine list"*)',
    '    lc=0; [ -f "$LCOUNT" ] && lc="$(cat "$LCOUNT")"; lc=$((lc + 1)); printf "%s" "$lc" > "$LCOUNT"',
    '    read -ra __lb <<< "${LIST_BEHAVIOR:-ok}"; li=$((lc - 1)); [ "$li" -ge "${#__lb[@]}" ] && li=$(( ${#__lb[@]} - 1 ))',
    '    case "${__lb[$li]}" in',
    '      transport) echo "Error: could not list machines: read tcp 1->2:443: read: connection reset by peer" >&2; exit 1 ;;',
    '      *) cat "$MLIST"; exit 0 ;;',
    "    esac ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
}

// A curl stub for /livez (redirect-to-file, exit code only) and /healthz
// (prints an http code to stdout). /livez fails when CURL_LIVEZ_BEHAVIOR=fail.
function curlStub(): string {
  return [
    "#!/usr/bin/env bash",
    'url="${!#}"',
    'case "$url" in',
    '  */livez) if [ "${CURL_LIVEZ_BEHAVIOR:-ok}" = "fail" ]; then exit 22; fi; echo ok; exit 0 ;;',
    '  */healthz) echo 200; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");
}

interface BodyOptions {
  listBehavior?: string;
  secretsListBehavior?: string;
  secretsSetBehavior?: string;
  livezBehavior?: string;
  secretsStatus?: string; // "Deployed" (default) | "Staged"
  state?: "started" | "stopped";
  isProtected?: boolean;
  readinessTimeout?: string;
  // Mutations applied to the extracted body region.
  bareRead?: "post-update" | "post-secret" | "readiness" | "secrets";
  retrySecretsSet?: boolean;
  containOnUndetermined?: boolean;
  deleteRotationSource?: boolean;
}

interface BodyResult {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
  stopCalls: string[];
  startCalls: string[];
  secretsSetCalls: string[];
  recovery: string;
}

function runBody(opts: BodyOptions = {}): BodyResult {
  const dir = mkdtempSync(join(tmpdir(), "egress-rot-body-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "test-results", "sandbox-egress"), { recursive: true });
  const callLog = join(dir, "calls.log").replace(/\\/g, "/");
  const mlist = join(dir, "mlist.json").replace(/\\/g, "/");
  // The stub's returned machine state (what the reads observe). The scaffold
  // `machines_json` (the pre-flight "before" snapshot) is ALWAYS started, so
  // `started_before_ids` is non-empty and a stopped read is a real state change.
  writeFileSync(mlist, machineJson(opts.state ?? "started"));
  const secretsFile = join(dir, "secrets.json").replace(/\\/g, "/");
  writeFileSync(secretsFile, JSON.stringify([{ status: opts.secretsStatus ?? "Deployed" }]));

  writeFileSync(join(binDir, "flyctl"), flyctlStub(callLog, mlist));
  chmodSync(join(binDir, "flyctl"), 0o755);
  writeFileSync(join(binDir, "curl"), curlStub());
  chmodSync(join(binDir, "curl"), 0o755);
  writeJqShim(binDir);
  writeFileSync(join(dir, "scripts", "flyctl-transport-retry.sh"), helperSource());

  let region = nonProtectedBody();
  if (opts.bareRead === "post-update") {
    const before = region;
    region = region.replace(
      /if ! fly_retry post-update-list -- flyctl machine list --app "\$app" --json; then[\s\S]*?updated_machines_json="\$FLY_RETRY_STDOUT"/,
      'updated_machines_json="$(flyctl machine list --app "$app" --json)"',
    );
    expect(region, "bareRead post-update did not apply").not.toBe(before);
  }
  if (opts.bareRead === "post-secret") {
    const before = region;
    region = region.replace(
      /if ! fly_retry post-secret-list -- flyctl machine list --app "\$app" --json; then[\s\S]*?post_secret_machines_json="\$FLY_RETRY_STDOUT"/,
      'post_secret_machines_json="$(flyctl machine list --app "$app" --json)"',
    );
    expect(region, "bareRead post-secret did not apply").not.toBe(before);
  }
  if (opts.bareRead === "secrets") {
    const before = region;
    region = region.replace(
      /if ! fly_retry post-secret-list-secrets[\s\S]*?contain_current_machines "secret_generation_not_deployed"\n\s*exit 1\n\s*fi/,
      [
        'if ! flyctl secrets list --app "$app" --json \\',
        "    | jq -e 'length > 0 and all(.[]; .status == \"Deployed\")' >/dev/null; then",
        '  contain_current_machines "secret_generation_not_deployed"',
        "  exit 1",
        "fi",
      ].join("\n"),
    );
    expect(region, "bareRead secrets did not apply").not.toBe(before);
  }
  if (opts.bareRead === "readiness") {
    const before = region;
    region = region.replace(
      /if fly_retry readiness-list -- flyctl machine list --app "\$app" --json; then\n\s*readiness_after_json="\$FLY_RETRY_STDOUT"\n\s*readiness_read_ok=true\n\s*else\n\s*readiness_after_json='\[\]'\n\s*fi/,
      ['if ! readiness_after_json="$(flyctl machine list --app "$app" --json)"; then', "  readiness_after_json='[]'", "fi"].join("\n"),
    );
    expect(region, "bareRead readiness did not apply").not.toBe(before);
  }
  if (opts.retrySecretsSet) {
    const before = region;
    region = region.replace('if ! flyctl secrets set --app "$app" \\', 'if ! fly_retry secretsset -- flyctl secrets set --app "$app" \\');
    expect(region, "retrySecretsSet did not apply").not.toBe(before);
  }
  if (opts.containOnUndetermined) {
    const before = region;
    region = region.replace(
      'if ! fly_retry post-secret-list-secrets -- flyctl secrets list --app "$app" --json; then\n',
      'if ! fly_retry post-secret-list-secrets -- flyctl secrets list --app "$app" --json; then\n  contain_current_machines "mutation_contain_on_undetermined"\n',
    );
    expect(region, "containOnUndetermined did not apply").not.toBe(before);
  }

  const source = opts.deleteRotationSource ? "" : rotationSourceLine();
  const harness = [
    "set -euo pipefail",
    "sleep() { :; }",
    "export FLY_RETRY_BACKOFF_SECONDS=0",
    source,
    `app="mendpoint-talal"`,
    `is_protected_app=${opts.isProtected ? "true" : "false"}`,
    `machines_json='${machineJson("started")}'`,
    `attestation="att"`,
    `public_key="pk"`,
    `key_id="kid"`,
    `policy_digest="pd"`,
    `schema="1"`,
    `expires_at="2099-01-01T00:00:00Z"`,
    `export MENDPOINT_SANDBOX_EGRESS_IMAGE="${SANDBOX_IMAGE}"`,
    `export SANDBOX_EGRESS_READINESS_TIMEOUT_SECONDS="${opts.readinessTimeout ?? "10"}"`,
    region,
    "",
  ].join("\n");
  writeFileSync(join(dir, "body.sh"), harness);

  const result = spawnSync("bash", ["--noprofile", "--norc", "body.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${SEP}${process.env.PATH ?? ""}`,
      LCOUNT: join(dir, "l.count").replace(/\\/g, "/"),
      SLCOUNT: join(dir, "sl.count").replace(/\\/g, "/"),
      MLIST: mlist,
      SECRETS_FILE: secretsFile,
      LIST_BEHAVIOR: opts.listBehavior ?? "ok",
      SECRETS_LIST_BEHAVIOR: opts.secretsListBehavior ?? "ok",
      SECRETS_SET_BEHAVIOR: opts.secretsSetBehavior ?? "ok",
      CURL_LIVEZ_BEHAVIOR: opts.livezBehavior ?? "ok",
      REAL_JQ,
    },
  });

  const calls = existsSync(callLog) ? readFileSync(callLog, "utf8").split("\n").filter(Boolean) : [];
  const recoveryFile = join(dir, "test-results", "sandbox-egress", "rotation-recovery-mendpoint-talal.txt");
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    calls,
    stopCalls: calls.filter((l) => l.includes("machine stop")),
    startCalls: calls.filter((l) => l.includes("machine start")),
    secretsSetCalls: calls.filter((l) => l.includes("secrets set")),
    recovery: existsSync(recoveryFile) ? readFileSync(recoveryFile, "utf8") : "",
  };
}

describe("egress rotation #728 — a single blip on each post-mutation read is retried (VERIFIED OK, no machine stopped)", () => {
  it("post-update machine-list read: one blip then success, rotation completes, no machine stopped", () => {
    const r = runBody({ listBehavior: "transport ok ok" });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stopCalls.length, "no machine stopped").toBe(0);
  }, 60_000);

  it("secrets-list read: one blip then success, rotation completes, no machine stopped", () => {
    const r = runBody({ secretsListBehavior: "transport ok" });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stopCalls.length).toBe(0);
  }, 60_000);

  it("post-secret machine-list read: one blip then success, rotation completes, no machine stopped", () => {
    const r = runBody({ listBehavior: "ok transport ok" });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stopCalls.length).toBe(0);
  }, 60_000);

  it("readiness machine-list read: one blip then success, app becomes ready, no machine stopped", () => {
    const r = runBody({ listBehavior: "ok ok transport ok" });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stopCalls.length).toBe(0);
  }, 60_000);
});

describe("egress rotation #728 — a persistent read failure is UNDETERMINED (loud, no machine stopped, alert fires)", () => {
  it.each([
    ["post-update machine list", { listBehavior: "transport" } as BodyOptions, "machine_list_after_update"],
    ["secrets list", { secretsListBehavior: "transport" } as BodyOptions, "secrets_list"],
    ["post-secret machine list", { listBehavior: "ok transport" } as BodyOptions, "machine_list_after_secrets"],
    ["readiness reads", { listBehavior: "ok ok transport" } as BodyOptions, "readiness_reads_unavailable"],
  ])("%s: UNDETERMINED, fails loudly, NO machine stopped", (_name, opts, reason) => {
    const r = runBody(opts);
    expect(r.status, `stderr: ${r.stderr}`).not.toBe(0);
    expect(r.stopCalls.length, "UNDETERMINED must never stop a machine").toBe(0);
    expect(r.stderr, "fails loudly with the undetermined reason").toContain("rotation_post_update_undetermined");
    // The specific read is recorded in the evidence artifact for the alert.
    expect(r.recovery, "the undetermined read is named in the recovery record").toContain(reason);
  }, 60_000);
});

describe("egress rotation #728 — a genuine verification failure still contains, exactly as today", () => {
  it("/livez fails with a readable machine state: containment runs (machine stopped), not UNDETERMINED", () => {
    const r = runBody({ livezBehavior: "fail" });
    expect(r.status).not.toBe(0);
    expect(r.stopCalls.length, "containment stops the machine on a genuine failure").toBeGreaterThan(0);
    expect(r.stderr).not.toContain("rotation_post_update_undetermined");
  }, 60_000);

  it("secrets read succeeds but reports the generation NOT deployed: containment runs", () => {
    const r = runBody({ secretsStatus: "Staged" });
    expect(r.status).not.toBe(0);
    expect(r.stopCalls.length, "a genuine not-deployed verdict contains").toBeGreaterThan(0);
    expect(r.stderr).not.toContain("rotation_post_update_undetermined");
  }, 60_000);
});

describe("egress rotation #728 — the protected-app path is unchanged (start, never stop)", () => {
  it("a protected app that never becomes ready is STARTED, never stopped, and fails loudly", () => {
    const r = runBody({ isProtected: true, state: "stopped" });
    expect(r.status).not.toBe(0);
    expect(r.stopCalls.length, "a protected app is NEVER stopped").toBe(0);
    expect(r.startCalls.length, "a protected app is started back").toBeGreaterThan(0);
    expect(r.stderr).toContain("PROTECTED app");
  }, 60_000);
});

describe("egress rotation #728 — mutations, each killed", () => {
  it.each(["post-update", "post-secret", "readiness", "secrets"] as const)(
    "(mutation) a bare read without retry at the %s read loses the retry",
    (which) => {
      const control =
        which === "secrets"
          ? runBody({ secretsListBehavior: "transport ok" })
          : which === "post-update"
            ? runBody({ listBehavior: "transport ok ok" })
            : which === "post-secret"
              ? runBody({ listBehavior: "ok transport ok" })
              : runBody({ listBehavior: "ok ok transport ok" });
      expect(control.status, `control stderr: ${control.stderr}`).toBe(0);
      const mutated =
        which === "secrets"
          ? runBody({ secretsListBehavior: "transport ok", bareRead: "secrets" })
          : which === "post-update"
            ? runBody({ listBehavior: "transport ok ok", bareRead: "post-update" })
            : which === "post-secret"
              ? runBody({ listBehavior: "ok transport ok", bareRead: "post-secret" })
              : runBody({ listBehavior: "ok ok transport ok", bareRead: "readiness" });
      // The bare read is not retried: the same single blip that the shipped
      // wrap absorbs now aborts the rotation (post-update/post-secret under
      // set -e) or drops to UNDETERMINED/containment (secrets/readiness).
      expect(mutated.status, "mutation: bare read is not retried").not.toBe(0);
    },
    60_000,
  );

  it("(mutation) containment on UNDETERMINED: a persistent read blip stops a machine", () => {
    const control = runBody({ secretsListBehavior: "transport" });
    expect(control.stopCalls.length, "shipped: UNDETERMINED never stops").toBe(0);
    const mutated = runBody({ secretsListBehavior: "transport", containOnUndetermined: true });
    expect(mutated.stopCalls.length, "mutation stops a machine on an undetermined read").toBeGreaterThan(0);
  }, 60_000);

  it("(mutation) retrying a mutating call: `secrets set` is retried on a transport blip", () => {
    const control = runBody({ secretsSetBehavior: "transport" });
    expect(control.secretsSetCalls.length, "shipped: the mutation is attempted once, never retried").toBe(1);
    const mutated = runBody({ secretsSetBehavior: "transport", retrySecretsSet: true });
    expect(mutated.secretsSetCalls.length, "mutation retries the mutating call 3x").toBe(3);
  }, 60_000);

  it("(mutation) deleting the rotation `source` line breaks the shipped step", () => {
    const control = runBody({});
    expect(control.status, `control stderr: ${control.stderr}`).toBe(0);
    const mutated = runBody({ deleteRotationSource: true });
    expect(mutated.status, "mutation: no helper, step fails").not.toBe(0);
    expect(mutated.stderr).toMatch(/fly_retry: (command )?not found/);
  }, 60_000);
});

/**
 * Pre-flight read (gap O6b): the test runs the EXTRACTED pre-flight wrap, not a
 * hard-coded copy, so a second bare `flyctl` read added there is caught.
 */
interface PreflightOptions {
  behavior: string;
  secondBareRead?: boolean;
  revertWrap?: boolean;
}
function runPreflight(opts: PreflightOptions): { status: number | null; stderr: string; calls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "egress-rot-pf-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  const callLog = join(dir, "calls.log").replace(/\\/g, "/");
  const mlist = join(dir, "mlist.json").replace(/\\/g, "/");
  writeFileSync(mlist, machineJson("started"));
  writeFileSync(
    join(binDir, "flyctl"),
    [
      "#!/usr/bin/env bash",
      `printf 'flyctl %s\\n' "$*" >>"${callLog}"`,
      'n=0; [ -f "$C" ] && n="$(cat "$C")"; n=$((n + 1)); printf "%s" "$n" > "$C"',
      'read -ra b <<< "$BEHAVIOR"; i=$((n - 1)); [ "$i" -ge "${#b[@]}" ] && i=$(( ${#b[@]} - 1 ))',
      'case "${b[$i]}" in',
      '  transport) echo "Error: could not list machines: read tcp 1->2:443: read: connection reset by peer" >&2; exit 1 ;;',
      '  *) cat "$MLIST"; exit 0 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "flyctl"), 0o755);
  writeJqShim(binDir);
  writeFileSync(join(dir, "scripts", "flyctl-transport-retry.sh"), helperSource());

  let region = preflightRegion();
  if (opts.secondBareRead) {
    const before = region;
    region = region.replace(
      'machines_json="$FLY_RETRY_STDOUT"',
      'machines_json="$FLY_RETRY_STDOUT"\nmachines_json="$(flyctl machine list --app "$app" --json)"',
    );
    expect(region, "secondBareRead did not apply").not.toBe(before);
  }
  if (opts.revertWrap) {
    const before = region;
    region = region.replace(
      'fly_retry preflight-list -- flyctl machine list --app "$app" --json\nmachines_json="$FLY_RETRY_STDOUT"',
      'machines_json="$(flyctl machine list --app "$app" --json)"',
    );
    expect(region, "revertWrap did not apply").not.toBe(before);
  }

  const harness = [
    "set -euo pipefail",
    "sleep() { :; }",
    "export FLY_RETRY_BACKOFF_SECONDS=0",
    rotationSourceLine(),
    `app="mendpoint-talal"`,
    region,
    "",
  ].join("\n");
  writeFileSync(join(dir, "pf.sh"), harness);
  const result = spawnSync("bash", ["--noprofile", "--norc", "pf.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${SEP}${process.env.PATH ?? ""}`,
      C: join(dir, "c").replace(/\\/g, "/"),
      MLIST: mlist,
      BEHAVIOR: opts.behavior,
      REAL_JQ,
    },
  });
  const calls = existsSync(callLog) ? readFileSync(callLog, "utf8").split("\n").filter(Boolean) : [];
  return { status: result.status, stderr: result.stderr ?? "", calls };
}

describe("egress rotation #728 — the pre-flight read is transport-retried, extracted from the YAML (gap O6b)", () => {
  it("a transport blip then success is retried", () => {
    const r = runPreflight({ behavior: "transport ok" });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.calls.length, "retried past the blip").toBe(2);
  }, 60_000);

  it("(mutation) a SECOND bare flyctl read after the wrap is caught by the extracted region", () => {
    const control = runPreflight({ behavior: "transport ok ok" });
    expect(control.status, "control: one wrapped read").toBe(0);
    expect(control.calls.length, "control: exactly the retried read").toBe(2);
    const mutated = runPreflight({ behavior: "transport ok ok", secondBareRead: true });
    // The extra bare read is a THIRD flyctl call that the shipped code never makes.
    expect(mutated.calls.length, "mutation adds a bare read").toBe(3);
  }, 60_000);

  it("(mutation) reverting the wrap to a bare `$(...)` loses the retry", () => {
    const control = runPreflight({ behavior: "transport ok" });
    expect(control.status).toBe(0);
    const mutated = runPreflight({ behavior: "transport ok", revertWrap: true });
    expect(mutated.status, "mutation: bare command substitution aborts on the blip").not.toBe(0);
    expect(mutated.calls.length).toBe(1);
  }, 60_000);
});
