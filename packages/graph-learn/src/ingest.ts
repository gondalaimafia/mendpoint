/**
 * Ingest API/code control-plane facts into graph schema v0.
 */
import { newId } from "@mendpoint/shared";
import type { ImpactableSurface, StructuralDiff } from "@mendpoint/shared";
import {
  deleteEdge,
  edgesFrom,
  listNodesByKind,
  upsertEdge,
  upsertNode,
  type GraphLearnDb,
} from "./store.js";

/**
 * Stamp tenant ownership onto a created node's props when a tenant is known, so
 * the fail-closed tenant graph view can include the node. Nodes whose ids are
 * already tenant-namespaced are owned regardless; this covers the ones (Change,
 * Surface) that are keyed on tenant-agnostic identifiers.
 */
function tenantProps(
  tenantId: string | undefined,
  props?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!tenantId) return props;
  return { ...(props ?? {}), tenant_id: tenantId };
}

export type IngestControlPlane = {
  provider: { id: string; slug: string; name: string };
  consumers: Array<{
    id: string;
    name: string;
    githubOwner: string;
    githubRepo: string;
  }>;
  monitors: Array<{ consumerId: string; providerId: string }>;
};

export function ingestControlPlane(
  db: GraphLearnDb,
  data: IngestControlPlane,
  tenantId?: string,
): void {
  upsertNode(db, {
    id: `provider:${data.provider.slug}`,
    kind: "Provider",
    label: data.provider.name,
    props: tenantProps(tenantId, { id: data.provider.id, slug: data.provider.slug }),
  });
  upsertNode(db, {
    id: `service:${data.provider.slug}`,
    kind: "Service",
    label: data.provider.name,
    props: tenantProps(tenantId, { tier: "t1" }),
  });
  for (const c of data.consumers) {
    upsertNode(db, {
      id: `consumer:${c.id}`,
      kind: "Consumer",
      label: c.name,
      props: tenantProps(tenantId, {
        identifier: `${c.githubOwner}/${c.githubRepo}`,
        github: `${c.githubOwner}/${c.githubRepo}`,
      }),
    });
  }
  for (const m of data.monitors) {
    upsertEdge(db, {
      id: `MONITORS:${m.consumerId}:${data.provider.slug}`,
      kind: "MONITORS",
      source: `consumer:${m.consumerId}`,
      target: `provider:${data.provider.slug}`,
      source_system: "pipeline",
      confidence: 1,
    });
    // Also CONSUMES placeholder for blast-radius Cypher shape
    upsertEdge(db, {
      id: `CONSUMES:${m.consumerId}:${data.provider.slug}`,
      kind: "CONSUMES",
      source: `consumer:${m.consumerId}`,
      target: `provider:${data.provider.slug}`,
      source_system: "pipeline",
      confidence: 0.8,
      props: { note: "provider-level until endpoint edges exist" },
    });
  }
}

