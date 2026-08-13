/**
 * Connector catalog + actionable diagnostics.
 *
 * The catalog drives the guided-setup UI: which families exist, which providers
 * each supports, and what a tenant must supply to connect in real mode. The repo
 * has no `explainError` helper (the S3-diagnostics naming from the brief), so
 * this module provides the equivalent: `explainConnectorError(code)` turns a
 * connector error code into a short, actionable remediation message for the
 * Connections surface.
 */
import {
  CI_PROVIDERS,
  DOCS_PROVIDERS,
  TICKETING_PROVIDERS,
  type ConnectorKind,
  type ConnectorProvider,
} from "./connector.js";

export type ConnectorCredentialField = Readonly<{
  key: string;
  label: string;
  /** True when real mode cannot connect without it. */
  required: boolean;
  secret: boolean;
}>;

export type ConnectorCatalogEntry = Readonly<{
  kind: ConnectorKind;
  provider: ConnectorProvider;
  label: string;
  /** Fields the guided setup collects for real mode. */
  fields: readonly ConnectorCredentialField[];
}>;

const TOKEN_FIELD = Object.freeze({ key: "token", label: "API token", required: true, secret: true });

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = Object.freeze([
  ...CI_PROVIDERS.map((provider) =>
    Object.freeze({
      kind: "ci" as const,
      provider,
      label: provider === "github_actions" ? "GitHub Actions" : "GitLab CI",
      fields: Object.freeze([TOKEN_FIELD]),
    }),
  ),
  ...TICKETING_PROVIDERS.map((provider) =>
    Object.freeze({
      kind: "ticketing" as const,
      provider,
      label: provider === "jira" ? "Jira" : "Linear",
      fields:
        provider === "jira"
          ? Object.freeze([
              Object.freeze({ key: "email", label: "Account email", required: true, secret: false }),
              TOKEN_FIELD,
              Object.freeze({ key: "apiBaseUrl", label: "Site URL", required: true, secret: false }),
              Object.freeze({ key: "project", label: "Project key", required: false, secret: false }),
            ])
          : Object.freeze([
              TOKEN_FIELD,
              Object.freeze({ key: "project", label: "Team id", required: false, secret: false }),
            ]),
    }),
  ),
  ...DOCS_PROVIDERS.map((provider) =>
    Object.freeze({
      kind: "docs" as const,
      provider,
      label: provider === "confluence" ? "Confluence" : provider === "notion" ? "Notion" : "Repo markdown",
      fields:
        provider === "markdown_repo"
          ? Object.freeze([
              Object.freeze({ key: "ref", label: "Markdown directory", required: false, secret: false }),
            ])
          : provider === "confluence"
            ? Object.freeze([
                Object.freeze({ key: "email", label: "Account email", required: true, secret: false }),
                TOKEN_FIELD,
                Object.freeze({ key: "ref", label: "Space key", required: true, secret: false }),
              ])
            : Object.freeze([
                TOKEN_FIELD,
                Object.freeze({ key: "ref", label: "Page or database id", required: true, secret: false }),
              ]),
    }),
  ),
]);

export function catalogEntry(
  kind: ConnectorKind,
  provider: ConnectorProvider,
): ConnectorCatalogEntry | undefined {
  return CONNECTOR_CATALOG.find((entry) => entry.kind === kind && entry.provider === provider);
}

/**
 * Actionable message for a connector error code (S3-diagnostics style). Falls
 * back to a generic hint so an unknown code is still surfaced, never swallowed.
 */
export function explainConnectorError(code: string): string {
  if (code.endsWith("_credential_required")) {
    return "Add the required credential for this connector, then verify. Real mode cannot connect without it.";
  }
  if (code === "connector_unverified") {
    return "Verify the connection before using it. The connector stays unavailable until a health check passes.";
  }
  if (code.includes("_probe_http_401") || code.includes("_probe_http_403")) {
    return "The credential was rejected. Check the token has the right scope and has not expired, then verify again.";
  }
  if (code.includes("_probe_http_")) {
    return "The provider could not be reached or returned an error. Confirm the API URL and try verifying again.";
  }
  if (code === "markdown_repo_empty") {
    return "No markdown docs were found at that path. Point the source at a directory containing knowledge markdown.";
  }
  if (code === "tenant_mismatch") {
    return "This connector belongs to a different workspace and cannot be used here.";
  }
  if (code.endsWith("_source_ref_required")) {
    return "Provide the documentation source reference (space key or page id) before connecting.";
  }
  if (code.endsWith("_project_required") || code.endsWith("_team_required")) {
    return "Set a default project or team so issues can be created.";
  }
  return "The connector could not complete this action. Review the details and try verifying the connection again.";
}
