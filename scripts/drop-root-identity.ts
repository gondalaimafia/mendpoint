export interface ProcessIdentityAuthority {
  getuid?: () => number;
  getgid?: () => number;
  getgroups?: () => number[];
  setgroups?: (groups: readonly number[]) => void;
  setgid?: (gid: number) => void;
  setuid?: (uid: number) => void;
}

export function dropRootIdentity(
  identity: ProcessIdentityAuthority = process as ProcessIdentityAuthority,
  target: Readonly<{ uid: number; gid: number }> = { uid: 1000, gid: 1000 },
): boolean {
  if (typeof identity.getuid !== "function" || identity.getuid() !== 0) return false;
  if (
    typeof identity.getgid !== "function" ||
    typeof identity.getgroups !== "function" ||
    typeof identity.setgroups !== "function" ||
    typeof identity.setgid !== "function" ||
    typeof identity.setuid !== "function"
  ) throw new Error("privilege_drop_api_required");

  identity.setgroups([]);
  identity.setgid(target.gid);
  identity.setuid(target.uid);

  const supplementaryGroups = identity.getgroups().filter((gid) => gid !== target.gid);
  if (
    identity.getuid() !== target.uid ||
    identity.getgid() !== target.gid ||
    supplementaryGroups.length > 0
  ) throw new Error("privilege_drop_verification_failed");
  return true;
}