export function ingestSpecDiff(
  db: GraphLearnDb,
  input: {
    providerSlug: string;
    changeId: string;
    diff: StructuralDiff;
    surfaces: ImpactableSurface[];
  },
  tenantId?: string,
): void {
  const pId = `provider:${input.providerSlug}`;
  upsertNode(db, {
    id: pId,
    kind: "Provider",
    label: input.providerSlug,
    props: tenantProps(tenantId),
  });
  upsertNode(db, {
    id: `change:${input.changeId}`,
    kind: "Change",
    label: input.diff.summary.slice(0, 120),
    props: tenantProps(tenantId, { risk: input.diff.risk }),
  });
  upsertEdge(db, {
    id: `VERSIONS:${input.changeId}`,
    kind: "VERSIONS",
    source: `change:${input.changeId}`,
    target: pId,
    source_system: "spec",
    confidence: 1,
  });

  for (const s of input.surfaces) {
    const sid = `surface:${s.canonicalId || s.id}`;
    upsertNode(db, {
      id: sid,
      kind: "Surface",
      label: s.canonicalId,
      props: tenantProps(tenantId, {
        severity: s.severity,
        op: s.op,
        path: s.path,
        method: s.method,
        field: s.field,
      }),
    });
    upsertEdge(db, {
      id: `RELATED:${input.changeId}:${s.id}`,
      kind: "RELATED",
      source: `change:${input.changeId}`,
      target: sid,
      source_system: "spec",
      confidence: 1,
    });
    if (s.path) {
      const method = (s.method ?? "ANY").toUpperCase();
      const eid = `endpoint:${input.providerSlug}:${method}:${s.path}`;
      upsertNode(db, {
        id: eid,
        kind: "Endpoint",
        label: `${method} ${s.path}`,
        props: tenantProps(tenantId, {
          path: s.path,
          method,
          protocol: "rest",
          operation_id: s.canonicalId,
        }),
      });
      upsertEdge(db, {
        id: `HAS_ENDPOINT:${input.providerSlug}:${s.id}`,
        kind: "HAS_ENDPOINT",
        source: pId,
        target: eid,
        source_system: "spec",
        confidence: 1,
      });
      upsertEdge(db, {
        id: `EXPOSES:${input.providerSlug}:${s.id}`,
        kind: "EXPOSES",
        source: `service:${input.providerSlug}`,
        target: eid,
        source_system: "spec",
        confidence: 0.9,
      });
      if (s.severity === "breaking") {
        upsertEdge(db, {
          id: `BREAKS:${input.changeId}:${s.id}`,
          kind: "BREAKS",
          source: `change:${input.changeId}`,
          target: eid,
          source_system: "spec",
          confidence: 1,
          props: { surface: s.canonicalId },
          label: 1,
        });
      }
    }
    if (s.field || s.fromField) {
      const fname = s.toField ?? s.field ?? s.fromField ?? "field";
      const fid = `field:${input.providerSlug}:${fname}`;
      upsertNode(db, {
        id: fid,
        kind: "Field",
        label: fname,
        props: tenantProps(tenantId, {
          name: fname,
          from_field: s.fromField,
          to_field: s.toField,
        }),
      });
      upsertEdge(db, {
        id: `HAS_FIELD:${sid}:${fname}`,
        kind: "HAS_FIELD",
        source: sid,
        target: fid,
        source_system: "spec",
        confidence: 1,
      });
    }
  }
}

export function ingestImpactFindings(
  db: GraphLearnDb,
  input: {
    changeId: string;
    consumerId: string;
    findings: Array<{ filePath: string; symbol: string; confidence: string }>;
  },
): void {
  const cId = `consumer:${input.consumerId}`;
  const chId = `change:${input.changeId}`;
  upsertNode(db, { id: cId, kind: "Consumer", label: input.consumerId });
  upsertEdge(db, {
    id: `IMPACTS:${input.changeId}:${input.consumerId}`,
    kind: "IMPACTS",
    source: chId,
    target: cId,
    source_system: "pipeline",
    confidence: 1,
    props: { findings: input.findings.length },
  });
  for (const f of input.findings.slice(0, 50)) {
    const fileId = `file:${input.consumerId}:${f.filePath}`;
    upsertNode(db, {
      id: fileId,
      kind: "File",
      label: f.filePath,
      props: { path: f.filePath, consumer_id: input.consumerId },
    });
    const conf =
      f.confidence === "high" ? 1 : f.confidence === "medium" ? 0.7 : 0.4;
    upsertEdge(db, {
      id: `IMPACTS_FILE:${input.changeId}:${f.filePath}:${f.symbol}`.slice(0, 200),
      kind: "IMPACTS",
      source: chId,
      target: fileId,
      source_system: "pipeline",
      confidence: conf,
      props: { symbol: f.symbol, confidence: f.confidence },
    });
    upsertEdge(db, {
      id: `TOUCHES:${input.changeId}:${f.filePath}`.slice(0, 200),
      kind: "TOUCHES",
      source: chId,
      target: fileId,
      source_system: "pipeline",
      confidence: conf,
    });
  }
}

