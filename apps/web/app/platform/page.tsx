import Link from "next/link";
import { apiGet } from "../../lib/api";

export const dynamic = "force-dynamic";

type Dogfood = {
  totalRuns: number;
  okRate: number;
  day90Ready: boolean;
  markdown?: string;
  meetsVolume?: boolean;
  meetsOkRate?: boolean;
};

type Slo = {
  ok: boolean;
  evaluated: number;
  violations: string[];
};

type Scm = {
  providers?: Array<{
    provider: string;
    connection: boolean;
    snapshots: boolean;
    pullRequests: boolean;
  }>;
  connections?: Array<{
    id: string;
    provider: string;
    displayName: string;
    revokedAt: string | null;
    health: null | {
      configured: boolean;
      authenticated: boolean;
      readAccess: boolean;
      writeAccess: boolean;
      webhookOk: boolean;
      ciVisible: boolean;
      errorCode: string | null;
      checkedAt: string;
    };
  }>;
  repositories?: Array<{
    id: string;
    owner: string;
    name: string;
    status: string;
    selectedBranch: string;
    snapshots: Array<{ exactCommit: string; expiresAt: string; available: boolean }>;
  }>;
};

export default async function PlatformPage() {
  let dog: Dogfood | null = null;
  let slo: Slo | null = null;
  let vm: { capabilities?: Array<{ backend: string; available: boolean }> } | null =
    null;
  let scm: Scm | null = null;
  let error: string | null = null;
  const [dogResult, sloResult, vmResult, scmResult] = await Promise.allSettled([
    apiGet<Dogfood>("/platform/dogfood"),
    apiGet<Slo>("/graph-learn/slo"),
    apiGet<{ capabilities?: Array<{ backend: string; available: boolean }> }>("/platform/vm"),
    apiGet<Scm>("/platform/scm"),
  ]);
  if (dogResult.status === "fulfilled") dog = dogResult.value;
  if (sloResult.status === "fulfilled") slo = sloResult.value;
  if (vmResult.status === "fulfilled") vm = vmResult.value;
  if (scmResult.status === "fulfilled") scm = scmResult.value;
  error = [dogResult, sloResult, vmResult, scmResult]
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason))
    .join(". ") || null;

  return (
    <div>
      <h1>Shared platform</h1>
      <p className="lead">
        Day-90 dogfood surface: VM sandbox, SLOs, dogfood gates, trajectories, HITL
        plans, multi-SCM, graph learning.
      </p>
      {error && (
        <div className="card">
          <p className="muted">API unavailable: {error}</p>
          <p className="small muted">Start with npm run dev:api</p>
        </div>
      )}
      <div className="grid">
        <div className="card">
          <h3>Dogfood</h3>
          {dog ? (
            <>
              <p style={{ fontSize: "1.5rem", margin: 0 }}>
                {dog.totalRuns} runs · {(dog.okRate * 100).toFixed(0)}% ok
              </p>
              <p className="muted small">
                day90Ready: {dog.day90Ready ? "YES" : "NO"}
              </p>
            </>
          ) : (
            <p className="muted">—</p>
          )}
          <Link href="/platform/dogfood">Open dogfood →</Link>
        </div>
        <div className="card">
          <h3>Graph SLOs</h3>
          {slo ? (
            <>
              <p style={{ fontSize: "1.5rem", margin: 0 }}>
                {slo.ok ? "PASS" : "FAIL"}
              </p>
              <p className="muted small">evaluated {slo.evaluated} ops</p>
            </>
          ) : (
            <p className="muted">—</p>
          )}
        </div>
        <div className="card">
          <h3>VM backends</h3>
          <ul className="small">
            {(vm?.capabilities ?? []).map((c) => (
              <li key={c.backend}>
                {c.backend}: {c.available ? "available" : "fallback/stub"}
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h3>Repository connections</h3>
          {(scm?.connections?.length ?? 0) > 0 ? (
            <ul className="small">
              {(scm?.connections ?? []).map((connection) => (
                <li key={connection.id}>
                  {connection.displayName}: {connection.revokedAt
                    ? "revoked"
                    : connection.health?.authenticated && connection.health.readAccess
                      ? "read access verified"
                      : "verification required"}
                  {connection.health?.errorCode ? `, ${connection.health.errorCode}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No repository connection is configured.</p>
          )}
          <p className="muted small">
            {(scm?.repositories ?? []).length} repositories, {scm?.repositories?.reduce(
              (count, repository) =>
                count + repository.snapshots.filter((snapshot) => snapshot.available).length,
              0,
            ) ?? 0} exact commit snapshots
          </p>
        </div>
      </div>
      <div className="card" style={{ marginTop: "1rem" }}>
        <h3>Surfaces</h3>
        <ul>
          <li>
            <Link href="/platform/dogfood">Dogfood report</Link>
          </li>
          <li>
            <Link href="/platform/trajectories">Trajectory viewer</Link>
          </li>
          <li>
            <Link href="/platform/plans">HITL plans</Link>
          </li>
          <li>
            <Link href="/metrics">Product metrics</Link>
          </li>
          <li>
            <Link href="/graph">Domain graph explorer</Link>
          </li>
        </ul>
      </div>
    </div>
  );
}
