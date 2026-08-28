/**
 * Configuration completeness gate.
 *
 * Every "shipped but never ran" incident in this repo shared one shape: a
 * workflow referenced configuration that did not exist in the environment it
 * names, and nothing failed until the scheduled run fired — sometimes for a
 * day, sometimes never having succeeded at all. PR CI cannot catch this: a
 * scheduled workflow's secret path is unreachable code at review time.
 *
 * Three visible states, never two
 * -------------------------------
 *   required        must exist; absence is a FAILURE.
 *   optional_gated  may be absent; a named runtime gate makes absence safe.
 *                   Absence is REPORTED every run, never a failure, and the
 *                   gate expression is recorded so "deliberately absent"
 *                   cannot silently decay into "forgotten".
 *   undeclared      referenced by a workflow, missing from the manifest.
 *                   Always a FAILURE — an unreviewed config dependency.
 *
 * Static mode (default, no credentials, runs in CI on every PR):
 *   CONFIG_UNDECLARED                every secrets./vars. reference is declared
 *   CONFIG_ENVIRONMENT_UNBOUND       a job using environment-scoped secrets
 *                                    declares environment: (or delegates)
 *   CONFIG_SHELL_REQUIRED_UNPROVIDED names a required=() loop asserts are
 *                                    actually provided by an env: block
 *
 * Live mode (--live, needs gh credentials, for local and scheduled use):
 *   CONFIG_MISSING          declared-required names exist in their scope
 *   CONFIG_SCOPE_UNREADABLE an unreadable scope fails closed; it never reads
 *                           as "everything present"
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

/**
 * `environments` (plural) is for a reusable workflow whose `environment:` is an
 * input: the concrete scope is whatever its callers pass, so the name must exist
 * in EVERY such environment. Collapsing that to one environment would let a
 * caller-specific gap pass unseen.
 */
type Scope =
  | { kind: "repo" }
  | { kind: "environment"; environment: string }
  | { kind: "environments"; environments: string[] };
type Status = "required" | "optional_gated";

interface Entry {
  name: string;
  type: "secret" | "variable";
  scope: Scope;
  status: Status;
  /** For optional_gated: the runtime expression that makes absence safe. */
  gatedBy?: string;
  note?: string;
}

interface Manifest {
  schemaVersion: 1;
  entries: Entry[];
}

interface Issue {
  code: string;
  subject: string;
  message: string;
}

const ROOT = resolve(import.meta.dirname, "..");
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");
const MANIFEST_PATH = join(ROOT, "config", "required-configuration.json");

function add(issues: Issue[], code: string, subject: string, message: string): void {
  issues.push({ code, subject, message });
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();
}

interface Reference {
  name: string;
  type: "secret" | "variable";
  job: string | null;
}

