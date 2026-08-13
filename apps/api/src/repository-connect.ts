/**
 * Self-serve repository connect (S0-C).
 *
 * Clone-on-connect: when a customer connects a repository we MATERIALIZE its
 * checkout into MENDPOINT_REPOS_DIR/<tenantId>/<repoKey> (production) or the flat
 * MENDPOINT_REPOS_DIR/<repoKey> dev layout, so resolveRepoKey finds it because
 * connect created it. Previously the on-disk checkout had to be pre-provisioned.
 *
 * The whole flow is inert unless MENDPOINT_SELF_SERVE_CONNECT=1, so existing
 * behavior is byte-identical when the flag is off: resolveRepoKey keeps its
 * pre-existing-checkout requirement and the connect route 404s.
 *
 * Real mode (GITHUB_MODE=real) clones over HTTPS with a least-privilege
 * installation/repo-scoped token (code-complete, credential-gated). Mock mode
 * (default) writes a deterministic Git fixture so the flow works without any
 * real GitHub credentials.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppDb } from "@mendpoint/db";
import {
  InstallationTokenCache,
  loadAppCredentials,
} from "@mendpoint/github";
import { Hono, type Context } from "hono";
import type { ApiEnv } from "./auth.js";
import { repoKeyCheckoutDestination, resolveRepoKey } from "./repo-path.js";
import {
  registerConnectedRepository,
  registerScmConnection,
} from "./repository-connections.js";

export const SELF_SERVE_CONNECT_FLAG = "MENDPOINT_SELF_SERVE_CONNECT" as const;

export type ConnectProvider = "github" | "gitlab" | "local_git";

const CONNECT_PROVIDERS = new Set<ConnectProvider>(["github", "gitlab", "local_git"]);
const REPOSITORY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export function selfServeConnectEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[SELF_SERVE_CONNECT_FLAG] === "1";
}

function githubMode(env: NodeJS.ProcessEnv): "mock" | "real" {
  return (env.GITHUB_MODE ?? "mock") === "real" ? "real" : "mock";
}

/** Provider-agnostic checkout request handed to a cloner implementation. */
export type RepositoryCheckoutRequest = Readonly<{
  provider: ConnectProvider;
  owner: string;
  name: string;
  branch: string;
  /** Absolute, tenant-scoped destination computed by repoKeyCheckoutDestination. */
  destination: string;
  /** Real-mode installation/repo-scoped token accessor; unused in mock mode. */
  tokenProvider?: () => Promise<string>;
}>;

/** Materializes a checkout at request.destination. Must be idempotent. */
export type RepositoryCheckoutCloner = (
  request: RepositoryCheckoutRequest,
) => Promise<void>;

function git(cwd: string, token: string | undefined, args: readonly string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (cause) {
    throw new Error(`repository_clone_git_failed:${scrubToken(gitErrorSummary(cause), token)}`);
  }
}

