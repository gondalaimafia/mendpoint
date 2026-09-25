/**
 * Fail-closed tenant-identity guard at the GitHub write boundary (#724).
 *
 * #713 fixed the tenant-id leak for NEW deliveries by rendering every customer
 * section from an allowlist of public fields at the structured source. That
 * projection (`publicGraphToken`, `publicProviderSlug`) is anchored to whole
 * `:`-separated identifier segments, so it fails OPEN: a tenant id embedded in
 * free text — `owner <H> x`, `{"tenantId":"<H>"}` — or in a not-yet-projected
 * new field passes straight through. This guard is the fail-closed backstop.
 *
 * It wraps the octokit-shaped delivery transport so EVERY customer-facing write
 * (PR create/update title+body, branch/ref creation, commit message, file blob
 * and tree, PR/issue comment, check-run) is checked JUST BEFORE the API call.
 * A hit throws (the caller records the named, non-retryable
 * `tenant_identity_in_customer_output` delivery error) and the underlying
 * transport method is never invoked, so no leaking write reaches a customer
 * repo. Reads and every non-write method pass through untouched.
 */

/** Named, non-retryable delivery error recorded when a GitHub write bound for a
 * customer repo would carry the internal tenant id. */
export const TENANT_IDENTITY_DELIVERY_ERROR = "tenant_identity_in_customer_output";

/** The customer-facing GitHub write kinds the guard inspects. */
export type CustomerWriteKind =
  | "title"
  | "body"
  | "branch"
  | "commit"
  | "file"
  | "comment"
  | "check_run";

/** Where a leak was caught: the transport method and the customer write kind. */
export type TenantIdentityLeak = Readonly<{ method: string; kind: CustomerWriteKind }>;

/**
 * Case-insensitive SUBSTRING match. The tenant id is an internal-only identifier
 * (an unsalted hash of issuer+email, a `newId()` uuid, or `tenant_default`), so
 * ANY occurrence is a leak — even embedded in a larger string and even when it is
 * not a whole `:`-separated segment. This is deliberately stricter than
 * `publicGraphToken`'s segment-anchored projection, which fails open on such a
 * form; this guard is the fail-closed backstop for exactly that gap.
 */
export function containsTenantIdentity(tenantId: string, value: string): boolean {
  if (!tenantId || !value) return false;
  return value.toLowerCase().includes(tenantId.toLowerCase());
}

/** Assert none of `values` (each a customer-facing write of `kind`) carries the
 * tenant id; throw `makeError` for the first that does. */
export function assertNoTenantIdentity(
  tenantId: string,
  method: string,
  values: ReadonlyArray<{ kind: CustomerWriteKind; value: string }>,
  makeError: (leak: TenantIdentityLeak) => Error,
): void {
  for (const { kind, value } of values) {
    if (containsTenantIdentity(tenantId, value)) {
      throw makeError({ method, kind });
    }
  }
}

type WriteArgs = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Decode a blob's content the way the transport sends it (base64 or utf8). */
function blobContent(args: WriteArgs): string {
  const content = str(args.content);
  if (args.encoding === "base64") {
    try {
      return Buffer.from(content, "base64").toString("utf8");
    } catch {
      return content;
    }
  }
  return content;
}

/**
 * The customer-facing strings a raw octokit write would send, keyed by
 * `<namespace>.<method>`. Only WRITE methods appear here; anything else is a read
 * and passes through the guard untouched. Every string a tenant id could ride
 * out on is enumerated — branch (ref), commit message, file path and content, PR
 * title/body/head, comment body, and check-run name/output.
 */
const CUSTOMER_WRITES: Record<
  string,
  (args: WriteArgs) => Array<{ kind: CustomerWriteKind; value: string }>
> = {
  "git.createRef": (a) => [{ kind: "branch", value: str(a.ref) }],
  "git.updateRef": (a) => [{ kind: "branch", value: str(a.ref) }],
  "git.createCommit": (a) => [{ kind: "commit", value: str(a.message) }],
  "git.createBlob": (a) => [{ kind: "file", value: blobContent(a) }],
  "git.createTree": (a) =>
    (Array.isArray(a.tree) ? (a.tree as Array<{ path?: unknown }>) : []).map((entry) => ({
      kind: "file" as const,
      value: str(entry.path),
    })),
  "pulls.create": (a) => [
    { kind: "title", value: str(a.title) },
    { kind: "body", value: str(a.body) },
    { kind: "branch", value: str(a.head) },
  ],
  "pulls.update": (a) => [
    { kind: "title", value: str(a.title) },
    { kind: "body", value: str(a.body) },
  ],
  "issues.createComment": (a) => [{ kind: "comment", value: str(a.body) }],
  "checks.create": (a) => checkRunWrites(a),
  "checks.update": (a) => checkRunWrites(a),
};

function checkRunWrites(a: WriteArgs): Array<{ kind: CustomerWriteKind; value: string }> {
  const output = (a.output ?? {}) as WriteArgs;
  return [
    { kind: "check_run" as const, value: str(a.name) },
    { kind: "check_run" as const, value: str(a.head_branch) },
    { kind: "check_run" as const, value: str(output.title) },
    { kind: "check_run" as const, value: str(output.summary) },
    { kind: "check_run" as const, value: str(output.text) },
  ];
}

/** The namespaces whose write methods the guard inspects. */
const GUARDED_NAMESPACES = new Set(["git", "pulls", "issues", "checks"]);

/**
 * Wrap an octokit-shaped transport so every customer-facing write is checked for
 * the tenant id just before the API call. This is the single lowest choke point:
 * all three adoptive adapters (mock, PAT, GitHub App) deliver through
 * `deliverAdoptiveDraftWithOctokit`, which drives its writes through the wrapped
 * transport. Non-write methods and reads pass through untouched, preserving the
 * transport's own `this`.
 */
export function guardGitHubWrites<T extends object>(
  octokit: T,
  tenantId: string,
  makeError: (leak: TenantIdentityLeak) => Error,
): T {
  const wrapNamespace = (nsName: string, ns: object): object =>
    new Proxy(ns, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop !== "string" || typeof value !== "function") return value;
        const extract = CUSTOMER_WRITES[`${nsName}.${prop}`];
        if (!extract) return (value as (...a: unknown[]) => unknown).bind(target);
        return (...callArgs: unknown[]) => {
          const args = (callArgs[0] ?? {}) as WriteArgs;
          // Reject as a promise (not a synchronous throw) so a guarded write
          // behaves exactly like the async transport method it stands in for.
          try {
            assertNoTenantIdentity(tenantId, `${nsName}.${prop}`, extract(args), makeError);
          } catch (error) {
            return Promise.reject(error);
          }
          return (value as (...a: unknown[]) => unknown).apply(target, callArgs);
        };
      },
    });

  return new Proxy(octokit, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && GUARDED_NAMESPACES.has(prop) && value && typeof value === "object") {
        return wrapNamespace(prop, value as object);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