const SECRET_PATTERN = /\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g;
const VARIABLE_PATTERN = /\bvars\.([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * GITHUB_TOKEN is minted by Actions itself, never provisioned, so it is not a
 * configuration dependency and is excluded everywhere.
 */
function collectReferences(text: string, job: string | null, into: Reference[]): void {
  for (const match of text.matchAll(SECRET_PATTERN)) {
    if (match[1] !== "GITHUB_TOKEN") into.push({ name: match[1]!, type: "secret", job });
  }
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    into.push({ name: match[1]!, type: "variable", job });
  }
}

function referencesOf(source: string, doc: unknown): Reference[] {
  const found: Reference[] = [];
  const jobs = ((doc as { jobs?: Record<string, unknown> })?.jobs ?? {}) as Record<string, unknown>;
  const seenInJobs = new Set<string>();
  for (const [jobName, spec] of Object.entries(jobs)) {
    const before = found.length;
    collectReferences(JSON.stringify(spec), jobName, found);
    for (let i = before; i < found.length; i += 1) seenInJobs.add(`${found[i]!.type}:${found[i]!.name}`);
  }
  // References outside any job (top-level env, workflow_call inputs) still need
  // declaring; attribute them to no job rather than dropping them.
  const outside: Reference[] = [];
  collectReferences(source, null, outside);
  for (const reference of outside) {
    if (!seenInJobs.has(`${reference.type}:${reference.name}`)) found.push(reference);
  }
  return found;
}

/**
 * A job satisfies environment binding either by declaring `environment:`, or by
 * delegating to a reusable workflow with `secrets: inherit` (the callee then
 * declares it). Anything else resolves the secret to an empty string at runtime.
 */
function environmentBinding(spec: Record<string, unknown>): { declared: boolean; delegated: boolean } {
  const environment = spec.environment;
  const declared = typeof environment === "string" || (typeof environment === "object" && environment !== null);
  const delegated = typeof spec.uses === "string" && spec.secrets === "inherit";
  return { declared, delegated };
}

/** Names asserted non-empty by a `required=( ... )` shell loop. */
function shellRequiredNames(spec: Record<string, unknown>): string[] {
  const text = JSON.stringify(spec);
  const names = new Set<string>();
  for (const match of text.matchAll(/required=\(([^)]*)\)/g)) {
    for (const token of (match[1] ?? "").split(/[^A-Za-z0-9_]+/)) {
      if (/^MENDPOINT_[A-Z0-9_]+$/.test(token)) names.add(token);
    }
  }
  return [...names].sort();
}

/**
 * Every name the job puts in the process environment, by any of the three
 * mechanisms Actions provides: job-level `env:`, step-level `env:`, and a step
 * exporting to `$GITHUB_ENV` at runtime. Missing the third produces false
 * positives on any workflow that derives configuration before asserting it.
 */
function providedNames(spec: Record<string, unknown>): Set<string> {
  const provided = new Set<string>();
  for (const key of Object.keys((spec.env ?? {}) as Record<string, unknown>)) provided.add(key);
  const steps = (spec.steps ?? []) as Record<string, unknown>[];
  for (const step of steps) {
    for (const key of Object.keys((step?.env ?? {}) as Record<string, unknown>)) provided.add(key);
    const run = typeof step?.run === "string" ? step.run : "";
    if (!run.includes("GITHUB_ENV")) continue;
    // `NAME=value >> "$GITHUB_ENV"`, `echo "NAME=..." >> $GITHUB_ENV`, and
    // heredoc bodies all start the assignment with the name at a token boundary.
    for (const match of run.matchAll(/([A-Z][A-Z0-9_]{2,})=/g)) provided.add(match[1]!);
  }
  return provided;
}

/**
 * Agent and tooling config that must parse for the tool reading it to work at
 * all. A malformed file here does not announce itself: an operator's personal
 * `settings.json` was two concatenated JSON objects for an unknown period, so
 * every hook, statusLine, plugin, and permission it declared was silently
 * inert — indistinguishable from a file that was simply configured that way.
 *
 * `.codex/config.toml` is deliberately absent: no TOML parser is available
 * here, and a check that cannot actually parse must not report as if it did.
 */
const PARSE_CHECKED: readonly string[] = [
  ".claude/settings.json",
  "config/production-closure-authority.json",
  "config/production-closure-authority-rotation.json",
  "config/required-configuration.json",
  "package.json",
  "tsconfig.base.json",
];

/** JSON with comments is not valid JSON here; these files are plain JSON. */
export function parseIssues(root: string = ROOT, files: readonly string[] = PARSE_CHECKED): Issue[] {
  const issues: Issue[] = [];
  for (const relative of files) {
    const path = join(root, relative);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      // A tracked config that cannot be read is a failure, not an absence.
      add(issues, "CONFIG_FILE_UNREADABLE", relative, "tracked configuration file could not be read");
      continue;
    }
    try {
      JSON.parse(raw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const concatenated = /after JSON|Unexpected non-whitespace/i.test(detail) || /\}\s*\{/.test(raw);
      add(
        issues,
        "CONFIG_FILE_UNPARSEABLE",
        relative,
        concatenated
          ? `does not parse as JSON (${detail}) — this looks like two concatenated objects; everything the file declares is silently inert until it is merged into one`
          : `does not parse as JSON (${detail}); everything the file declares is silently inert`,
      );
    }
  }
  return issues;
}

