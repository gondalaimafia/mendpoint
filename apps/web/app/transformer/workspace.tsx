"use client";

import { useEffect, useMemo, useState } from "react";
import {
  campaignAction,
  deriveTransformerWorkspace,
  type CampaignState,
  type TransformerCampaignView,
  type TransformerEventView,
} from "./workspace-model";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

type Notice = { tone: "error" | "success" | "neutral"; text: string };
type TransformerGateView = Readonly<{
  allowed: boolean;
  schemaVersion: string;
  tenantId: string;
  environment: string;
  boundary: "ui";
  reasons: readonly string[];
  acceptanceEvidenceRefs: readonly string[];
}>;

function cleanLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function evidenceLines(value: string): string[] {
  const values = value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
  return values.length ? values : ["operator:objective-intake"];
}

function mutationHeaders(action: string, evidence: readonly string[]): HeadersInit {
  return {
    "Content-Type": "application/json",
    "Idempotency-Key": `${action}:${crypto.randomUUID()}`,
    "X-Mendpoint-Evidence-Refs": evidence.join(","),
  };
}

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(data.message ?? data.error ?? response.statusText);
  return data;
}

function stateLabel(state: string): string {
  return state.replaceAll("_", " ");
}

function metric(value: number | null, suffix = ""): string {
  return value === null ? "Not measured" : `${value}${suffix}`;
}

