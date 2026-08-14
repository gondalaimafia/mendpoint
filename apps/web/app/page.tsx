import type { Metadata } from "next";
import Link from "next/link";
import claimRegistry from "../../../docs/PUBLIC_CLAIMS.json";
import { PublicFooter } from "./public-footer";

export const metadata: Metadata = {
  title: "Mendpoint: Evidence backed API migration candidates",
  description:
    "Private design partner preview for supported GitHub repositories and submitted OpenAPI changes.",
  alternates: { canonical: "/" },
};

function claim(id: string) {
  const entry = claimRegistry.claims.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Missing public claim ${id}`);
  return entry;
}

const preview = claim("CLM-001");
const promise = claim("CLM-002");
const analysis = claim("CLM-003");
const generation = claim("CLM-004");
const verification = claim("CLM-005");
const review = claim("CLM-006");
const transformer = claim("CLM-007");
const gitlab = claim("CLM-008");
const hosting = claim("CLM-009");
const terms = claim("CLM-010");

const structuredData = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Mendpoint",
  url: "https://www.mendpoint.ai/",
  description: promise.wording,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Customer controlled pilot deployment",
  offers: {
    "@type": "Offer",
    availability: "https://schema.org/LimitedAvailability",
    description: terms.wording,
  },
};

export default function PublicHomePage() {
  return (
    <div className="public-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <section className="public-hero" aria-labelledby="public-hero-title">
        <div className="preview-pill">{preview.wording}</div>
        <p className="public-kicker">Fettler — the first AI API Engineer</p>
        <h1 id="public-hero-title">{promise.wording}</h1>
        <p className="public-lead">
          Start with a submitted API change. Review the affected code evidence, proposed patch,
          configured checks, and draft pull request before your team decides what to merge.
        </p>
        <div className="public-actions">
          <Link className="btn primary" href="/design-partners">Apply for the preview</Link>
          <Link className="btn" href="/docs">Read supported scope</Link>
        </div>
        <p className="public-note">Application does not guarantee acceptance. No card is requested.</p>
      </section>

      <section className="public-section" aria-labelledby="workflow-title">
        <div className="public-section-heading">
          <p className="public-kicker">Current Fettler workflow</p>
          <h2 id="workflow-title">Evidence before repository delivery</h2>
        </div>
        <div className="public-grid four">
          <article className="public-card"><span>01</span><h3>Analyze</h3><p>{analysis.wording}</p></article>
          <article className="public-card"><span>02</span><h3>Propose</h3><p>{generation.wording}</p></article>
          <article className="public-card"><span>03</span><h3>Verify</h3><p>{verification.wording}</p></article>
          <article className="public-card"><span>04</span><h3>Review</h3><p>{review.wording}</p></article>
        </div>
      </section>

      <section className="public-section split" aria-labelledby="scope-title">
        <div>
          <p className="public-kicker">Supported pilot scope</p>
          <h2 id="scope-title">A bounded workflow with visible limits</h2>
          <ul className="public-list">
            <li>Submitted OpenAPI JSON and configured feeds</li>
            <li>Configured GitHub pilot repositories</li>
            <li>Static, graph backed, and heuristic impact candidates</li>
            <li>Versioned supported migration patterns</li>
            <li>Configured compile, lint, test, security, and contract checks</li>
            <li>Draft pull requests for human review in GitHub</li>
          </ul>
        </div>
        <aside className="public-callout" aria-label="Known limits">
          <h3>Known limits</h3>
          <ul>
            <li>Coverage varies by change class, language, and repository profile.</li>
            <li>Static analysis may not observe runtime behavior.</li>
            <li>Unsupported or ambiguous work can abstain or require manual changes.</li>
            <li>Customer repository delivery requires approved scoped access.</li>
          </ul>
        </aside>
      </section>

      <section className="public-section" aria-labelledby="product-status-title">
        <div className="public-section-heading">
          <p className="public-kicker">Product status</p>
          <h2 id="product-status-title">What is available, previewed, and planned</h2>
        </div>
        <div className="public-grid three">
          <article className="public-card featured">
            <span className="state-pill active">Private preview</span>
            <h3>Fettler</h3>
            <p>{promise.wording}</p>
          </article>
          <article className="public-card">
            <span className="state-pill neutral">Experimental</span>
            <h3>Regauge</h3>
            <p className="public-kicker">Regauge — the first AI Legacy Engineer</p>
            <p>{transformer.wording}</p>
          </article>
          <article className="public-card">
            <span className="state-pill neutral">Roadmap</span>
            <h3>GitLab</h3>
            <p>{gitlab.wording}</p>
          </article>
        </div>
      </section>

      <section className="public-section split" aria-labelledby="deployment-title">
        <div>
          <p className="public-kicker">Deployment boundary</p>
          <h2 id="deployment-title">Customer controlled pilot infrastructure</h2>
          <p className="public-lead compact">{hosting.wording}</p>
        </div>
        <div className="public-callout">
          <h3>Egress is configurable, not absent</h3>
          <p>
            Optional model endpoints and source control delivery can send bounded data to services
            selected by the pilot team. The security page describes the current boundary.
          </p>
          <Link href="/security">Review the security boundary</Link>
        </div>
      </section>

      <section className="public-cta" aria-labelledby="cta-title">
        <p className="public-kicker">Design partner application</p>
        <h2 id="cta-title">Validate one scoped migration workflow with us</h2>
        <p>{terms.wording}</p>
        <Link className="btn primary" href="/design-partners">Apply for the preview</Link>
      </section>
      <PublicFooter />
    </div>
  );
}
