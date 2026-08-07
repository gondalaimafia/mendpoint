import {
  recoverStaleMutationMarker,
  prepareMutationFenceDirectories,
  resolveMutationFenceRoot,
} from "@mendpoint/ops";

const kind = process.env.MENDPOINT_BACKUP_RECOVERY_MARKER_KIND;
if (kind !== "writer" && kind !== "exclusive") {
  throw new Error("MENDPOINT_BACKUP_RECOVERY_MARKER_KIND must be writer or exclusive");
}
const fenceRoot = resolveMutationFenceRoot();
prepareMutationFenceDirectories(fenceRoot);
if (typeof process.getuid === "function" && process.getuid() === 0) {
  process.setgid(1000);
  process.setuid(1000);
}
const result = recoverStaleMutationMarker({
  fenceRoot,
  kind,
  markerId: process.env.MENDPOINT_BACKUP_RECOVERY_MARKER_ID ?? "",
  expectedMarkerSha256: process.env.MENDPOINT_BACKUP_RECOVERY_MARKER_SHA256 ?? "",
  ownerTerminationEvidence:
    process.env.MENDPOINT_BACKUP_RECOVERY_OWNER_TERMINATION_EVIDENCE ?? "",
});
console.log(JSON.stringify(result, null, 2));
