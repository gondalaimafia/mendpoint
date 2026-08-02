export {
  VENDOR_CATALOG,
  findVendorByPackage,
  listCatalog,
  type VendorEntry,
} from "./vendors.js";

export {
  detectVendors,
  catalogEntry,
  type DetectedVendor,
} from "./detect.js";

export {
  contentHash,
  resolveFeedUrl,
  fetchOpenApiDocument,
  buildOpenApiValidationEvidence,
  extractVersionLabel,
  listCatalogFeeds,
  catalogFeedForSlug,
  type FetchOpenApiResult,
  type OpenApiValidationEvidence,
  type PollableFeed,
} from "./poll.js";

export {
  pollOneFeed,
  pollAllFeeds,
  listPollableFeeds,
  type FeedPipelineContext,
  type FeedPipelineDispatchResult,
  type PollOneResult,
  type PollAllOptions,
} from "./run-poll.js";

export {
  runFeedSchedules,
  type FeedScheduleExecution,
  type FeedScheduleRunOptions,
} from "./schedule-runner.js";

export {
  probeNpmPackage,
  probeKnownSdks,
  SDK_PROVIDER_MAP,
  type SdkSignal,
} from "./sdk-signals.js";

export {
  parseChangelogEntry,
  type ChangelogParseResult,
} from "./changelog-parse.js";

export {
  ingestReleaseDocument,
  listReleaseArtifacts,
  openReleaseIngestionStore,
  recordReleaseReviewerOverride,
  type ReleaseAdapter,
  type ReleaseArtifact,
  type ReleaseDocumentInput,
  type ReleaseIngestionStore,
  type ReleaseReviewerOverride,
  type SdkReleaseChange,
  type SdkReleaseEvidence,
} from "./release-ingestion.js";
