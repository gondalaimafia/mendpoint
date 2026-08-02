import type { Metadata } from "next";
import Link from "next/link";
import claimRegistry from "../../../../docs/PUBLIC_CLAIMS.json";
import { PublicFooter } from "../public-footer";

export const metadata: Metadata = {
  title: "Privacy notice",
  description: "How Mendpoint handles public design partner application data during the private preview.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  const privacyClaim = claimRegistry.claims.find((claim) => claim.id === "CLM-014");
  if (!privacyClaim) throw new Error("Missing public claim CLM-014");
  return (
    <div className="public-page public-document">
      <header>
        <p className="public-kicker">Privacy</p>
        <h1>Private preview application data</h1>
        <p className="public-lead">Effective 1 August 2026</p>
      </header>
      <section>
        <h2>Data collected</h2>
        <p>
          The design partner form collects the contact and company details, repository scope,
          migration problem, and success criteria that you choose to submit. It also records request
          metadata needed for abuse prevention and operational follow up.
        </p>
      </section>
      <section>
        <h2>Purpose and retention</h2>
        <p>{privacyClaim.wording}</p>
        <p>
          Application data is used to evaluate pilot fit, respond to the request, protect the form,
          and operate the design partner pipeline. It is not sold. Private application details are
          available for at most 90 days. After expiry, access is blocked and an operator retention
          purge destroys the wrapped record key. An authorized owner can erase those details earlier.
          Redacted consent, retention, access, and erasure metadata remains as an operating security record.
        </p>
      </section>
      <section>
        <h2>Repository data</h2>
        <p>
          Do not submit source code, credentials, private repository URLs, incident payloads, or
          regulated personal data through the public form. Repository access is handled separately
          under an approved pilot scope and credential boundary.
        </p>
      </section>
      <section>
        <h2>Your request</h2>
        <p>
          Use the design partner contact path to ask for access, correction, or deletion of an
          application record. A signed pilot agreement can replace this notice for pilot operations.
        </p>
        <Link href="/design-partners">Open the contact path</Link>
      </section>
      <PublicFooter />
    </div>
  );
}
