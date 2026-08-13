import {
  TransformerCheckpointArtifactError,
  createTransformerCheckpointArtifactStore,
  type TransformerCheckpointArtifactBackend,
  type TransformerCheckpointArtifactConfig,
  type TransformerCheckpointArtifactStore,
} from "./transformer-checkpoint-artifacts.js";
import {
  TransformerCoordinatorClientError,
  createTransformerCoordinatorClient,
  type TransformerCoordinatorClient,
  type TransformerCoordinatorClientConfig,
  type TransformerCoordinatorTransport,
} from "./transformer-coordinator-client.js";

export type TransformerCheckpointProviderErrorCode =
  | "checkpoint_provider_disabled"
  | "checkpoint_provider_mode_invalid"
  | "checkpoint_provider_config_invalid";

export class TransformerCheckpointProviderError extends Error {
  constructor(public readonly code: TransformerCheckpointProviderErrorCode) {
    super(code);
    this.name = "TransformerCheckpointProviderError";
  }
}

export type TransformerCheckpointProviderConfig = Readonly<{
  enabled: boolean;
  mode: "checkpoint_required";
  coordinator: TransformerCoordinatorClientConfig;
  artifacts: TransformerCheckpointArtifactConfig;
}>;

export type TransformerCheckpointProviderDependencies = Readonly<{
  coordinatorTransport: TransformerCoordinatorTransport;
  artifactBackend: TransformerCheckpointArtifactBackend;
}>;

export type TransformerCheckpointProvider = Readonly<{
  mode: "checkpoint_required";
  coordinator: TransformerCoordinatorClient;
  artifacts: TransformerCheckpointArtifactStore;
}>;

const CONFIG_KEYS = ["artifacts", "coordinator", "enabled", "mode"];

export function createTransformerCheckpointProvider(config: TransformerCheckpointProviderConfig, dependencies: TransformerCheckpointProviderDependencies): TransformerCheckpointProvider {
  if (!config || typeof config !== "object" || Object.keys(config).sort().join(",") !== CONFIG_KEYS.join(",")) fail("checkpoint_provider_config_invalid");
  if (config.enabled !== true) fail("checkpoint_provider_disabled");
  if (config.mode !== "checkpoint_required") fail("checkpoint_provider_mode_invalid");
  if (!dependencies || typeof dependencies !== "object") fail("checkpoint_provider_config_invalid");
  try {
    return Object.freeze({
      mode: "checkpoint_required" as const,
      coordinator: createTransformerCoordinatorClient(config.coordinator, dependencies.coordinatorTransport),
      artifacts: createTransformerCheckpointArtifactStore(config.artifacts, dependencies.artifactBackend),
    });
  } catch (error) {
    if (error instanceof TransformerCoordinatorClientError || error instanceof TransformerCheckpointArtifactError) throw error;
    fail("checkpoint_provider_config_invalid");
  }
}

function fail(code: TransformerCheckpointProviderErrorCode): never { throw new TransformerCheckpointProviderError(code); }
