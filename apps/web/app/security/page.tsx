import type { Metadata } from "next";
import Link from "next/link";
import { PublicFooter } from "../public-footer";

export const metadata: Metadata = {
  title: "Security boundary",
  description: "Current Mendpoint pilot controls, deployment boundary, egress, and limitations.",
  alternates: { canonical: "/security" },
};

export default function SecurityPage() {
  return (
    <div className="public-page public-document">
      <header>
        <p className="public-kicker">Security</p>
        <h1>Concrete controls and visible limitations</h1>
        <p className="public-lead">
          The pilot uses scoped credentials, authenticated tenant operations, retained evidence,
          human review, and non root containers. It is not represented as a completed compliance program.
        </p>
      </header>

      <section className="public-grid two">
        <article className="public-card">
          <h2>Current controls</h2>
          <ul>
            <li>Authenticated API and tenant scoped authorization</li>
            <li>Scoped source control credentials with expiry and revocation metadata</li>
            <li>Exact source and evidence references for governed operations</li>
            <li>Fail closed delivery gates and attributable expiring waivers</li>
            <li>Draft pull requests with human merge authority</li>
            <li>Non root production containers and public health checks</li>
          </ul>
        </article>
        <article className="public-card">
          <h2>Not yet claimed</h2>
          <ul>
            <li>SOC 2 certification or independent penetration test</li>
            <li>SAML, SCIM, customer managed keys, or production VPC reference deployment</li>
            <li>High availability or contractual enterprise service levels</li>
            <li>A guarantee that optional integrations create no network egress</li>
          </ul>
        </article>
      </section>

      <section>
        <h2>Egress boundary</h2>
        <p>
          The control plane and repository mounts can run in customer controlled infrastructure.
          Optional model endpoints and source control delivery can send bounded data to services
          selected and configured by the pilot team. Offline deterministic workflows have a narrower
          feature set and must be agreed during pilot scoping.
        </p>
      </section>

      <div className="public-actions">
        <Link className="btn primary" href="/design-partners">Discuss a scoped security review</Link>
        <a className="btn" href="https://github.com/gondalaimafia/mendpoint">Inspect the source</a>
      </div>
      <PublicFooter />
    </div>
  );
}
