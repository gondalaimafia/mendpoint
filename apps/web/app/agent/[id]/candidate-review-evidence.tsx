import type { CandidateReviewEvidence } from "@mendpoint/shared";
import React from "react";

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function confidence(value: number | null): string {
  return value === null ? "Not measured" : `${Math.round(value * 100)} percent`;
}

function VerificationEvidence({ evidence }: { evidence: CandidateReviewEvidence["verification"] }) {
  return (
    <div className="stack">
      <h3>Independent verification</h3>
      <p>{evidence.summary}</p>
      {evidence.commands.map((command) => (
        <div className="stack" key={`${command.command}:${command.outputSha256}`}>
          <code>{command.command}</code>
          <p className="muted small">Exit code {command.exitCode}. Output digest <code>{command.outputSha256}</code>.</p>
        </div>
      ))}
    </div>
  );
}

type ReviewEvidenceV1 = Extract<CandidateReviewEvidence, { schemaVersion: 1 }>;
type ReviewEvidenceV2 = Extract<CandidateReviewEvidence, { schemaVersion: 2 }>;

function VerifierOutputs({ digests }: { digests: string[] }) {
  return (
    <ul>
      {digests.map((digest, index) => <li key={`${digest}:${index}`}><code>{digest}</code></li>)}
    </ul>
  );
}

function PreciseEdits({ evidence }: { evidence: ReviewEvidenceV2 }) {
  return evidence.edits.map((edit) => (
    <article className="card stack" key={edit.path}>
      <div>
        <h3>{edit.path}</h3>
        <p>{edit.hypothesis}</p>
      </div>
      <dl className="stack">
        <div>
          <dt><strong>Target symbol</strong></dt>
          <dd><code>{edit.targetSymbol ?? "Not specified"}</code></dd>
        </div>
        <div>
          <dt><strong>Source evidence</strong></dt>
          <dd>
            <ul>
              {edit.sourceEvidence.map((source, index) => (
                <li key={`${source.path}:${source.digest}:${index}`}>
                  <code>{source.path}</code> <span className="muted">{source.digest}</span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div><dt><strong>Precondition</strong></dt><dd>{edit.precondition}</dd></div>
        <div><dt><strong>Expected observation</strong></dt><dd>{edit.expectedObservation}</dd></div>
        <div><dt><strong>Postcondition</strong></dt><dd>{edit.postcondition}</dd></div>
        <div><dt><strong>Rollback</strong></dt><dd>{edit.rollback}</dd></div>
        <div><dt><strong>Stop condition</strong></dt><dd>{edit.stopCondition}</dd></div>
      </dl>
      <p className="muted">
        Risk: {titleCase(edit.risk)}. Confidence: {confidence(edit.confidence)}. Assessment source: {titleCase(edit.assessmentSource)}.
      </p>
      <p>{edit.verification.summary}</p>
      <div className="muted small">Verifier outputs: <VerifierOutputs digests={edit.verification.commandOutputSha256} /></div>
    </article>
  ));
}

function LegacyEdits({ evidence }: { evidence: ReviewEvidenceV1 }) {
  return evidence.edits.map((edit) => (
    <article className="card stack" key={edit.path}>
      <h3>{edit.path}</h3>
      <p>{edit.rationale ?? "A per file rationale was not measured by this planner run."}</p>
      <p className="muted">
        Category: {edit.category === null ? "Not measured" : titleCase(edit.category)}. Risk: {edit.risk === null ? "Not measured" : titleCase(edit.risk)}. Confidence: {confidence(edit.confidence)}. Assessment source: {titleCase(edit.assessmentSource)}.
      </p>
      <p>{edit.verification.summary}</p>
      <div className="muted small">Verifier outputs: <VerifierOutputs digests={edit.verification.commandOutputSha256} /></div>
    </article>
  ));
}

export function CandidateReviewEvidencePanel({ evidence }: { evidence: CandidateReviewEvidence }) {
  return (
    <section className="card stack" aria-labelledby="candidate-review-evidence-title">
      <div>
        <h2 id="candidate-review-evidence-title">
          {evidence.schemaVersion === 2 ? "Precise review evidence" : "Review evidence"}
        </h2>
        <p>{evidence.summary}</p>
      </div>

      {evidence.schemaVersion === 2
        ? <PreciseEdits evidence={evidence} />
        : <LegacyEdits evidence={evidence} />}

      <VerificationEvidence evidence={evidence.verification} />
    </section>
  );
}