/**
 * A hook whose command points at a missing script fails silently — the same
 * shape as the malformed settings file: configured, believed active, doing
 * nothing.
 */
export function hookIssues(root: string = ROOT): Issue[] {
  const issues: Issue[] = [];
  const settingsPath = join(root, ".claude", "settings.json");
  let settings: { hooks?: Record<string, unknown> };
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks?: Record<string, unknown> };
  } catch {
    // Unparseable is already reported by parseIssues; do not double-report.
    return issues;
  }
  for (const [event, matchers] of Object.entries(settings.hooks ?? {})) {
    for (const matcher of (matchers ?? []) as { hooks?: { command?: string }[] }[]) {
      for (const hook of matcher.hooks ?? []) {
        const command = hook.command;
        if (typeof command !== "string") continue;
        // Only validate repo-relative script paths the command names.
        for (const match of command.matchAll(/(?:^|\s)((?:\.[\w./-]+|[\w][\w./-]*)\.(?:mjs|cjs|js|ts|sh))\b/g)) {
          const script = match[1]!;
          if (script.startsWith("/") || /^[A-Za-z]:/.test(script)) continue;
          if (!existsSync(join(root, script))) {
            add(
              issues,
              "CONFIG_HOOK_SCRIPT_MISSING",
              `${event}:${script}`,
              `a ${event} hook runs ${script}, which does not exist — the hook silently does nothing`,
            );
          }
        }
      }
    }
  }
  return issues;
}

