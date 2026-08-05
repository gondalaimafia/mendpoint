"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  githubSetupRetryDelay,
  parseGitHubSetupReturn,
  type GitHubSetupReturn,
} from "./setup-return";

type ViewState =
  | { kind: "loading" | "pending" }
  | { kind: "success"; account: string }
  | {
      kind:
        | "expired"
        | "workspace"
        | "permission"
        | "scope"
        | "not_found"
        | "timeout";
    }
  | { kind: "error"; requestId: string };

export function GitHubSetupClient() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [canCheck, setCanCheck] = useState(false);
  const setup = useRef<GitHubSetupReturn | null>(null);
  const attempt = useRef(0);
  const requestId = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const retryTimer = useRef<number | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const complete = useCallback(async () => {
    if (!setup.current || inFlight.current) return;
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    inFlight.current = true;
    requestId.current ??= crypto.randomUUID();
    setCanCheck(false);
    let response: Response;
    try {
      response = await fetch("/api/github/app/callback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": requestId.current,
        },
        body: JSON.stringify({
          state: setup.current.state,
          installationId: setup.current.installationId,
          setupAction: setup.current.setupAction,
        }),
      });
    } catch {
      if (mounted.current) {
        setView({ kind: "error", requestId: requestId.current });
      }
      inFlight.current = false;
      return;
    }
    if (!mounted.current) {
      inFlight.current = false;
      return;
    }
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      installation?: { accountLogin?: string };
    };
    if (response.ok && response.status !== 202) {
      setView({
        kind: "success",
        account: body.installation?.accountLogin ?? "GitHub",
      });
      inFlight.current = false;
      return;
    }
    if (response.status === 202) {
      setView({ kind: "pending" });
      const delay = githubSetupRetryDelay(attempt.current++);
      if (delay === null) {
        setView({ kind: "timeout" });
        setCanCheck(true);
        inFlight.current = false;
        return;
      }
      retryTimer.current = window.setTimeout(() => {
        retryTimer.current = null;
        void complete();
      }, delay);
      inFlight.current = false;
      return;
    }
    if (response.status === 401) {
      const value = setup.current;
      const next = `/github/setup?installation_id=${encodeURIComponent(value.installationId)}&setup_action=${value.setupAction}&state=${encodeURIComponent(value.state)}`;
      window.location.assign(`/access?next=${encodeURIComponent(next)}`);
      inFlight.current = false;
      return;
    }
    if (response.status === 403) setView({ kind: "workspace" });
    else if (body.error === "installation_permissions_incomplete") {
      setView({ kind: "permission" });
    } else if (body.error === "installation_repository_scope_incomplete") {
      setView({ kind: "scope" });
    } else if (response.status === 404) setView({ kind: "not_found" });
    else if (response.status === 400) setView({ kind: "expired" });
    else setView({ kind: "error", requestId: requestId.current });
    inFlight.current = false;
  }, []);

  useEffect(() => {
    mounted.current = true;
    const parsed = parseGitHubSetupReturn(window.location.search, window.history.state);
    if (!parsed) {
      setView({ kind: "expired" });
      return;
    }
    setup.current = parsed;
    window.history.replaceState(
      { ...(window.history.state ?? {}), mendpointGitHubSetup: parsed },
      "",
      window.location.pathname,
    );
    void complete();
    return () => {
      mounted.current = false;
      if (retryTimer.current !== null) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    };
  }, [complete]);

  useEffect(() => {
    heading.current?.focus();
  }, [view.kind]);

  let title = "Finishing GitHub setup";
  let message = "GitHub is still confirming the installation. This usually takes a few seconds.";
  if (view.kind === "success") {
    title = "GitHub connected";
    message = `Mendpoint verified this experimental GitHub App connection for ${view.account}. Repository access will appear in pilot readiness after checks finish.`;
  } else if (view.kind === "expired") {
    title = "This setup link expired";
    message = "The GitHub installation may still exist, but Mendpoint did not link it to this workspace. Start a new connection to create a fresh setup link.";
  } else if (view.kind === "workspace") {
    title = "Workspace owner access required";
    message = "Ask a workspace owner or administrator to connect this GitHub organization.";
  } else if (view.kind === "permission") {
    title = "Repository access is incomplete";
    message = "GitHub did not grant the repository permissions required for this pilot. Review the installation settings and try again.";
  } else if (view.kind === "scope") {
    title = "Repository access is incomplete";
    message = "The installation does not include a configured pilot repository. Add the repository in GitHub, then check again.";
  } else if (view.kind === "not_found") {
    title = "Installation could not be verified";
    message = "This installation is not assigned to the current workspace. Start a new connection from the workspace you want to use.";
  } else if (view.kind === "timeout") {
    title = "GitHub confirmation is taking longer than expected";
    message = "We have not confirmed the link yet. You can check again without repeating the GitHub installation.";
  } else if (view.kind === "error") {
    title = "We could not finish the connection";
    message = `We could not confirm whether setup finished. Try again safely. If the problem continues, share request ${view.requestId} with support.`;
  }

  return (
    <div className="page">
      <section className="card stack" style={{ maxWidth: 640, margin: "4rem auto" }}>
        <h1 ref={heading} tabIndex={-1}>{title}</h1>
        <p className="muted" aria-live="polite">{message}</p>
        {(view.kind === "timeout" || ((view.kind === "loading" || view.kind === "pending") && canCheck)) && (
          <button className="btn primary" type="button" onClick={() => void complete()}>
            Check again
          </button>
        )}
        {view.kind === "success" && (
          <div className="stack">
            <a className="btn primary" href="/install">Continue setup</a>
            <a className="btn" href="/consumer">View repositories</a>
          </div>
        )}
        {(["expired", "permission", "scope", "not_found"] as const).includes(
          view.kind as "expired",
        ) && <a className="btn primary" href="/install">Start again</a>}
        {view.kind === "workspace" && (
          <a className="btn primary" href="/access">Return to sign in</a>
        )}
        {view.kind === "error" && (
          <button className="btn primary" type="button" onClick={() => void complete()}>
            Try again
          </button>
        )}
      </section>
    </div>
  );
}
