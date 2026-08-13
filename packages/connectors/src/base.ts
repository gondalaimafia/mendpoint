/**
 * Shared connector base: readiness bookkeeping + fail-closed guard.
 *
 * Every concrete connector extends this so the "unverified ⇒ unavailable"
 * invariant is implemented in exactly one place. `verifyConnection()` runs the
 * subclass probe; on success it flips `ready` true so capability methods (guarded
 * by `assertReady`) become available. Any capability call before a successful
 * verify throws `connector_unverified`.
 */
import { nowIso } from "@mendpoint/shared";
import {
  ConnectorError,
  type ConnectionHealth,
  type Connector,
  type ConnectorKind,
  type ConnectorMode,
  type ConnectorProvider,
} from "./connector.js";

export abstract class BaseConnector implements Connector {
  abstract readonly kind: ConnectorKind;
  abstract readonly provider: ConnectorProvider;
  readonly mode: ConnectorMode;
  #ready = false;

  constructor(mode: ConnectorMode) {
    this.mode = mode;
  }

  get ready(): boolean {
    return this.#ready;
  }

  /** Subclass probe: resolve `{ ok, detail, errorCode }`. Must not throw for a
   * failed auth — return `ok:false` so the connector stays unavailable. */
  protected abstract probe(): Promise<{
    ok: boolean;
    detail: string;
    errorCode: string | null;
  }>;

  async verifyConnection(): Promise<ConnectionHealth> {
    const result = await this.probe();
    this.#ready = result.ok;
    return Object.freeze({
      ok: result.ok,
      kind: this.kind,
      provider: this.provider,
      mode: this.mode,
      detail: result.detail,
      errorCode: result.errorCode,
      checkedAt: nowIso(),
    });
  }

  /** Fail-closed gate for capability methods. */
  protected assertReady(): void {
    if (!this.#ready) {
      throw new ConnectorError({
        code: "connector_unverified",
        kind: this.kind,
        provider: this.provider,
        message: `${this.provider} connector must be verified before use`,
      });
    }
  }
}
