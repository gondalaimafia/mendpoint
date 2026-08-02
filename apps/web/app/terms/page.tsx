import type { Metadata } from "next";
import Link from "next/link";
import { PublicFooter } from "../public-footer";

export const metadata: Metadata = {
  title: "Pilot website terms",
  description: "Terms for the Mendpoint website and private design partner application path.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <div className="public-page public-document">
      <header>
        <p className="public-kicker">Terms</p>
        <h1>Pilot website terms</h1>
        <p className="public-lead">Effective 1 August 2026</p>
      </header>
      <section>
        <h2>Preview status</h2>
        <p>
          Mendpoint is a private design partner preview. Public information describes a bounded pilot
          and can change as evidence, scope, and product behavior change. Applying does not guarantee access.
        </p>
      </section>
      <section>
        <h2>Authorized use</h2>
        <p>
          Submit only information you are authorized to share. Do not use the website or pilot to
          access repositories, systems, or data without permission. Do not attempt to bypass access,
          rate, security, or review controls.
        </p>
      </section>
      <section>
        <h2>Human review</h2>
        <p>
          Migration output is a review candidate, not professional advice or an automatic merge.
          The repository team remains responsible for review, testing, approval, deployment, and rollback.
        </p>
      </section>
      <section>
        <h2>Pilot agreements</h2>
        <p>
          Commercial terms, confidentiality, support, security responsibilities, service objectives,
          and repository scope are agreed separately. A signed agreement controls if it conflicts with
          these website terms.
        </p>
        <Link href="/design-partners">Discuss pilot terms</Link>
      </section>
      <PublicFooter />
    </div>
  );
}
