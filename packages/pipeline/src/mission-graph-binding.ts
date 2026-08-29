/**
 * Pin a published Change Graph version onto a Mission (spec §11.10).
 *
 * The persistence primitive (`bindMissionGraphVersion`) is set-once. This module
 * is the orchestration seam: it never creates a graph file (it opens only an
 * existing one, which `openGraphLearnDb` then migrates in place), never
 * overwrites a different pinned version, and leaves a Mission unbound when no
 * published version is uniquely identifiable. Multi-repository Fettler campaigns
 * do not pin a single graph version — that would privilege one repository.
 */
import { existsSync } from "node:fs";
import {
  bindMissionGraphVersion,
  getMission,
  listWardenCampaignTargets,
  resolveMissionForFettlerCampaign,
  type AppDb,
  type Mission,
} from "@mendpoint/db";
import {
  getSoftwareGraphHead,
  listSoftwareGraphHeads,
  openGraphLearnDb,
  type GraphLearnDb,
} from "@mendpoint/graph-learn";

export type PinMissionGraphStatus =
  | "bound"
  | "already_bound"
  | "unchanged";

export type PinMissionGraphReason =
  | "mission_not_found"
  | "graph_version_absent"
  | "graph_file_missing"
  | "ambiguous_graph_version"
  | "multi_repository_scope"
  | "already_bound"
  | "conflict";

export type PinMissionGraphResult = Readonly<{
  status: PinMissionGraphStatus;
  reason?: PinMissionGraphReason;
  mission?: Mission;
}>;

function isEphemeralPath(path: string): boolean {
  const normalized = path.trim().toLowerCase();
  return normalized === ":memory:" || normalized === "file::memory:";
}

/**
 * Open an existing graph file only. Missing / ephemeral paths return undefined
 * rather than calling `openGraphLearnDb` (which would create an empty file).
 */
export function openExistingGraphFile(graphPath?: string | null): GraphLearnDb | undefined {
  const path = (graphPath ?? process.env.GRAPH_LEARN_DB ?? "").trim();
  if (!path || isEphemeralPath(path) || !existsSync(path)) return undefined;
  return openGraphLearnDb(path);
}

export function publishedGraphVersionId(
  graphDb: GraphLearnDb,
  tenantId: string,
  repositoryId: string,
  providerId?: string,
): { versionId: string } | { absent: "graph_version_absent" | "ambiguous_graph_version" } {
  if (providerId) {
    const head = getSoftwareGraphHead(graphDb, tenantId, repositoryId, providerId);
    return head ? { versionId: head.versionId } : { absent: "graph_version_absent" };
  }
  const heads = listSoftwareGraphHeads(graphDb, tenantId, repositoryId);
  if (heads.length === 0) return { absent: "graph_version_absent" };
  const versions = new Set(heads.map((head) => head.versionId));
  if (versions.size !== 1) return { absent: "ambiguous_graph_version" };
  return { versionId: heads[0]!.versionId };
}

/**
 * Pin a known published version onto one Mission. Same-version rebind is
 * idempotent. A different already-pinned version is left in place (fail closed).
 */
export function pinKnownGraphVersionToMission(db: AppDb, input: {
  tenantId: string;
  missionId: string;
  graphVersionId: string;
  actorPrincipalId: string;
  correlationId: string;
  createdAt: string;
}): PinMissionGraphResult {
  const current = getMission(db, input.tenantId, input.missionId);
  if (!current) return Object.freeze({ status: "unchanged", reason: "mission_not_found" });
  if (current.graphVersionId === input.graphVersionId) {
    return Object.freeze({ status: "already_bound", reason: "already_bound", mission: current });
  }
  if (current.graphVersionId) {
    return Object.freeze({ status: "already_bound", reason: "conflict", mission: current });
  }
  const mission = bindMissionGraphVersion(db, {
    tenantId: input.tenantId,
    missionId: input.missionId,
    graphVersionId: input.graphVersionId,
    actorPrincipalId: input.actorPrincipalId,
    eventId: `${input.missionId}-graph-version-bound`,
    idempotencyKey: `mission-graph-bind-${input.missionId}`,
    correlationId: input.correlationId,
    createdAt: input.createdAt,
  });
  return Object.freeze({ status: "bound", mission });
}

/**
 * Look up a published software-graph version and pin it when unique. Never
 * creates a graph file. `graphDb`, when supplied, is not closed by this helper.
 */
