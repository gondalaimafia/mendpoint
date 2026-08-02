import type { Metadata } from "next";
import claimRegistry from "../../../../docs/PUBLIC_CLAIMS.json";
import { DesignPartnerApplicationForm } from "./application-form";
import { PublicFooter } from "../public-footer";

export const metadata: Metadata = {
  title: "Design partner application",
  alternates: { canonical: "/design-partners" },
  description: "Apply to validate one scoped Warden migration workflow on an approved GitHub repository.",
};

export default function DesignPartnerPage() {
  const applicationClaim = claimRegistry.claims.find((claim) => claim.id === "CLM-012");
  if (!applicationClaim) throw new Error("Missing public claim CLM-012");
  return (
    <div className="public-page public-document">
      <header>
        <p className="public-kicker">{applicationClaim.wording}</p>
        <h1>Start with one bounded migration problem</h1>
        <p className="public-lead">
          Tell us about the provider change, approved repository scope, and outcome your team can measure.
          Do not include source code, credentials, private repository URLs, or incident payloads.
        </p>
      </header>
      <DesignPartnerApplicationForm />
      <PublicFooter />
    </div>
  );
}
