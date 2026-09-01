/**
 * The launcher's boot ORDER, extracted from scripts/start-fly.mjs so it can be
 * executed by tests instead of asserted by scanning the file.
 *
 * Scanning could not do this job. Deleting the live `startProcess("backup", ...)`
 * call, or the live boot reap, and leaving each behind in a comment kept every
 * source-text assertion green: a comment satisfies a regex exactly as well as
 * running code does. What the tests actually needed to know is the order and the
 * conditions, so those live here as one function with injected dependencies.
 *
 * Three properties, none of which a text scan can establish:
 *
 *   1. The dead-owner fence reap happens BEFORE the mutation lease. Inside the
 *      lease closure it is unreachable, because the lease is what refuses to boot
 *      when a marker is present -- the very situation the reap exists to clear.
 *   2. The backup scheduler starts only on the customer profile, and only as a
 *      NON-CRITICAL child, so its death is never the product's death.
 *   3. api, worker and web start critical, because they are the product.
 */

export interface BootChildStart {
  readonly name: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly role: string;
  readonly critical: boolean;
}

export interface CustomerBootSequenceDeps {
  readonly profile: string | undefined;
  /** Null off the customer profile, where there is no backup fence at all. */
  readonly fenceRoot: string | null;
  readonly reapAtBoot: (input: { fenceRoot: string }) => { reaped: boolean; reason: string };
  /** initializeWithMutationLease. Runs the callback under the fence lease. */
  readonly withMutationLease: (run: () => void) => void;
  /** The setup work the launcher already does inside the lease. */
  readonly prepareInsideLease: () => void;
  readonly startChild: (child: BootChildStart) => void;
  readonly appRoot: string;
  readonly webRoot: string;
  readonly pollIntervalMs: string;
  readonly log?: (message: string) => void;
}

export function customerBootChildren(
  profile: string | undefined,
  appRoot: string,
  webRoot: string,
  pollIntervalMs: string,
): BootChildStart[] {
  const children: BootChildStart[] = [
    {
      name: "api",
      args: ["--import", "tsx", "apps/api/src/server.ts"],
      cwd: appRoot,
      role: "api",
      critical: true,
    },
    {
      name: "worker",
      args: ["--import", "tsx", "apps/worker/src/cli.ts", "run-service", "--interval", pollIntervalMs],
      cwd: appRoot,
      role: "worker",
      critical: true,
    },
    { name: "web", args: ["start-production.mjs"], cwd: webRoot, role: "web", critical: true },
  ];
  // The backup trigger holds the backup key and the object-store credentials, so
  // it runs as its own role rather than widening api, worker or web. Started only
  // on the customer profile: no other profile has a backup to take, and a child
  // with nothing to do is a child that can fail.
  if (profile === "customer") {
    children.push({
      name: "backup",
      args: ["--import", "tsx", "scripts/customer-backup-scheduler.ts"],
      cwd: appRoot,
      role: "backup",
      critical: false,
    });
  }
  return children;
}

export function runCustomerBootSequence(deps: CustomerBootSequenceDeps): void {
  const log = deps.log ?? ((message: string) => console.error(message));
  // Step 1, before the lease. A backup hard-killed by the shutdown SIGKILL leaves
  // its exclusive marker behind, and the lease then refuses to boot at all --
  // previously needing a human to run `npm run backup:fence:recover` at exactly
  // the moment nothing would start.
  if (deps.profile === "customer" && deps.fenceRoot) {
    try {
      const reaped = deps.reapAtBoot({ fenceRoot: deps.fenceRoot });
      if (reaped.reaped) log(`backup fence reaped at boot: ${reaped.reason}`);
      else if (reaped.reason.startsWith("liveness_undeterminable")) {
        // The third state, said out loud: not reaped, and not because the owner
        // is known to be running. If this repeats, the lease will keep refusing.
        log(`backup fence liveness undeterminable at boot: ${reaped.reason}`);
      }
    } catch (error) {
      // Never block boot on the reaper itself; the lease below still fails closed.
      log(`backup fence reap at boot failed: ${(error as Error)?.message ?? String(error)}`);
    }
  }

  // Step 2, under the lease: the existing setup work, then the children.
  deps.withMutationLease(() => {
    deps.prepareInsideLease();
    for (const child of customerBootChildren(
      deps.profile,
      deps.appRoot,
      deps.webRoot,
      deps.pollIntervalMs,
    )) deps.startChild(child);
  });
}
