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
  extractVersionLabel,
  listCatalogFeeds,
  catalogFeedForSlug,
  type FetchOpenApiResult,
  type PollableFeed,
} from "./poll.js";

export {
  pollOneFeed,
  pollAllFeeds,
  type PollOneResult,
  type PollAllOptions,
} from "./run-poll.js";

export {
  probeNpmPackage,
  probeKnownSdks,
  SDK_PROVIDER_MAP,
  type SdkSignal,
} from "./sdk-signals.js";
