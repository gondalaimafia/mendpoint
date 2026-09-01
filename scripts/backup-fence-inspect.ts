import {
  inspectMutationFence,
  prepareMutationFenceDirectories,
  resolveMutationFenceRoot,
} from "@mendpoint/ops";
import { dropRootIdentity } from "./drop-root-identity.js";

const fenceRoot = resolveMutationFenceRoot();
prepareMutationFenceDirectories(fenceRoot);
dropRootIdentity();
console.log(JSON.stringify(inspectMutationFence(fenceRoot), null, 2));