export function labelPrOutcome(
  db: GraphLearnDb,
  input: {
    prId: string;
    changeId: string;
    consumerId: string;
    outcome: "merged" | "closed" | "broke" | "waived";
    title?: string;
    /** Plan-of-record attribution */
    planId?: string;
    /** A/B experiment arm */
    experiment?: "control" | "treatment" | string;
  },
  tenantId: string,
): void {
  const prNode = `pr:${input.prId}`;
  const consumerNode = `consumer:${input.consumerId}`;
  const outcomeKinds = [
    "OUTCOME_MERGED",
    "OUTCOME_CLOSED",
    "OUTCOME_BROKE",
    "OUTCOME_WAIVED",
  ] as const;
  // Reconcile legacy outcome IDs that included the mutable outcome label.
  // A PR contributes exactly one current sample, even when webhook events
  // relabel it from closed to merged.
  for (const consumer of listNodesByKind(db, "Consumer")) {
    for (const edge of edgesFrom(db, consumer.id, [...outcomeKinds])) {
      if (
        String(
          (edge.props as { pr_id?: string } | undefined)?.pr_id ?? "",
        ) === input.prId
      ) {
        deleteEdge(db, edge.id);
      }
    }
  }
  deleteEdge(db, `SUCCEEDED_ON:${input.prId}`);
  deleteEdge(db, `BROKE:${input.prId}`);
  upsertNode(db, {
    id: consumerNode,
    kind: "Consumer",
    label: input.consumerId,
    props: tenantProps(tenantId, { id: input.consumerId }),
  });
  upsertNode(db, {
    id: `change:${input.changeId}`,
    kind: "Change",
    label: input.changeId,
    props: tenantProps(tenantId, { id: input.changeId }),
  });
  upsertNode(db, {
    id: prNode,
    kind: "PullRequest",
    label: input.title ?? input.prId,
    props: tenantProps(tenantId, {
      outcome: input.outcome,
      number: input.prId,
      plan_id: input.planId,
      experiment: input.experiment,
    }),
  });
  if (input.planId) {
    upsertNode(db, {
      id: `plan:${input.planId}`,
      kind: "Plan",
      label: input.planId,
      props: tenantProps(tenantId, { plan_id: input.planId }),
    });
    upsertEdge(db, {
      id: `EXECUTED_PLAN:${input.prId}:${input.planId}`.slice(0, 240),
      kind: "EXECUTED_PLAN",
      source: prNode,
      target: `plan:${input.planId}`,
      source_system: "pr_outcome",
      confidence: 1,
      props: { change_id: input.changeId },
    });
  }
  const kindMap = {
    merged: "OUTCOME_MERGED" as const,
    closed: "OUTCOME_CLOSED" as const,
    broke: "OUTCOME_BROKE" as const,
    waived: "OUTCOME_WAIVED" as const,
  };
  const kind = kindMap[input.outcome];
  const label =
    input.outcome === "merged" || input.outcome === "waived" ? 1 : 0;
  upsertEdge(db, {
    id: `OUTCOME:${input.prId}`,
    kind,
    source: `consumer:${input.consumerId}`,
    target: `change:${input.changeId}`,
    source_system: "pr_outcome",
    confidence: 1,
    props: {
      pr_id: input.prId,
      pattern: input.title,
      plan_id: input.planId,
      experiment: input.experiment,
    },
    label,
  });
  // Schema v0 outcome family
  if (input.outcome === "merged") {
    upsertEdge(db, {
      id: `SUCCEEDED_ON:${input.prId}`,
      kind: "SUCCEEDED_ON",
      source: prNode,
      target: `change:${input.changeId}`,
      source_system: "pr_outcome",
      confidence: 1,
      props: { signal: "merged" },
      label: 1,
    });
  }
  if (input.outcome === "broke" || input.outcome === "closed") {
    upsertEdge(db, {
      id: `BROKE:${input.prId}`,
      kind: "BROKE",
      source: prNode,
      target: `change:${input.changeId}`,
      source_system: "pr_outcome",
      confidence: 1,
      props: { failure_mode: input.outcome },
      label: 0,
    });
  }
  upsertEdge(db, {
    id: `RELATED:pr:${input.prId}`,
    kind: "RELATED",
    source: prNode,
    target: `change:${input.changeId}`,
    source_system: "pr_outcome",
    confidence: 1,
  });
}

export function edgeId(...parts: string[]) {
  return parts.join(":").slice(0, 240) || newId();
}
