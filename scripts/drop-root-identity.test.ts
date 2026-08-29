import { describe, expect, it } from "vitest";
import { dropRootIdentity, type ProcessIdentityAuthority } from "./drop-root-identity.js";

function rootIdentity(options: { clearGroups?: boolean } = {}) {
  let uid = 0;
  let gid = 0;
  let groups = [0, 27];
  const calls: string[] = [];
  const identity: ProcessIdentityAuthority = {
    getuid: () => uid,
    getgid: () => gid,
    getgroups: () => [...groups, gid],
    setgroups: (next) => {
      calls.push(`setgroups:${next.join(",")}`);
      if (options.clearGroups !== false) groups = [...next];
    },
    setgid: (next) => {
      calls.push(`setgid:${next}`);
      gid = next;
    },
    setuid: (next) => {
      calls.push(`setuid:${next}`);
      uid = next;
    },
  };
  return { identity, calls };
}

describe("root identity drop", () => {
  it("clears supplementary groups before changing gid and uid, then verifies the result", () => {
    const { identity, calls } = rootIdentity();
    expect(dropRootIdentity(identity)).toBe(true);
    expect(calls).toEqual(["setgroups:", "setgid:1000", "setuid:1000"]);
    expect(identity.getuid?.()).toBe(1000);
    expect(identity.getgid?.()).toBe(1000);
    expect(identity.getgroups?.()).toEqual([1000]);
  });

  it("fails closed when supplementary group authority survives", () => {
    const { identity } = rootIdentity({ clearGroups: false });
    expect(() => dropRootIdentity(identity)).toThrow("privilege_drop_verification_failed");
  });

  it("does nothing for an already unprivileged identity", () => {
    const calls: string[] = [];
    expect(dropRootIdentity({
      getuid: () => 1000,
      setgroups: () => calls.push("setgroups"),
      setgid: () => calls.push("setgid"),
      setuid: () => calls.push("setuid"),
    })).toBe(false);
    expect(calls).toEqual([]);
  });
});