export function staticIssues(manifest: Manifest, workflowDir: string = WORKFLOW_DIR): Issue[] {
  const issues: Issue[] = [];
  const declared = new Map(manifest.entries.map((entry) => [`${entry.type}:${entry.name}`, entry]));

  const files = readdirSync(workflowDir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();

  for (const file of files) {
    const source = readFileSync(join(workflowDir, file), "utf8");
    let doc: unknown;
    try {
      doc = parse(source);
    } catch {
      add(issues, "WORKFLOW_UNPARSEABLE", file, "workflow YAML does not parse");
      continue;
    }
    const jobs = ((doc as { jobs?: Record<string, Record<string, unknown>> })?.jobs ?? {});

    for (const reference of referencesOf(source, doc)) {
      const entry = declared.get(`${reference.type}:${reference.name}`);
      if (!entry) {
        add(
          issues,
          "CONFIG_UNDECLARED",
          `${file}:${reference.name}`,
          `workflow references ${reference.type} ${reference.name}, which config/required-configuration.json does not declare; declare its scope and whether absence is gated`,
        );
        continue;
      }
      if (reference.job && entry.type === "secret" && entry.scope.kind === "environment") {
        const spec = jobs[reference.job];
        if (spec) {
          const { declared: hasEnvironment, delegated } = environmentBinding(spec);
          if (!hasEnvironment && !delegated) {
            add(
              issues,
              "CONFIG_ENVIRONMENT_UNBOUND",
              `${file}:${reference.job}:${reference.name}`,
              `job uses ${reference.name}, which is scoped to environment ${entry.scope.environment}, without declaring environment: — the secret resolves to an empty string at runtime`,
            );
          }
        }
      }
    }

    for (const [jobName, spec] of Object.entries(jobs)) {
      const provided = providedNames(spec);
      for (const name of shellRequiredNames(spec)) {
        if (!provided.has(name)) {
          add(
            issues,
            "CONFIG_SHELL_REQUIRED_UNPROVIDED",
            `${file}:${jobName}:${name}`,
            `a required=() loop asserts ${name} is non-empty, but no job or step env: provides it — the assertion fails at runtime`,
          );
        }
      }
    }
  }
  return issues;
}

function ghJson(path: string): unknown {
  const output = execFileSync("gh", ["api", "--paginate", path], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(output);
}

export function liveIssues(
  manifest: Manifest,
  repo: string,
  read: (path: string) => unknown = ghJson,
): { issues: Issue[]; gatedAbsent: Entry[] } {
  const issues: Issue[] = [];
  const gatedAbsent: Entry[] = [];
  const cache = new Map<string, Set<string> | null>();

  const scopeSet = (bucket: string, environment: string | null): Set<string> | null => {
    const key = environment === null ? `repo:${bucket}` : `env:${environment}:${bucket}`;
    if (!cache.has(key)) {
      const path =
        environment === null
          ? `repos/${repo}/actions/${bucket}?per_page=100`
          : `repos/${repo}/environments/${environment}/${bucket}?per_page=100`;
      try {
        const payload = read(path) as Record<string, { name: string }[]>;
        cache.set(key, new Set((payload[bucket] ?? []).map((item) => item.name)));
      } catch {
        // An unreadable scope must never render as "everything present".
        cache.set(key, null);
      }
    }
    return cache.get(key)!;
  };

  for (const entry of manifest.entries) {
    const bucket = entry.type === "secret" ? "secrets" : "variables";
    const environments =
      entry.scope.kind === "repo"
        ? [null]
        : entry.scope.kind === "environment"
          ? [entry.scope.environment]
          : entry.scope.environments;

    const absentFrom: string[] = [];
    let unreadable = false;
    for (const environment of environments) {
      const present = scopeSet(bucket, environment);
      if (present === null) {
        add(
          issues,
          "CONFIG_SCOPE_UNREADABLE",
          `${environment ?? "repository"}:${bucket}`,
          "could not read this scope; absence cannot be distinguished from unreadability",
        );
        unreadable = true;
        continue;
      }
      if (!present.has(entry.name)) absentFrom.push(environment ?? "repository");
    }
    if (unreadable || absentFrom.length === 0) continue;
    if (entry.status === "optional_gated") {
      gatedAbsent.push(entry);
      continue;
    }
    add(
      issues,
      "CONFIG_MISSING",
      `${absentFrom.join(",")}:${entry.name}`,
      "declared required but absent; the workflow referencing it fails at runtime",
    );
  }
  return { issues, gatedAbsent };
}

/** Human-readable scope, exhaustive over Scope so a new kind is a compile error. */
export function describeScope(scope: Scope): string {
  switch (scope.kind) {
    case "repo":
      return "repository";
    case "environment":
      return `environment ${scope.environment}`;
    case "environments":
      return `environments ${scope.environments.join(",")}`;
  }
}

export function loadManifest(path: string = MANIFEST_PATH): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

function main(): void {
  const live = process.argv.includes("--live");
  const repo = process.env.MENDPOINT_CONFIG_REPO ?? "gondalaimafia/mendpoint";
  const manifest = loadManifest();
  const issues = [...parseIssues(), ...hookIssues(), ...staticIssues(manifest)];
  let gatedAbsent: Entry[] = [];

  if (live) {
    const result = liveIssues(manifest, repo);
    issues.push(...result.issues);
    gatedAbsent = result.gatedAbsent;
  }

  for (const entry of gatedAbsent) {
    const where = describeScope(entry.scope);
    console.log(
      `GATED_ABSENT ${where}:${entry.name} — absent by design; gated by ${entry.gatedBy ?? "(gate not recorded)"}`,
    );
  }
  for (const issue of issues) {
    console.error(`${issue.code} ${issue.subject}: ${issue.message}`);
  }
  if (issues.length > 0) {
    throw new Error(
      `configuration completeness: ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
    );
  }
  console.log(
    `CONFIG COMPLETENESS PASS (${live ? "static+live" : "static"}): ${manifest.entries.length} declared, ${gatedAbsent.length} gated-absent`,
  );
}

if (import.meta.filename === process.argv[1]) main();
