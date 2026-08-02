import type { Metadata } from "next";
import claimRegistry from "../../../../docs/PUBLIC_CLAIMS.json";
import { apiCheck, workerCheck } from "../../lib/health-checks";
import { PublicFooter } from "../public-footer";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Service status",
  description: "Current public health for the Mendpoint private preview deployment.",
  alternates: { canonical: "/service-status" },
};

export default async function ServiceStatusPage() {
  const accessClaim = claimRegistry.claims.find((claim) => claim.id === "CLM-013");
  if (!accessClaim) throw new Error("Missing public claim CLM-013");
  const worker = await workerCheck();
  const [apiReady, apiAuthenticated] = await Promise.all([
    apiCheck("/ready").catch(() => false),
    apiCheck("/keys", true).catch(() => false),
  ]);
  const operational = apiReady && apiAuthenticated && worker.ok;

  return (
    <div className="public-page public-document">
      <header>
        <p className="public-kicker">Service status</p>
        <h1>{operational ? "Pilot deployment is operational" : "Pilot deployment needs attention"}</h1>
        <p className="public-lead">
          {accessClaim.wording} This page reports the API, authenticated control plane, and worker health for the private preview deployment.
        </p>
      </header>
      <section className="public-grid three" aria-label="Service checks">
        <article className="public-card">
          <span className={`state-pill ${apiReady ? "success" : "danger"}`}>{apiReady ? "Operational" : "Unavailable"}</span>
          <h2>API readiness</h2>
          <p>The API is accepting work and its required dependencies are ready.</p>
        </article>
        <article className="public-card">
          <span className={`state-pill ${apiAuthenticated ? "success" : "danger"}`}>{apiAuthenticated ? "Protected" : "Unavailable"}</span>
          <h2>Authenticated control plane</h2>
          <p>The server side product bridge can reach an authenticated API route.</p>
        </article>
        <article className="public-card">
          <span className={`state-pill ${worker.ok ? "success" : "danger"}`}>{worker.ok ? "Operational" : "Unavailable"}</span>
          <h2>Worker</h2>
          <p>Recovery processing is healthy and no expired lease or dead letter condition is reported.</p>
        </article>
      </section>
      <section>
        <h2>Feed monitoring scope</h2>
        <p>
          {worker.feedPollingEnabled
            ? "Configured feed polling is enabled for this deployment."
            : "Continuous feed polling is not enabled. The current pilot accepts submitted changes and approved configured inputs."}
        </p>
      </section>
      <PublicFooter />
    </div>
  );
}
