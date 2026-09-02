import { fetchBoundedText } from "@mendpoint/shared";
import type { EnvelopeKeyLocator, EnvelopeKeyReference } from "./vault-envelope.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 64 * 1_024 * 1_024;

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

export type HttpsExternalKeyTransportConfig = Readonly<{
  endpoint: string;
  authorization?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}>;

function boundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function transportConfiguration(config: HttpsExternalKeyTransportConfig): Readonly<{
  endpoint: URL;
  authorization?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  fetchImpl?: typeof fetch;
}> {
  try {
    const endpoint = new URL(config.endpoint);
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const authorization = config.authorization?.trim();
    if (
      endpoint.protocol !== "https:"
      || endpoint.username.length > 0
      || endpoint.password.length > 0
      || endpoint.search.length > 0
      || endpoint.hash.length > 0
      || !boundedInteger(timeoutMs, MAX_TIMEOUT_MS)
      || !boundedInteger(maxResponseBytes, MAX_RESPONSE_BYTES)
      || (config.authorization !== undefined && (
        !authorization
        || authorization.length > 8_192
        || /[\r\n]/.test(authorization)
      ))
      || (config.fetchImpl !== undefined && typeof config.fetchImpl !== "function")
    ) {
      throw new Error("external_kek_transport_configuration_invalid");
    }
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/`;
    return Object.freeze({
      endpoint,
      ...(authorization ? { authorization } : {}),
      timeoutMs,
      maxResponseBytes,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
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

  async #post(path: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    try {
      const { response, text } = await fetchBoundedText(
        new URL(path, this.#config.endpoint),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...(this.#config.authorization ? { authorization: this.#config.authorization } : {}),
          },
          body: JSON.stringify(body),
          redirect: "error",
        },
        {
          timeoutMs: this.#config.timeoutMs,
          maxResponseBytes: this.#config.maxResponseBytes,
          ...(this.#config.fetchImpl ? { fetchImpl: this.#config.fetchImpl } : {}),
        },
      );
      if (!response.ok) throw new Error("denied");
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("application/json")) throw new Error("invalid_content_type");
      const parsed: unknown = JSON.parse(text);
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
