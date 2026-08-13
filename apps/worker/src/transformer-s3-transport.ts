import { createHash, createHmac } from "node:crypto";
import type { S3CompatibleArtifactTransport } from "./transformer-shared-artifact-backends.js";

export function createSigV4S3ArtifactTransport(inputConfig: Readonly<{
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  timeoutMs: number;
}>): S3CompatibleArtifactTransport {
  let endpoint: URL;
  try { endpoint = new URL(inputConfig.endpoint); } catch { throw new Error("s3_sigv4_config_invalid"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/" || !inputConfig.region.trim() || !inputConfig.accessKeyId.trim() || !inputConfig.secretAccessKey.trim() || !Number.isSafeInteger(inputConfig.timeoutMs) || inputConfig.timeoutMs < 1) throw new Error("s3_sigv4_config_invalid");
  const config = Object.freeze({ ...inputConfig });
  const send = async (method: "GET" | "PUT", bucket: string, key: string, body: Uint8Array = new Uint8Array(), extra: Record<string, string> = {}) => {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const path = `/${awsEncode(bucket)}/${key.split("/").map(awsEncode).join("/")}`;
    const payloadHash = hex(body);
    const headers: Record<string, string> = { host: endpoint.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...extra };
    if (config.sessionToken) headers["x-amz-security-token"] = config.sessionToken;
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim()}\n`).join("");
    const signedHeaders = names.join(";");
    const canonicalRequest = `${method}\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${date}/${config.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(canonicalRequest)}`;
    const dateKey = hmac(`AWS4${config.secretAccessKey}`, date);
    const regionKey = hmac(dateKey, config.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey, stringToSign).toString("hex")}`;
    const controller = new AbortController();
    let rejectBoundary: ((error: Error) => void) | undefined;
    const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject; });
    const timeout = new Error("s3_sigv4_timeout");
    const timer = setTimeout(() => { controller.abort(timeout); rejectBoundary?.(timeout); }, config.timeoutMs);
    try { return await Promise.race([fetch(new URL(path, endpoint), { method, headers, ...(method === "PUT" ? { body: Buffer.from(body) } : {}), signal: controller.signal }), boundary]); }
    finally { clearTimeout(timer); }
  };
  return Object.freeze({
    async putObject(input) {
      const response = await send("PUT", input.bucket, input.key, input.body, { "if-none-match": input.ifNoneMatch });
      return Object.freeze({ status: response.status });
    },
    async getObject(input) {
      const response = await send("GET", input.bucket, input.key);
      const contentLength = response.headers.get("content-length");
      return Object.freeze({ status: response.status, ...(contentLength === null ? {} : { contentLength: Number(contentLength) }), body: response.body });
    },
  });
}

function hex(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function hmac(key: string | Uint8Array, value: string): Buffer { return createHmac("sha256", key).update(value).digest(); }
function awsEncode(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