export function TransformerWorkspace() {
  const [campaignId, setCampaignId] = useState("");
  const [name, setName] = useState("Runtime modernization");
  const [objective, setObjective] = useState("Move supported services to the target runtime with behavioral parity");
  const [sourceSystem] = useState("Node 18");
  const [targetSystem] = useState("Node 20");
  const [ownerId, setOwnerId] = useState("migration-owner");
  const [reviewerId, setReviewerId] = useState("migration-reviewer");
  const [changes, setChanges] = useState("Inventory runtime declarations\nUpgrade application runtime\nVerify behavioral parity");
  const [evidence, setEvidence] = useState("operator:objective-intake\nspec:runtime-policy");
  const [verificationCommand, setVerificationCommand] = useState("npm test");
  const [rollbackCommand, setRollbackCommand] = useState("npm test");
  const [view, setView] = useState<TransformerCampaignView | null>(null);
  const [events, setEvents] = useState<TransformerEventView[]>([]);
  const [exceptionCode, setExceptionCode] = useState("verification_failed");
  const [exceptionMessage, setExceptionMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [gate, setGate] = useState<TransformerGateView | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${API_URL}/transformer/gate`, { cache: "no-store", signal: controller.signal })
      .then((response) => responseJson<{ gate: TransformerGateView }>(response))
      .then((body) => setGate(body.gate))
      .catch((error) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setGate({
          allowed: false,
          schemaVersion: "unavailable",
          tenantId: "unknown",
          environment: "unknown",
          boundary: "ui",
          reasons: ["gate_status_unavailable"],
          acceptanceEvidenceRefs: [],
        });
      });
    return () => controller.abort();
  }, []);

  const gateAllowed = gate?.allowed === true;

  const workspace = useMemo(
    () => view ? deriveTransformerWorkspace(view, events) : null,
    [view, events],
  );

  async function load(id = campaignId): Promise<void> {
    const normalized = id.trim();
    if (!normalized) {
      setNotice({ tone: "error", text: "Enter a campaign ID" });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const [campaignResponse, eventResponse] = await Promise.all([
        fetch(`${API_URL}/transformer/control-plane/campaigns/${encodeURIComponent(normalized)}`),
        fetch(`${API_URL}/transformer/control-plane/campaigns/${encodeURIComponent(normalized)}/events`),
      ]);
      const [nextView, eventBody] = await Promise.all([
        responseJson<TransformerCampaignView>(campaignResponse),
        responseJson<{ events: TransformerEventView[] }>(eventResponse),
      ]);
      setCampaignId(normalized);
      setView(nextView);
      setEvents(eventBody.events);
      setConfirmRollback(false);
      setNotice({ tone: "success", text: "Campaign evidence refreshed" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function createCampaign(): Promise<void> {
    const semanticChanges = cleanLines(changes);
    const evidenceRefs = evidenceLines(evidence);
    if (!name.trim() || !objective.trim() || !sourceSystem.trim() || !targetSystem.trim()) {
      setNotice({ tone: "error", text: "Name, objective, source, and target are required" });
      return;
    }
    if (!ownerId.trim() || !reviewerId.trim() || !verificationCommand.trim() || !rollbackCommand.trim()) {
      setNotice({ tone: "error", text: "Ownership, review, verification, and rollback fields are required" });
      return;
    }
    if (semanticChanges.length === 0) {
      setNotice({ tone: "error", text: "Add at least one semantic change" });
      return;
    }

    const id = `campaign-${crypto.randomUUID()}`;
    const nodes = semanticChanges.map((spec, index) => ({
      id: `change-${index + 1}`,
      kind: index === 0 ? "inventory" : index === semanticChanges.length - 1 ? "verification" : "semantic_change",
      spec,
      sourceRefs: evidenceRefs,
    }));
    const edges = nodes.slice(1).map((node, index) => ({
      id: `dependency-${index + 1}`,
      from: nodes[index]!.id,
      to: node.id,
      kind: "depends_on",
    }));
    const payload = {
      campaign: { id, name: name.trim(), sourceSystem: sourceSystem.trim(), targetSystem: targetSystem.trim() },
      blueprint: {
        id: `blueprint-${id}`,
        objective: objective.trim(),
        content: { semanticChanges, outcomeMetrics: "recorded from campaign evidence" },
        policy: {
          ownerIds: [ownerId.trim()],
          risks: [],
          unknowns: [],
          verification: { commands: [verificationCommand.trim()] },
          rollback: { strategy: "inverse_operations", verificationCommands: [rollbackCommand.trim()] },
          approval: { required: true, reviewerIds: [reviewerId.trim()] },
        },
      },
      bsg: { id: `bsg-${id}`, nodes, edges },
    };

    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`${API_URL}/transformer/control-plane/campaigns`, {
        method: "POST",
        headers: mutationHeaders(`create:${id}`, evidenceRefs),
        body: JSON.stringify(payload),
      });
      const created = await responseJson<TransformerCampaignView>(response);
      setCampaignId(id);
      setView(created);
      setEvents([]);
      await load(id);
      setNotice({ tone: "success", text: "Draft campaign created for human review" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      setBusy(false);
    }
  }

  async function reviewBlueprint(): Promise<void> {
    if (!view) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(
        `${API_URL}/transformer/control-plane/campaigns/${encodeURIComponent(view.campaign.id)}/review`,
        {
          method: "POST",
          headers: mutationHeaders(`review:${view.campaign.id}`, ["operator:blueprint-approval"]),
          body: JSON.stringify({
            expectedCampaignRevision: view.campaign.revision,
            expectedBlueprintRevision: view.blueprint.revision,
            expectedBsgRevision: view.bsg.revision,
          }),
        },
      );
      setView(await responseJson<TransformerCampaignView>(response));
      await load(view.campaign.id);
      setNotice({ tone: "success", text: "Blueprint approved and campaign ready" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      setBusy(false);
    }
  }

  async function transition(nextState: CampaignState, action: string): Promise<void> {
    if (!view) return;
    setBusy(true);
    setNotice(null);
    try {
      const evidenceRef = action === "rollback" ? "operator:rollback-request" : `operator:${action}`;
      const response = await fetch(
        `${API_URL}/transformer/control-plane/campaigns/${encodeURIComponent(view.campaign.id)}/transitions`,
        {
          method: "POST",
          headers: mutationHeaders(`${action}:${view.campaign.id}`, [evidenceRef]),
          body: JSON.stringify({ state: nextState, expectedRevision: view.campaign.revision }),
        },
      );
      setView(await responseJson<TransformerCampaignView>(response));
      await load(view.campaign.id);
      setNotice({
        tone: "success",
        text: action === "rollback"
          ? "Campaign cancelled and rollback request recorded for operator execution"
          : `Campaign moved to ${stateLabel(nextState)}`,
      });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      setBusy(false);
    }
  }

  async function recordException(): Promise<void> {
    if (!view || !exceptionMessage.trim()) {
      setNotice({ tone: "error", text: "Describe the exception before recording it" });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(
        `${API_URL}/transformer/control-plane/campaigns/${encodeURIComponent(view.campaign.id)}/exceptions`,
        {
          method: "POST",
          headers: mutationHeaders(`exception:${view.campaign.id}`, ["operator:exception-evidence"]),
          body: JSON.stringify({
            id: `exception-${crypto.randomUUID()}`,
            code: exceptionCode.trim(),
            message: exceptionMessage.trim(),
          }),
        },
      );
      await responseJson(response);
      setExceptionMessage("");
      await load(view.campaign.id);
      setNotice({ tone: "success", text: "Exception recorded in the campaign evidence log" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      setBusy(false);
    }
  }

  const pause = view ? campaignAction(view.campaign.state, "pause") : null;
  const retry = view ? campaignAction(view.campaign.state, "retry") : null;
  const rollback = view ? campaignAction(view.campaign.state, "rollback") : null;

  return (
    <div className="workspace-page transformer-workspace">
      <header className="command-header">
        <div>
          <p className="eyebrow">Transformer experimental</p>
          <h1>Plan and govern a migration campaign</h1>
          <p className="lead">
            Turn an objective into a reviewable dependency plan, track evidence and outcomes, and keep every execution decision with an operator.
          </p>
        </div>
        <div className="transformer-guardrail" role="note">
          <strong>Human delivery only</strong>
          <span>No automatic merge or deployment</span>
        </div>
      </header>

      <section className="surface transformer-load" aria-labelledby="transformer-gate-title" aria-live="polite">
        <div>
          <p className="eyebrow">Experimental access gate</p>
          <h2 id="transformer-gate-title">
            {gate === null ? "Checking tenant access" : gateAllowed ? "Available for this pilot" : "Unavailable for this tenant"}
          </h2>
        </div>
        <span className={`state-pill ${gateAllowed ? "active" : ""}`}>
          {gate === null ? "Checking" : gateAllowed ? "Allowed" : "Default deny"}
        </span>
        {gate && (
          <span className="muted small">
            Environment: {gate.environment}. Contract: {gate.schemaVersion}. Acceptance evidence: {gate.acceptanceEvidenceRefs.length}.
          </span>
        )}
      </section>

      {notice && (
        <p className={`transformer-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
        </p>
      )}

      <section className="surface transformer-load" aria-labelledby="campaign-access-title">
        <div>
          <p className="eyebrow">Tenant scoped access</p>
          <h2 id="campaign-access-title">Open an existing campaign</h2>
        </div>
        <label>
          <span className="sr-only">Campaign ID</span>
          <input className="input" value={campaignId} onChange={(event) => setCampaignId(event.target.value)} placeholder="Campaign ID" />
        </label>
        <button className="btn" type="button" disabled={busy || !gateAllowed || !campaignId.trim()} onClick={() => void load()}>
          {busy ? "Working" : "Open campaign"}
        </button>
      </section>

      <div className="transformer-layout">
        <section className="surface" aria-labelledby="objective-title">
          <div className="section-head">
            <div><p className="eyebrow">Objective intake</p><h2 id="objective-title">Create a reviewable draft</h2></div>
            <span className="state-pill active">Experimental</span>
          </div>
          <div className="transformer-form">
            <label>Campaign name<input className="input" value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>Objective<textarea className="input" rows={3} value={objective} onChange={(event) => setObjective(event.target.value)} /></label>
            <div className="transformer-two-column">
              <label>Source system, supported recipe<input className="input" value={sourceSystem} readOnly /></label>
              <label>Target system, supported recipe<input className="input" value={targetSystem} readOnly /></label>
              <label>Owner ID<input className="input" value={ownerId} onChange={(event) => setOwnerId(event.target.value)} /></label>
              <label>Reviewer ID<input className="input" value={reviewerId} onChange={(event) => setReviewerId(event.target.value)} /></label>
            </div>
            <label>Semantic changes, one per line<textarea className="input" rows={4} value={changes} onChange={(event) => setChanges(event.target.value)} /></label>
            <label>Evidence references<textarea className="input" rows={2} value={evidence} onChange={(event) => setEvidence(event.target.value)} /></label>
            <div className="transformer-two-column">
              <label>Verification command<input className="input" value={verificationCommand} onChange={(event) => setVerificationCommand(event.target.value)} /></label>
              <label>Rollback verification<input className="input" value={rollbackCommand} onChange={(event) => setRollbackCommand(event.target.value)} /></label>
            </div>
            <button className="btn primary" type="button" disabled={busy || !gateAllowed} onClick={() => void createCampaign()}>
              {busy ? "Creating draft" : "Create draft campaign"}
            </button>
          </div>
        </section>

        <section className="surface" aria-labelledby="blueprint-title">
          <div className="section-head">
            <div><p className="eyebrow">Blueprint review</p><h2 id="blueprint-title">Approval and controls</h2></div>
            {view && <span className={`state-pill ${view.campaign.state === "running" ? "active" : ""}`}>{stateLabel(view.campaign.state)}</span>}
          </div>
          {!view ? (
            <div className="empty-state compact"><p>Create or open a campaign to review its blueprint.</p></div>
          ) : (
            <div className="stack">
              <dl className="kv">
                <dt>Objective</dt><dd>{view.blueprint.objective}</dd>
                <dt>Source</dt><dd>{view.campaign.sourceSystem}</dd>
                <dt>Target</dt><dd>{view.campaign.targetSystem}</dd>
                <dt>Owners</dt><dd>{view.blueprint.policy.ownerIds.join(", ")}</dd>
                <dt>Reviewers</dt><dd>{view.blueprint.policy.approval.reviewerIds.join(", ")}</dd>
                <dt>Verification</dt><dd><code>{view.blueprint.policy.verification.commands.join(", ")}</code></dd>
                <dt>Rollback</dt><dd><code>{view.blueprint.policy.rollback.verificationCommands.join(", ")}</code></dd>
              </dl>
              <div className="btn-row" aria-label="Campaign controls">
                {view.campaign.state === "draft" && <button className="btn primary" type="button" disabled={busy || !gateAllowed} onClick={() => void reviewBlueprint()}>Approve blueprint</button>}
                {view.campaign.state === "ready" && <button className="btn primary" type="button" disabled={busy || !gateAllowed} onClick={() => void transition("running", "start")}>Mark campaign running</button>}
                <button className="btn" type="button" disabled={busy || !gateAllowed || !pause?.allowed} onClick={() => void transition("paused", "pause")}>Pause</button>
                <button className="btn" type="button" disabled={busy || !gateAllowed || !retry?.allowed} onClick={() => void transition("running", "retry")}>Retry</button>
                <button className="btn danger-button" type="button" disabled={busy || !gateAllowed || !rollback?.allowed} onClick={() => setConfirmRollback(true)}>Request rollback</button>
              </div>
              {confirmRollback && rollback?.nextState && (
                <div className="confirmation-panel" role="alert" aria-labelledby="rollback-confirm-title">
                  <strong id="rollback-confirm-title">Confirm rollback request</strong>
                  <p>This cancels the campaign and records the request. An operator must execute and verify the rollback.</p>
                  <div className="btn-row">
                    <button className="btn danger-button" type="button" disabled={busy || !gateAllowed} onClick={() => void transition(rollback.nextState!, "rollback")}>Confirm request</button>
                    <button className="btn" type="button" disabled={busy} onClick={() => setConfirmRollback(false)}>Keep campaign</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {view && workspace && (
        <>
          <section aria-labelledby="outcomes-title">
            <div className="section-head">
              <div><p className="eyebrow">Outcome metrics</p><h2 id="outcomes-title">Campaign evidence at a glance</h2></div>
              <button className="btn" type="button" disabled={busy || !gateAllowed} onClick={() => void load(view.campaign.id)}>Refresh evidence</button>
            </div>
            <div className="transformer-metrics">
              <article><span>Campaign completion</span><strong>{metric(workspace.metrics.campaignCompletionPercent, "%")}</strong></article>
              <article><span>Wave completion</span><strong>{metric(workspace.metrics.waveCompletionPercent, "%")}</strong></article>
              <article><span>Acceptance</span><strong>{metric(workspace.metrics.acceptancePercent, "%")}</strong></article>
              <article><span>Time to first accepted PR</span><strong>{metric(workspace.metrics.timeToFirstAcceptedPrMinutes, " min")}</strong></article>
              <article><span>Open exceptions</span><strong>{workspace.metrics.openExceptions}</strong></article>
              <article><span>Verification</span><strong>{metric(workspace.metrics.verificationPercent, "%")}</strong></article>
              <article><span>Rollback requests</span><strong>{workspace.metrics.rollbackRequests}</strong></article>
              <article><span>Legacy reduction</span><strong>{metric(workspace.metrics.legacyReductionPercent, "%")}</strong></article>
              <article><span>Reviewer delta</span><strong>{metric(workspace.metrics.reviewerMinutesDelta, " min")}</strong></article>
              <article><span>Cost</span><strong>{workspace.metrics.costUsd === null ? "Not measured" : `$${workspace.metrics.costUsd.toFixed(2)}`}</strong></article>
            </div>
          </section>

          <div className="transformer-layout">
            <section className="surface" aria-labelledby="dependency-title">
              <div className="section-head"><div><p className="eyebrow">Dependency graph</p><h2 id="dependency-title">Semantic changes and waves</h2></div><span className="muted small">{workspace.progress.completedNodes} of {workspace.progress.totalNodes} complete</span></div>
              <div className="transformer-waves">
                {workspace.waves.map((wave) => (
                  <article key={wave.index}>
                    <header><strong>Wave {wave.index}</strong><span>{wave.nodeIds.every((id) => workspace.nodeStates.get(id) === "completed") ? "complete" : "planned"}</span></header>
                    {wave.nodeIds.map((nodeId) => {
                      const node = view.bsg.nodes.find((candidate) => candidate.id === nodeId)!;
                      return <div className="transformer-change" key={nodeId}><div><strong>{node.spec}</strong><span>{node.kind.replaceAll("_", " ")}</span></div><span className="state-pill">{workspace.nodeStates.get(nodeId)}</span><small>Evidence: {node.sourceRefs.join(", ")}</small></div>;
                    })}
                  </article>
                ))}
              </div>
            </section>

            <section className="surface" aria-labelledby="exceptions-title">
              <div className="section-head"><div><p className="eyebrow">Exceptions</p><h2 id="exceptions-title">Record a migration exception</h2></div><span className="state-pill">{workspace.metrics.openExceptions} open</span></div>
              <div className="transformer-form">
                <label>Exception code<input className="input" value={exceptionCode} onChange={(event) => setExceptionCode(event.target.value)} /></label>
                <label>Evidence and impact<textarea className="input" rows={3} value={exceptionMessage} onChange={(event) => setExceptionMessage(event.target.value)} /></label>
                <button className="btn" type="button" disabled={busy || !gateAllowed || !exceptionMessage.trim()} onClick={() => void recordException()}>Record exception</button>
              </div>
              <ol className="transformer-event-list">
                {events.slice().reverse().slice(0, 8).map((event) => (
                  <li key={event.id}><span>{event.type.replaceAll(".", " ")}</span><strong>{event.entityId}</strong><small>{new Date(event.createdAt).toLocaleString()}</small></li>
                ))}
              </ol>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
