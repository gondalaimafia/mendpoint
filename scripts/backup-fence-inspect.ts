import {
  inspectMutationFence,
  prepareMutationFenceDirectories,
  resolveMutationFenceRoot,
} from "@mendpoint/ops";

const fenceRoot = resolveMutationFenceRoot();
prepareMutationFenceDirectories(fenceRoot);
if (
  typeof process.getuid === "function" &&
  typeof process.setgid === "function" &&
  typeof process.setuid === "function" &&
  process.getuid() === 0
) {
  process.setgid(1000);
  process.setuid(1000);
}
console.log(JSON.stringify(inspectMutationFence(fenceRoot), null, 2));
