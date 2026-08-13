/**
 * @mendpoint/connectors — self-serve CI/CD, ticketing, and documentation
 * connector framework (S3-connectors). A typed `Connector` abstraction with
 * real|mock modes, envelope-backed credential handling, a `verifyConnection()`
 * health probe, and three connector families proven with mock + real
 * implementations.
 */
export {
  CONNECTOR_KINDS,
  CI_PROVIDERS,
  TICKETING_PROVIDERS,
  DOCS_PROVIDERS,
  ConnectorError,
  resolveConnectorMode,
  connectorModeEnvVar,
  defaultConnectorFetch,
  type ConnectorKind,
  type ConnectorMode,
  type ConnectorProvider,
  type CiProvider,
  type TicketingProvider,
  type DocsProvider,
  type ConnectionHealth,
  type Connector,
  type ConnectorFetch,
} from "./connector.js";

export {
  ConnectorCredentialVault,
  connectorCredentialVaultFromEnv,
  CONNECTOR_KEK_ENV,
  type SealedCredential,
  type ConnectorCredentialContextInput,
} from "./credentials.js";

export {
  createCiConnector,
  ciConnectorFromEnv,
  type CiConnector,
  type CiConnectorConfig,
  type BuildStatus,
  type BuildState,
  type BuildCheck,
} from "./ci.js";

export {
  createTicketingConnector,
  ticketingConnectorFromEnv,
  type TicketingConnector,
  type TicketingConnectorConfig,
  type IssueRef,
  type IssueLink,
} from "./ticketing.js";

export {
  createDocsConnector,
  docsConnectorFromEnv,
  type DocsConnector,
  type DocsConnectorConfig,
  type DocSource,
} from "./docs.js";

export {
  CONNECTOR_CATALOG,
  catalogEntry,
  explainConnectorError,
  type ConnectorCatalogEntry,
  type ConnectorCredentialField,
} from "./catalog.js";
