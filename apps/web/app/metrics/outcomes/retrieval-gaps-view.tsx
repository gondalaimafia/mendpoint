import React from "react";

export type RetrievalContextGapBucket = { key: string; gaps: number };

export type RetrievalContextGapRecord = {
  id: string;
  tenantId: string;
  learningRecordId: string;
  eventId: string;
  eventDigest: string;
  product: "fettler" | "regauge";
  capability: string;
  taskType: string;
  migrationFamily: string;
  repositoryId: string;
  observedAt: string;
  createdAt: string;
};

export type RetrievalContextGaps = {
  tenantId: string;
  window: { since: string | null; until: string | null };
  totalGaps: number;
  byCapability: RetrievalContextGapBucket[];
  byMigrationFamily: RetrievalContextGapBucket[];
  byProduct: RetrievalContextGapBucket[];
  recent: RetrievalContextGapRecord[];
  computedAt: string;
};

function Buckets({ title, buckets }: { title: string; buckets: RetrievalContextGapBucket[] }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      {buckets.length === 0 ? (
        <p className="muted small">no gaps recorded yet</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{title.replace("By ", "")}</th>
              <th>Gaps</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.key}>
                <td>{b.key}</td>
                <td>{b.gaps}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function RetrievalContextGapsView({ g }: { g: RetrievalContextGaps }) {
  return (
    <>
      <h2>Retrieval context gaps</h2>
      <p className="muted small">
        How often a run&rsquo;s required context was <strong>confirmed absent</strong> (objective
        verification failed and the trajectory recorded the context as missing), and for what.
        Every count is a proven gap, never an unknown: the retrieval attribution is derived only
        from a confirmed-absent trajectory, so &ldquo;we did not act&rdquo; is never shown as
        &ldquo;there was nothing to act on&rdquo;.
      </p>
      <div className="grid">
        <div className="card">
          <h3>Total confirmed gaps</h3>
          <p style={{ fontSize: "1.75rem", margin: 0 }}>{g.totalGaps}</p>
          <p className="muted small">required context confirmed absent in window</p>
        </div>
        <Buckets title="By capability" buckets={g.byCapability} />
        <Buckets title="By migration family" buckets={g.byMigrationFamily} />
        <Buckets title="By product" buckets={g.byProduct} />
      </div>

      {g.recent.length > 0 && (
        <>
          <h3>Most recent gaps</h3>
          <table>
            <thead>
              <tr>
                <th>Observed</th>
                <th>Product</th>
                <th>Capability</th>
                <th>Migration family</th>
                <th>Repository</th>
              </tr>
            </thead>
            <tbody>
              {g.recent.map((r) => (
                <tr key={r.id}>
                  <td>{r.observedAt}</td>
                  <td>{r.product}</td>
                  <td>{r.capability}</td>
                  <td>{r.migrationFamily}</td>
                  <td>{r.repositoryId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="muted small">Computed {g.computedAt}</p>
    </>
  );
}
