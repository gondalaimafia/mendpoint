/**
 * Ingest API/code control-plane facts into the learning graph.
 */
import { newId } from "@mendpoint/shared";
import type { ImpactableSurface, StructuralDiff } from "@mendpoint/shared";
import { upsertEdge, upsertNode, type GraphLearnDb } from "./store.js";

export type IngestControlPlane = {
  provider: { id: string; slug: string; name: string };
  consumers: Array<{
    id: string;
    name: string;
    githubOwner: string;
    githubRepo: string;
  }>;
  /** consumerId → monitors provider */
  monitors: Array<{ consumerId: string; providerId: string }>;
};

export function ingestControlPlane(db: GraphLearnDb, data: IngestControlPlane): void {
  upsertNode(db, {
    id: `provider:${data.provider.slug}`,
    kind: "provider",
    label: data.provider.name,
    props: { id: data.provider.id, slug: data.provider.slug },
  });
  for (const c of data.consumers) {
    upsertNode(db, {
      id: `consumer:${c.id}`,
      kind: "consumer",
      label: c.name,
      props: { github: `${c.githubOwner}/${c.githubRepo}` },
    });
  }
  for (const m of data.monitors) {
    const provider = data.provider;
    upsertEdge(db, {
      id: `monitors:${m.consumerId}:${provider.slug}`,
      kind: "monitors",
      source: `consumer:${m.consumerId}`,
      target: `provider:${provider.slug}`,
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
): void {
  const pId = `provider:${input.providerSlug}`;
  upsertNode(db, {
    id: pId,
    kind: "provider",
    label: input.providerSlug,
  });
  upsertNode(db, {
    id: `change:${input.changeId}`,
    kind: "change",
    label: input.diff.summary.slice(0, 120),
    props: { risk: input.diff.risk },
  });
  upsertEdge(db, {
    id: `versions:${input.changeId}`,
    kind: "versions_of",
    source: `change:${input.changeId}`,
    target: pId,
  });

  for (const s of input.surfaces) {
    const sid = `surface:${s.canonicalId || s.id}`;
    upsertNode(db, {
      id: sid,
      kind: "surface",
      label: s.canonicalId,
      props: {
        severity: s.severity,
        op: s.op,
        path: s.path,
        method: s.method,
        field: s.field,
      },
    });
    upsertEdge(db, {
      id: `has_surface:${input.changeId}:${s.id}`,
      kind: "related",
      source: `change:${input.changeId}`,
      target: sid,
    });
    if (s.path) {
      const eid = `endpoint:${input.providerSlug}:${s.method ?? "ANY"}:${s.path}`;
      upsertNode(db, {
        id: eid,
        kind: "endpoint",
        label: `${(s.method ?? "").toUpperCase()} ${s.path}`,
        props: { path: s.path, method: s.method },
      });
      upsertEdge(db, {
        id: `has_endpoint:${input.providerSlug}:${s.id}`,
        kind: "has_endpoint",
        source: pId,
        target: eid,
      });
      if (s.severity === "breaking") {
        upsertEdge(db, {
          id: `breaks:${input.changeId}:${s.id}`,
          kind: "breaks",
          source: `change:${input.changeId}`,
          target: eid,
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
        kind: "field",
        label: fname,
        props: { fromField: s.fromField, toField: s.toField },
      });
      upsertEdge(db, {
        id: `has_field:${sid}:${fname}`,
        kind: "has_field",
        source: sid,
        target: fid,
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
  upsertNode(db, { id: cId, kind: "consumer", label: input.consumerId });
  upsertEdge(db, {
    id: `impacts:${input.changeId}:${input.consumerId}`,
    kind: "impacts",
    source: chId,
    target: cId,
    props: { findings: input.findings.length },
  });
  for (const f of input.findings.slice(0, 50)) {
    const fileId = `file:${input.consumerId}:${f.filePath}`;
    upsertNode(db, {
      id: fileId,
      kind: "file",
      label: f.filePath,
      props: { consumerId: input.consumerId },
    });
    upsertEdge(db, {
      id: `impacts_file:${input.changeId}:${f.filePath}:${f.symbol}`.slice(0, 200),
      kind: "impacts",
      source: chId,
      target: fileId,
      props: { symbol: f.symbol, confidence: f.confidence },
    });
  }
}

/** Label PR outcome — compounding learning signal. */
export function labelPrOutcome(
  db: GraphLearnDb,
  input: {
    prId: string;
    changeId: string;
    consumerId: string;
    outcome: "merged" | "closed" | "broke" | "waived";
    title?: string;
  },
): void {
  const prNode = `pr:${input.prId}`;
  upsertNode(db, {
    id: prNode,
    kind: "pr",
    label: input.title ?? input.prId,
    props: { outcome: input.outcome },
  });
  const kind =
    input.outcome === "merged"
      ? "outcome_merged"
      : input.outcome === "closed"
        ? "outcome_closed"
        : input.outcome === "broke"
          ? "outcome_broke"
          : "outcome_waived";
  const label =
    input.outcome === "merged" || input.outcome === "waived" ? 1 : 0;
  upsertEdge(db, {
    id: `outcome:${input.prId}:${input.outcome}`,
    kind,
    source: `consumer:${input.consumerId}`,
    target: `change:${input.changeId}`,
    props: { prId: input.prId },
    label,
  });
  upsertEdge(db, {
    id: `pr_for:${input.prId}`,
    kind: "related",
    source: prNode,
    target: `change:${input.changeId}`,
  });
}

export function edgeId(...parts: string[]) {
  return parts.join(":").slice(0, 240) || newId();
}
