/**
 * Per-request Change Graph handle for API `/graph-learn/*` routes.
 *
 * `getGraphLearnDb()` CREATES `data/graph-learn.sqlite` when the file is
 * missing, so a stats/query call can present an empty store as tenant Change
 * Graph authority. Every production graph route must go through
 * `resolveTenantGraphHandle` instead: missing path, missing file, ephemeral
 * path, or (on read) an empty tenant view is unavailable — never invented.
 *
 * Ingest/write routes pass `allowEmpty` so the first nodes can be written into
 * an already-existing file. They still never create the file.
 */
import type { GraphLearnDb } from "@mendpoint/graph-learn";
import {
  resolveTenantGraphHandle,
  type TenantGraphHandleUnavailableReason,
} from "@mendpoint/pipeline";

export type GraphHandleFailure = Readonly<{
  error: "graph_handle_unavailable";
  reason: TenantGraphHandleUnavailableReason;
  detail: string;
}>;

export type WithGraphHandleResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: GraphHandleFailure }>;

export function withTenantGraphHandle<T>(
  input: {
    tenantId: string;
    consumerIds?: readonly string[];
    allowEmpty?: boolean;
    graphPath?: string | null;
  },
  fn: (graphDb: GraphLearnDb) => T,
): WithGraphHandleResult<T> {
  const resolved = resolveTenantGraphHandle({
    tenantId: input.tenantId,
    consumerIds: input.consumerIds,
    allowEmpty: input.allowEmpty,
    graphPath: input.graphPath,
  });
  if (resolved.status !== "ready") {
    return {
      ok: false,
      failure: {
        error: "graph_handle_unavailable",
        reason: resolved.reason,
        detail: resolved.detail,
      },
    };
  }
  try {
    return { ok: true, value: fn(resolved.graphDb) };
  } finally {
    resolved.close();
  }
}

export async function withTenantGraphHandleAsync<T>(
  input: {
    tenantId: string;
    consumerIds?: readonly string[];
    allowEmpty?: boolean;
    graphPath?: string | null;
  },
  fn: (graphDb: GraphLearnDb) => Promise<T>,
): Promise<WithGraphHandleResult<T>> {
  const resolved = resolveTenantGraphHandle({
    tenantId: input.tenantId,
    consumerIds: input.consumerIds,
    allowEmpty: input.allowEmpty,
    graphPath: input.graphPath,
  });
  if (resolved.status !== "ready") {
    return {
      ok: false,
      failure: {
        error: "graph_handle_unavailable",
        reason: resolved.reason,
        detail: resolved.detail,
      },
    };
  }
  try {
    return { ok: true, value: await fn(resolved.graphDb) };
  } finally {
    resolved.close();
  }
}
