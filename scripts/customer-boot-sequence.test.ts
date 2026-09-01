import { describe, expect, it } from "vitest";

import {
  customerBootChildren,
  runCustomerBootSequence,
  type BootChildStart,
} from "./customer-boot-sequence.js";

function harness(profile: string | undefined, options: { fenceRoot?: string | null } = {}) {
  const order: string[] = [];
  const started: BootChildStart[] = [];
  const logs: string[] = [];
  let reapCalls = 0;
  const run = (reap?: () => { reaped: boolean; reason: string }) =>
    runCustomerBootSequence({
      profile,
      fenceRoot: options.fenceRoot === undefined ? "/data/db/.backup-fence" : options.fenceRoot,
      reapAtBoot: () => {
        reapCalls += 1;
        order.push("reap");
        return reap ? reap() : { reaped: true, reason: "reaped_dead_owner" };
      },
      withMutationLease: (inner) => {
        order.push("lease");
        inner();
      },
      prepareInsideLease: () => order.push("prepare"),
      startChild: (child) => {
        order.push(`start:${child.name}`);
        started.push(child);
      },
      appRoot: "/app",
      webRoot: "/web",
      pollIntervalMs: "5000",
      log: (message) => logs.push(message),
    });
  return { run, order, started, logs, reapCalls: () => reapCalls };
}

describe("boot order", () => {
  it("reaps a dead-owner fence BEFORE taking the mutation lease", () => {
    const h = harness("customer");
    h.run();
    // Inside the lease closure the reap is unreachable: the lease is what refuses
    // to boot while a marker is present, which is the case the reap clears.
    expect(h.order.indexOf("reap")).toBeLessThan(h.order.indexOf("lease"));
    expect(h.order.slice(0, 3)).toEqual(["reap", "lease", "prepare"]);
    expect(h.logs.join(" ")).toContain("backup fence reaped at boot: reaped_dead_owner");
  });

  it("starts children only after the setup work, inside the lease", () => {
    const h = harness("customer");
    h.run();
    expect(h.order.indexOf("prepare")).toBeLessThan(h.order.indexOf("start:api"));
    expect(h.order.indexOf("lease")).toBeLessThan(h.order.indexOf("start:api"));
  });

  it("says so out loud when liveness could not be determined", () => {
    const h = harness("customer");
    h.run(() => ({ reaped: false, reason: "liveness_undeterminable:process_start_time_unavailable" }));
    // Not reaped, and NOT because the owner is known to be running. Silence here
    // would leave a lease that keeps refusing with nothing explaining why.
    expect(h.logs.join(" ")).toContain("backup fence liveness undeterminable at boot");
  });

  it("does not let a throwing reaper block boot", () => {
    const h = harness("customer");
    h.run(() => { throw new Error("fence exploded"); });
    expect(h.logs.join(" ")).toContain("backup fence reap at boot failed: fence exploded");
    // The lease still runs, and still fails closed on its own terms.
    expect(h.order).toContain("lease");
    expect(h.started.map((child) => child.name)).toContain("api");
  });
});

describe("which children start, and how", () => {
  it("starts the backup scheduler on the customer profile, non-critical", () => {
    const h = harness("customer");
    h.run();
    const backup = h.started.find((child) => child.name === "backup");
    expect(backup).toBeDefined();
    // The whole point of the role split: it runs under `backup`, not `worker`.
    expect(backup!.role).toBe("backup");
    expect(backup!.args).toEqual(["--import", "tsx", "scripts/customer-backup-scheduler.ts"]);
    // Non-critical: a backup helper's death must never be the product's death.
    expect(backup!.critical).toBe(false);
  });

  it("starts no backup child, and does not reap, off the customer profile", () => {
    for (const profile of ["demo", "pilot", undefined]) {
      const h = harness(profile);
      h.run();
      expect(h.started.map((child) => child.name)).toEqual(["api", "worker", "web"]);
      expect(h.reapCalls()).toBe(0);
      expect(h.order).not.toContain("reap");
    }
  });

  it("keeps api, worker and web critical", () => {
    const h = harness("customer");
    h.run();
    for (const name of ["api", "worker", "web"]) {
      expect(h.started.find((child) => child.name === name)!.critical).toBe(true);
    }
  });

  it("does not reap when there is no fence to reap", () => {
    const h = harness("customer", { fenceRoot: null });
    h.run();
    expect(h.reapCalls()).toBe(0);
    expect(h.started.map((child) => child.name)).toContain("backup");
  });

  it("threads the poll interval and roots through to the children", () => {
    const children = customerBootChildren("customer", "/app", "/web", "9000");
    expect(children.find((child) => child.name === "worker")!.args).toContain("9000");
    expect(children.find((child) => child.name === "web")!.cwd).toBe("/web");
    expect(children.every((child) => child.role === child.name)).toBe(true);
  });
});
