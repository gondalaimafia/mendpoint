"use client";

import { useRouter } from "next/navigation";
import React, { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

/**
 * Turn an API error code (or HTTP status) into an actionable sentence with the
 * fix. The guided flow must never surface a raw API error string, so anything we
 * do not recognize falls back to a plain, non-technical instruction.
 */
function connectErrorMessage(status: number, code: string | null): string {
  switch (code) {
    case "connect_owner_invalid":
    case "connect_name_invalid":
      return "Owner and repository name may only contain letters, numbers, dots, dashes, and underscores.";
    case "connect_branch_invalid":
      return "That branch name is not valid. Try the default branch, for example main.";
    case "connect_provider_invalid":
      return "That source provider is not supported yet.";
    case "github_app_credentials_missing":
    case "repository_clone_token_required":
      return "Live GitHub access is not configured yet. Ask your workspace admin to finish GitHub setup, then try again.";
    case "tenant_scope_required":
    case "unauthorized":
      return "Your session is missing a workspace. Create your workspace first, then connect a repository.";
    case "not_found":
      return "Self-serve connect is not enabled for this workspace.";
    default:
      if (code && code.startsWith("repo_")) {
        return "Could not resolve a safe checkout path for that repository. Check the owner and name and try again.";
      }
      if (status === 503) {
        return "Repository connect is temporarily unavailable. Please try again in a moment.";
      }
      return "Could not connect the repository. Check the owner and name and try again.";
  }
}

function scanErrorMessage(status: number, code: string | null): string {
  switch (code) {
    case "no monitored providers to scan":
      return "Add an API spec first so there is a provider change to scan for.";
    case "provider not monitored by tenant":
      return "That provider is not monitored by your workspace yet.";
    case "tenant_scope_required":
    case "authenticated_principal_required":
      return "Your session is missing a workspace. Create your workspace first, then run a scan.";
    case "not_found":
      return "Self-serve scan is not enabled for this workspace.";
    default:
      if (status === 409) {
        return "There is nothing to scan yet. Add an API spec, then run the first scan.";
      }
      return "Could not start the scan. Please try again.";
  }
}

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const json = (await response.json()) as { error?: unknown };
    return typeof json.error === "string" ? json.error : null;
  } catch {
    return null;
  }
}

/** Step 2 action: connect a repository through the self-serve connect flow. */
export function ConnectRepositoryAction() {
  const router = useRouter();
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("main");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/self-serve/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          owner: owner.trim(),
          name: name.trim(),
          repoKey: `${owner.trim()}/${name.trim()}`,
          ref: branch.trim() || "main",
        }),
      });
      if (!response.ok) {
        setError(connectErrorMessage(response.status, await readErrorCode(response)));
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <label>
        Repository owner
        <input
          className="input"
          value={owner}
          placeholder="acme"
          onChange={(event) => setOwner(event.target.value)}
        />
      </label>
      <label>
        Repository name
        <input
          className="input"
          value={name}
          placeholder="payments-sdk"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        Branch
        <input
          className="input"
          value={branch}
          placeholder="main"
          onChange={(event) => setBranch(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="btn primary"
        onClick={connect}
        disabled={busy || !owner.trim() || !name.trim()}
      >
        {busy ? "Connecting…" : "Connect repository"}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

type ScanResult = { jobId: string; providerSlug: string; status: string };

/** Step 4 action: trigger the first impact scan and show its live job id + status. */
export function RunScanAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/self-serve/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        setError(scanErrorMessage(response.status, await readErrorCode(response)));
        return;
      }
      setResult((await response.json()) as ScanResult);
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <button type="button" className="btn primary" onClick={run} disabled={busy}>
        {busy ? "Starting scan…" : "Run first scan"}
      </button>
      {result && (
        <p className="muted small">
          Queued scan <code>{result.jobId}</code> for <code>{result.providerSlug}</code> — status{" "}
          <span className={`badge ${result.status}`}>{result.status}</span>
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