export function pinPublishedGraphVersionToMission(db: AppDb, input: {
  tenantId: string;
  missionId: string;
  repositoryId: string;
  actorPrincipalId: string;
  correlationId: string;
  createdAt: string;
  providerId?: string;
  graphDb?: GraphLearnDb;
  graphPath?: string | null;
}): PinMissionGraphResult {
  const current = getMission(db, input.tenantId, input.missionId);
  if (!current) return Object.freeze({ status: "unchanged", reason: "mission_not_found" });
  if (current.graphVersionId) {
    return Object.freeze({
      status: "already_bound",
      reason: "already_bound",
      mission: current,
    });
  }
  let opened: GraphLearnDb | undefined;
  const graphDb = input.graphDb ?? (opened = openExistingGraphFile(input.graphPath));
  if (!graphDb) return Object.freeze({ status: "unchanged", reason: "graph_file_missing" });
  try {
    const published = publishedGraphVersionId(
      graphDb, input.tenantId, input.repositoryId, input.providerId,
    );
    if ("absent" in published) {
      return Object.freeze({ status: "unchanged", reason: published.absent });
    }
    return pinKnownGraphVersionToMission(db, {
      tenantId: input.tenantId,
      missionId: input.missionId,
      graphVersionId: published.versionId,
      actorPrincipalId: input.actorPrincipalId,
      correlationId: input.correlationId,
      createdAt: input.createdAt,
    });
  } finally {
    if (opened) {
      try { opened.raw.close(); } catch { /* already closed */ }
    }
  }
}

/**
 * Enroll/launch seam: pin only when the Mission's campaign (or launch) has
 * exactly one repository. Multi-repo scope stays unbound.
 */
export function pinPublishedGraphVersionForSingleRepository(db: AppDb, input: {
  tenantId: string;
  missionId: string;
  repositoryIds: readonly string[];
  actorPrincipalId: string;
  correlationId: string;
  createdAt: string;
  providerId?: string;
  graphDb?: GraphLearnDb;
  graphPath?: string | null;
}): PinMissionGraphResult {
  const unique = [...new Set(input.repositoryIds.filter((id) => id.trim()))];
  if (unique.length !== 1) {
    const mission = getMission(db, input.tenantId, input.missionId);
    return Object.freeze({
      status: "unchanged",
      reason: "multi_repository_scope",
      ...(mission ? { mission } : {}),
    });
  }
  return pinPublishedGraphVersionToMission(db, {
    ...input,
    repositoryId: unique[0]!,
  });
}

export type SingleRepoFettlerCampaignBinding = Readonly<{
  campaignId: string;
  missionId: string;
}>;

/**
 * Campaign-linked Missions whose Fettler campaign targets exactly this one
 * repository. Zero or many matches stay unresolved — this never invents a
 * Mission or picks a winner among ambiguous campaigns.
 */
export function listSingleRepoFettlerCampaignBindings(
  db: AppDb,
  tenantId: string,
  repositoryId: string,
): readonly SingleRepoFettlerCampaignBinding[] {
  if (!tenantId.trim() || !repositoryId.trim()) return Object.freeze([]);
  const rows = db.raw.prepare(
    `SELECT DISTINCT campaign_id AS campaignId FROM fettler_campaign_targets
     WHERE tenant_id = ? AND repository_id = ?`,
  ).all(tenantId, repositoryId) as Array<{ campaignId: string }>;
  const bindings: SingleRepoFettlerCampaignBinding[] = [];
  for (const { campaignId } of rows) {
    const targets = listWardenCampaignTargets(db, tenantId, campaignId);
    if (targets.length !== 1 || targets[0]!.repositoryId !== repositoryId) continue;
    const mission = resolveMissionForFettlerCampaign(db, tenantId, campaignId);
    if (!mission) continue;
    bindings.push(Object.freeze({ campaignId, missionId: mission.id }));
  }
  return Object.freeze(bindings);
}

/**
 * The unique single-repo Fettler campaign Mission for a repository, or
 * undefined when none or more than one exists. Live enqueue seams use this so
 * an unbound `agent.run` stays unbound instead of fabricating a Mission.
 */
export function resolveUnambiguousSingleRepoFettlerCampaign(
  db: AppDb,
  tenantId: string,
  repositoryId: string,
): SingleRepoFettlerCampaignBinding | undefined {
  const bindings = listSingleRepoFettlerCampaignBindings(db, tenantId, repositoryId);
  return bindings.length === 1 ? bindings[0] : undefined;
}

/**
 * After Fettler graph publication: pin the published version onto every
 * campaign-linked Mission whose campaign has exactly this one repository.
 */
export function pinPublishedGraphVersionOnSingleRepoFettlerMissions(db: AppDb, input: {
  tenantId: string;
  repositoryId: string;
  graphVersionId: string;
  actorPrincipalId: string;
  correlationId: string;
  createdAt: string;
}): readonly PinMissionGraphResult[] {
  return Object.freeze(listSingleRepoFettlerCampaignBindings(db, input.tenantId, input.repositoryId).map(
    (binding) => pinKnownGraphVersionToMission(db, {
      tenantId: input.tenantId,
      missionId: binding.missionId,
      graphVersionId: input.graphVersionId,
      actorPrincipalId: input.actorPrincipalId,
      correlationId: input.correlationId,
      createdAt: input.createdAt,
    }),
  ));
}
