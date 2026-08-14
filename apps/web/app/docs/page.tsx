import type { Metadata } from "next";
import Link from "next/link";
import claimRegistry from "../../../../docs/PUBLIC_CLAIMS.json";
import { PublicFooter } from "../public-footer";

export const metadata: Metadata = {
  title: "Supported scope",
  description: "Current Fettler pilot inputs, repository boundary, verification, and product status.",
  alternates: { canonical: "/docs" },
};

function wording(id: string) {
  const claim = claimRegistry.claims.find((entry) => entry.id === id);
  if (!claim) throw new Error(`Missing public claim ${id}`);
  return claim.wording;
}

export default function DocumentationPage() {
  return (
    <div className="public-page public-document">
      <header>
        <p className="public-kicker">Documentation</p>
        <h1>Supported Fettler pilot scope</h1>
        <p className="public-lead">{wording("CLM-002")}</p>
      </header>

      <section>
        <h2>Inputs</h2>
        <ul className="public-list">
          <li>Submitted OpenAPI JSON and approved configured feeds</li>
          <li>Configured repository snapshots owned by the pilot team</li>
          <li>Approved verification commands discovered from repository policy</li>
        </ul>
      </section>

      <section>
        <h2>Workflow</h2>
        <ol className="public-list">
          <li>Classify a supported OpenAPI change.</li>
          <li>Build bounded static and graph backed impact candidates.</li>
          <li>Generate a proposed patch for a supported migration pattern.</li>
          <li>Run configured verification and retain evidence.</li>
          <li>Open a draft pull request for human review when delivery gates pass.</li>
        </ol>
      </section>

      <section>
        <h2>Boundaries</h2>
        <ul className="public-list">
          <li>Coverage varies by language, change class, repository size, and verification profile.</li>
          <li>Static analysis may not see runtime generated behavior.</li>
          <li>Ambiguous work reports confidence and can abstain.</li>
          <li>Fettler does not merge pull requests.</li>
          <li>Regauge is an experimental planning preview.</li>
          <li>GitLab delivery, SSO, SAML, and standard public billing remain roadmap work.</li>
        </ul>
      </section>

      <div className="public-actions">
        <Link className="btn primary" href="/design-partners">Apply with one scoped repository</Link>
        <Link className="btn" href="/security">Review security</Link>
      </div>
      <PublicFooter />
    </div>
  );
}
