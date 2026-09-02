import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { EnvelopeKeyLocator, EnvelopeKeyReference } from "./vault-envelope.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 64 * 1_024 * 1_024;
const MAX_RESOLVED_ADDRESSES = 64;

const PRIVATE_IPV4 = new BlockList();
for (const [network, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  PRIVATE_IPV4.addSubnet(network, prefix, "ipv4");
}
const PRIVATE_IPV6 = new BlockList();
PRIVATE_IPV6.addSubnet("fc00::", 7, "ipv6");

const BLOCKED_IPV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_IPV4.addSubnet(network, prefix, "ipv4");
}

const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet("2000::", 3, "ipv6");
const BLOCKED_GLOBAL_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const) {
  BLOCKED_GLOBAL_IPV6.addSubnet(network, prefix, "ipv6");
}

export interface ExternalKeyTransport {
  attestKey(key: EnvelopeKeyLocator, tenantId: string): Promise<unknown>;
  wrapDataKey(
    key: EnvelopeKeyReference,
    tenantId: string,
    dataKey: Uint8Array,
  ): Promise<unknown>;
  unwrapDataKey(
    key: EnvelopeKeyReference,
    tenantId: string,
    wrappedDataKey: string,
  ): Promise<unknown>;
}

export type ExternalKeyAddressResolver = (
  hostname: string,
) => Promise<readonly string[]>;

export type ExternalKeyDestinationPolicy =
  | Readonly<{
    authority: string;
    mode: "public";
  }>
  | Readonly<{
    authority: string;
    mode: "operator-authorized-private";
    allowedAddresses: readonly string[];
  }>;

export type ExternalKeyHttpsRequest = Readonly<{
  url: URL;
  headers: Readonly<Record<string, string>>;
  body: string;
  resolvedAddresses: readonly string[];
  maxResponseBytes: number;
  signal: AbortSignal;
}>;

export type ExternalKeyHttpsResponse = Readonly<{
  statusCode: number;
  contentType: string;
  text: string;
}>;

export type ExternalKeyHttpsRequester = (
  request: ExternalKeyHttpsRequest,
) => Promise<ExternalKeyHttpsResponse>;

export type HttpsExternalKeyTransportConfig = Readonly<{
  endpoint: string;
  destination: ExternalKeyDestinationPolicy;
  authorization?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  requestImpl?: ExternalKeyHttpsRequester;
  resolveAddresses?: ExternalKeyAddressResolver;
}>;

function boundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function normalizedIpAddress(value: string): string | undefined {
  const address = value.trim();
  const family = isIP(address);
  if (family === 4) return address.split(".").map((part) => String(Number(part))).join(".");
  if (family === 6) {
    try {
      return new URL(`https://[${address}]`).hostname.slice(1, -1).toLowerCase();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function publicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_IPV4.check(address, "ipv4");
  if (family === 6) {
    return GLOBAL_IPV6.check(address, "ipv6")
      && !BLOCKED_GLOBAL_IPV6.check(address, "ipv6");
  }
  return false;
}

function privateIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_IPV4.check(address, "ipv4");
  if (family === 6) return PRIVATE_IPV6.check(address, "ipv6");
  return false;
}

const defaultAddressResolver: ExternalKeyAddressResolver = async (hostname) => {
  const literal = normalizedIpAddress(hostname);
  if (literal) return Object.freeze([literal]);
  const records = await lookup(hostname, { all: true, verbatim: true });
  return Object.freeze(records.map((record) => record.address));
};

const defaultHttpsRequester: ExternalKeyHttpsRequester = async (input) =>
  new Promise<ExternalKeyHttpsResponse>((resolve, reject) => {
    const selectedAddress = input.resolvedAddresses[0];
    const family = selectedAddress ? isIP(selectedAddress) : 0;
    if (!selectedAddress || (family !== 4 && family !== 6)) {
      reject(new Error("external_kek_destination_invalid"));
      return;
    }
    const request = httpsRequest(input.url, {
      method: "POST",
      headers: input.headers,
      signal: input.signal,
      lookup: (_hostname, _options, callback) => {
        callback(null, selectedAddress, family);
      },
      ...(isIP(input.url.hostname.replace(/^\[|\]$/g, "")) === 0
        ? { servername: input.url.hostname }
        : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > input.maxResponseBytes) {
        response.destroy(new Error("external_kek_response_too_large"));
        return;
      }
      response.on("data", (chunk: Buffer | Uint8Array | string) => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > input.maxResponseBytes) {
          response.destroy(new Error("external_kek_response_too_large"));
          return;
        }
        chunks.push(buffer);
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const contentType = response.headers["content-type"];
          resolve(Object.freeze({
            statusCode: response.statusCode ?? 0,
            contentType: Array.isArray(contentType) ? contentType.join(",") : contentType ?? "",
            text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
          }));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end(input.body);
  });

function transportConfiguration(config: HttpsExternalKeyTransportConfig): Readonly<{
  endpoint: URL;
  destination: Readonly<{
    authority: string;
    mode: ExternalKeyDestinationPolicy["mode"];
    allowedAddresses: ReadonlySet<string>;
  }>;
  authorization?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  requestImpl: ExternalKeyHttpsRequester;
  resolveAddresses: ExternalKeyAddressResolver;
}> {
  try {
    const endpoint = new URL(config.endpoint);
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const authorization = config.authorization?.trim();
    const destination = config.destination;
    if (
      endpoint.protocol !== "https:"
      || endpoint.username.length > 0
      || endpoint.password.length > 0
      || endpoint.search.length > 0
      || endpoint.hash.length > 0
      || !destination
      || typeof destination !== "object"
      || destination.authority !== endpoint.host
      || (destination.mode !== "public" && destination.mode !== "operator-authorized-private")
      || !boundedInteger(timeoutMs, MAX_TIMEOUT_MS)
      || !boundedInteger(maxResponseBytes, MAX_RESPONSE_BYTES)
      || (config.authorization !== undefined && (
        !authorization
        || authorization.length > 8_192
        || /[\r\n]/.test(authorization)
      ))
      || (config.requestImpl !== undefined && typeof config.requestImpl !== "function")
      || (config.resolveAddresses !== undefined && typeof config.resolveAddresses !== "function")
    ) {
      throw new Error("external_kek_transport_configuration_invalid");
    }
    let allowedAddresses: ReadonlySet<string> = new Set();
    if (destination.mode === "public") {
      if ("allowedAddresses" in destination) {
        throw new Error("external_kek_transport_configuration_invalid");
      }
    } else {
      if (
        !Array.isArray(destination.allowedAddresses)
        || destination.allowedAddresses.length === 0
        || destination.allowedAddresses.length > MAX_RESOLVED_ADDRESSES
      ) {
        throw new Error("external_kek_transport_configuration_invalid");
      }
      const normalized = destination.allowedAddresses.map(normalizedIpAddress);
      if (
        normalized.some((address) => !address || !privateIpAddress(address))
        || new Set(normalized).size !== normalized.length
      ) {
        throw new Error("external_kek_transport_configuration_invalid");
      }
      allowedAddresses = new Set(normalized as string[]);
    }
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/`;
    return Object.freeze({
      endpoint,
      destination: Object.freeze({
        authority: destination.authority,
        mode: destination.mode,
        allowedAddresses,
      }),
      ...(authorization ? { authorization } : {}),
      timeoutMs,
      maxResponseBytes,
      requestImpl: config.requestImpl ?? defaultHttpsRequester,
      resolveAddresses: config.resolveAddresses ?? defaultAddressResolver,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "external_kek_transport_configuration_invalid") {
      throw error;
    }
    throw new Error("external_kek_transport_configuration_invalid");
  }
}

export class HttpsExternalKeyTransport implements ExternalKeyTransport {
  readonly #config: ReturnType<typeof transportConfiguration>;

  constructor(config: HttpsExternalKeyTransportConfig) {
    this.#config = transportConfiguration(config);
  }

  async #assertDestination(): Promise<readonly string[]> {
    const hostname = this.#config.endpoint.hostname.replace(/^\[|\]$/g, "");
    const answers = await this.#config.resolveAddresses(hostname);
    if (
      !Array.isArray(answers)
      || answers.length === 0
      || answers.length > MAX_RESOLVED_ADDRESSES
    ) {
      throw new Error("external_kek_destination_invalid");
    }
    const normalized = answers.map((answer) =>
      typeof answer === "string" ? normalizedIpAddress(answer) : undefined);
    if (normalized.some((address) => !address)) {
      throw new Error("external_kek_destination_invalid");
    }
    if (this.#config.destination.mode === "public") {
      if (!(normalized as string[]).every(publicIpAddress)) {
        throw new Error("external_kek_destination_invalid");
      }
      return Object.freeze(normalized as string[]);
    }
    if (!(normalized as string[]).every((address) =>
      this.#config.destination.allowedAddresses.has(address))) {
      throw new Error("external_kek_destination_invalid");
    }
    return Object.freeze(normalized as string[]);
  }

  async #withinTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort("timeout");
        reject(new Error("external_kek_timeout"));
      }, this.#config.timeoutMs);
      timer.unref?.();
      controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      controller.abort("complete");
    }
  }

  async #post(path: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    try {
      const response = await this.#withinTimeout(async (signal) => {
        const resolvedAddresses = await this.#assertDestination();
        if (signal.aborted) throw new Error("external_kek_timeout");
        return this.#config.requestImpl({
          url: new URL(path, this.#config.endpoint),
          headers: Object.freeze({
            accept: "application/json",
            "content-type": "application/json",
            ...(this.#config.authorization ? { authorization: this.#config.authorization } : {}),
          }),
          body: JSON.stringify(body),
          resolvedAddresses,
          maxResponseBytes: this.#config.maxResponseBytes,
          signal,
        });
      });
      if (
        !response
        || typeof response !== "object"
        || !Number.isSafeInteger(response.statusCode)
        || typeof response.contentType !== "string"
        || typeof response.text !== "string"
        || Buffer.byteLength(response.text, "utf8") > this.#config.maxResponseBytes
        || response.statusCode < 200
        || response.statusCode >= 300
      ) throw new Error("denied");
      const contentType = response.contentType.toLowerCase();
      if (!contentType.includes("application/json")) throw new Error("invalid_content_type");
      const parsed: unknown = JSON.parse(response.text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("invalid_response");
      }
      return parsed;
    } catch {
      throw new Error("external_kek_request_failed");
    }
  }

  attestKey(key: EnvelopeKeyLocator, tenantId: string): Promise<unknown> {
    return this.#post("v1/keys/attest", {
      provider: key.provider,
      keyId: key.keyId,
      version: key.version,
      tenantId,
    });
  }

  wrapDataKey(
    key: EnvelopeKeyReference,
    tenantId: string,
    dataKey: Uint8Array,
  ): Promise<unknown> {
    return this.#post("v1/keys/wrap", {
      provider: key.provider,
      keyId: key.keyId,
      version: key.version,
      customerManaged: key.customerManaged,
      tenantId,
      dataKeyBase64: Buffer.from(dataKey).toString("base64"),
    });
  }

  unwrapDataKey(
    key: EnvelopeKeyReference,
    tenantId: string,
    wrappedDataKey: string,
  ): Promise<unknown> {
    return this.#post("v1/keys/unwrap", {
      provider: key.provider,
      keyId: key.keyId,
      version: key.version,
      customerManaged: key.customerManaged,
      tenantId,
      wrappedDataKey,
    });
  }
}

export function createHttpsExternalKeyTransport(
  config: HttpsExternalKeyTransportConfig,
): ExternalKeyTransport {
  return Object.freeze(new HttpsExternalKeyTransport(config));
}