function gitClone(
  token: string | undefined,
  args: readonly string[],
): void {
  try {
    execFileSync("git", ["clone", ...args], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    throw new Error(`repository_clone_git_failed:${scrubToken(gitErrorSummary(cause), token)}`);
  }
}

function gitErrorSummary(cause: unknown): string {
  const stderr = (cause as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim().split("\n")[0]!;
  return cause instanceof Error ? cause.message : String(cause);
}

function scrubToken(message: string, token: string | undefined): string {
  return token ? message.split(token).join("***") : message;
}

function cloneUrl(
  provider: ConnectProvider,
  owner: string,
  name: string,
  token: string | undefined,
): string {
  if (provider === "github") {
    const auth = token ? `x-access-token:${token}@` : "";
    return `https://${auth}github.com/${owner}/${name}.git`;
  }
  if (provider === "gitlab") {
    const auth = token ? `oauth2:${token}@` : "";
    return `https://${auth}gitlab.com/${owner}/${name}.git`;
  }
  throw new Error("local_git_clone_unsupported");
}

/**
 * Deterministic fixture clone for GITHUB_MODE=mock. Produces a real Git worktree
 * (so the downstream local_git snapshot pipeline accepts it) with stable content
 * derived from owner/name. Idempotent: a second call rewrites identical files and
 * commits nothing.
 */
export const mockFixtureClone: RepositoryCheckoutCloner = async (request) => {
  const { destination, owner, name, branch } = request;
  if (!existsSync(join(destination, ".git"))) {
    mkdirSync(destination, { recursive: true });
    git(destination, undefined, ["init", "-b", branch]);
    git(destination, undefined, ["config", "user.name", "Mendpoint Connect"]);
    git(destination, undefined, ["config", "user.email", "connect@mendpoint.invalid"]);
  }
  writeFileSync(
    join(destination, "README.md"),
    `# ${owner}/${name}\n\nMendpoint self-serve connect fixture (mock mode).\n`,
  );
  writeFileSync(
    join(destination, "package.json"),
    `${JSON.stringify(
      { name, private: true, scripts: { test: "echo mendpoint-mock-test" } },
      null,
      2,
    )}\n`,
  );
  git(destination, undefined, ["add", "--all"]);
  if (git(destination, undefined, ["status", "--porcelain"])) {
    git(destination, undefined, ["commit", "-m", `mendpoint connect: ${owner}/${name}`]);
  }
};

/**
 * Real clone for GITHUB_MODE=real using a least-privilege installation/repo-scoped
 * token. Code-complete; only runs when real GitHub App credentials are wired. The
 * token is scrubbed from the stored remote so it never persists on disk.
 */
export const realGitClone: RepositoryCheckoutCloner = async (request) => {
  const { destination, provider, owner, name, branch } = request;
  const token = request.tokenProvider ? await request.tokenProvider() : undefined;
  if (!token) throw new Error("repository_clone_token_required");
  const authedUrl = cloneUrl(provider, owner, name, token);
  const scrubbedUrl = cloneUrl(provider, owner, name, undefined);
  if (existsSync(join(destination, ".git"))) {
    git(destination, token, ["remote", "set-url", "origin", authedUrl]);
    git(destination, token, ["fetch", "--depth", "1", "origin", branch]);
    git(destination, token, ["checkout", "-B", branch, "FETCH_HEAD"]);
  } else {
    mkdirSync(dirname(destination), { recursive: true });
    gitClone(token, ["--depth", "1", "--branch", branch, "--single-branch", authedUrl, destination]);
  }
  git(destination, token, ["remote", "set-url", "origin", scrubbedUrl]);
};

export function defaultCheckoutCloner(
  env: NodeJS.ProcessEnv = process.env,
): RepositoryCheckoutCloner {
  return githubMode(env) === "real" ? realGitClone : mockFixtureClone;
}

function parseProvider(value: unknown): ConnectProvider {
  if (typeof value !== "string" || !CONNECT_PROVIDERS.has(value as ConnectProvider)) {
    throw new Error("connect_provider_invalid");
  }
  return value as ConnectProvider;
}

function requirePart(name: string, value: unknown): string {
  if (typeof value !== "string" || value === "." || value === ".." || !REPOSITORY_PART.test(value)) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}

function requireBranch(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.includes("..") ||
    value.endsWith("/") ||
    value.endsWith(".lock") ||
    !BRANCH.test(value)
  ) {
    throw new Error("connect_branch_invalid");
  }
  return value;
}

export type ConnectRepositoryCheckoutInput = Readonly<{
  tenantId: string;
  repoKey: string;
  provider?: ConnectProvider;
  owner: string;
  name: string;
  ref?: string;
  tokenProvider?: () => Promise<string>;
  cloner?: RepositoryCheckoutCloner;
}>;

export type ConnectRepositoryCheckoutResult = Readonly<{
  destination: string;
  repoKey: string;
  branch: string;
  provider: ConnectProvider;
  reused: boolean;
}>;

/**
 * Clone-on-connect core. Materializes the checkout into the caller tenant's own
 * path (and only that path) and confirms resolveRepoKey resolves it. Idempotent:
 * re-connecting the same repoKey updates the existing checkout in place rather
 * than creating a duplicate.
 */
export async function connectRepositoryCheckout(
  input: ConnectRepositoryCheckoutInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConnectRepositoryCheckoutResult> {
  if (!selfServeConnectEnabled(env)) throw new Error("self_serve_connect_disabled");
  const provider = parseProvider(input.provider ?? "github");
  const owner = requirePart("connect_owner", input.owner);
  const name = requirePart("connect_name", input.name);
  const branch = requireBranch(input.ref ?? "main");
  // Tenant scoping is centralized in repo-path: the destination can only ever be
  // inside MENDPOINT_REPOS_DIR/<tenantId> (production) or the dev root.
  const destination = repoKeyCheckoutDestination(input.repoKey, input.tenantId, env);
  const reused = existsSync(join(destination, ".git"));
  await mkdir(dirname(destination), { recursive: true });
  const cloner = input.cloner ?? defaultCheckoutCloner(env);
  await cloner({ provider, owner, name, branch, destination, tokenProvider: input.tokenProvider });
  // resolveRepoKey re-validates the freshly created checkout via realpath.
  const resolved = resolveRepoKey(input.repoKey, input.tenantId, env);
  return { destination: resolved, repoKey: input.repoKey, branch, provider, reused };
}

export type SelfServeConnectRoutesOptions = Readonly<{
  db: AppDb;
  enabled: boolean;
  env?: NodeJS.ProcessEnv;
  /** Test injection; defaults to the GITHUB_MODE-selected cloner. */
  cloner?: RepositoryCheckoutCloner;
  /** Test injection for the real-mode token accessor. */
  tokenProvider?: () => Promise<string>;
}>;

function replyError(c: Context<ApiEnv>, error: unknown): Response {
  const code = error instanceof Error ? error.message : "connect_failed";
  if (code === "self_serve_connect_disabled") return c.json({ error: "not_found" }, 404);
  if (code === "github_app_credentials_missing" || code === "repository_clone_token_required") {
    return c.json({ error: code }, 503);
  }
  if (code === "scm_connection_tenant_mismatch") return c.json({ error: "not_found" }, 404);
  if (
    code.startsWith("connect_") ||
    code.startsWith("repo_key_") ||
    code.startsWith("repo_path_") ||
    code === "tenant_id_not_path_safe" ||
    code === "remote_id_invalid" ||
    code.startsWith("repository_") ||
    code.startsWith("default_branch_") ||
    code.startsWith("selected_branch_") ||
    code.startsWith("display_name_") ||
    code.startsWith("external_account_id_")
  ) {
    return c.json({ error: code }, 422);
  }
  throw error;
}

function realTokenProvider(
  env: NodeJS.ProcessEnv,
  installationId: unknown,
): () => Promise<string> {
  const credentials = loadAppCredentials(env);
  if (!credentials) throw new Error("github_app_credentials_missing");
  const id = Number(installationId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("connect_installation_id_invalid");
  const cache = new InstallationTokenCache(credentials, id);
  return () => cache.get();
}

/**
 * Self-serve connect route. Mounted always but inert (404) unless
 * MENDPOINT_SELF_SERVE_CONNECT=1. On success it clones the checkout into the
 * caller's tenant path and links it as a local_git connected repository.
 */
export function createSelfServeConnectRoutes(
  options: SelfServeConnectRoutesOptions,
): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>({ strict: false });
  if (!options.enabled) {
    routes.all("*", (c) => c.json({ error: "not_found" }, 404));
    return routes;
  }
  const env = options.env ?? process.env;

  routes.post("/", async (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    if (principal.tenantId.trim() === "") return c.json({ error: "tenant_scope_required" }, 403);
    try {
      const body = await c.req.json<{
        repoKey?: unknown;
        owner?: unknown;
        name?: unknown;
        provider?: unknown;
        ref?: unknown;
        installationId?: unknown;
      }>();
      const provider = parseProvider(body.provider ?? "github");
      const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
      let tokenProvider = options.tokenProvider;
      if (!tokenProvider && provider !== "local_git" && githubMode(env) === "real") {
        tokenProvider = realTokenProvider(env, body.installationId);
      }
      const checkout = await connectRepositoryCheckout(
        {
          tenantId: principal.tenantId,
          repoKey,
          provider,
          owner: body.owner as string,
          name: body.name as string,
          ref: body.ref as string | undefined,
          tokenProvider,
          cloner: options.cloner,
        },
        env,
      );
      const connection = registerScmConnection(options.db, {
        tenantId: principal.tenantId,
        provider: "local_git",
        externalAccountId: checkout.provider === "local_git"
          ? requirePart("connect_owner", body.owner)
          : `${checkout.provider}-${requirePart("connect_owner", body.owner)}`,
        displayName: `${body.owner} ${body.name}`,
      });
      const repository = registerConnectedRepository(options.db, {
        tenantId: principal.tenantId,
        connectionId: connection.id,
        remoteId: repoKey,
        owner: body.owner,
        name: body.name,
        defaultBranch: checkout.branch,
      });
      return c.json(
        {
          checkout: {
            repoKey: checkout.repoKey,
            path: checkout.destination,
            provider: checkout.provider,
            reused: checkout.reused,
          },
          connection,
          repository,
        },
        201,
      );
    } catch (error) {
      return replyError(c, error);
    }
  });

  return routes;
}
