/**
 * Stripe settlement adapter.
 *
 * A real {@link PaymentCollector} that charges an issued invoice's exact
 * amount-due through Stripe's PaymentIntents API, mapping the processor result
 * to `settled | failed | pending`. It plugs into the existing settlement port
 * with no change to {@link TenantSettlementLedger}, which still owns idempotency
 * caching, the invoice state machine, the boundary guards, and the hash-chained
 * ledger.
 *
 * Safety posture (default is "cannot charge real money by accident"):
 *   - Selecting `stripe` mode only chooses the adapter; the collector still fails
 *     closed at construction when `STRIPE_SECRET_KEY` is missing
 *     (`billing_stripe_secret_key_missing`) — never a silent fallback to mock
 *     and never a fabricated success.
 *   - A live key (`sk_live_` / `rk_live_`) requires the explicit opt-in
 *     `MENDPOINT_BILLING_ALLOW_LIVE=1`; otherwise construction throws
 *     `billing_stripe_live_key_forbidden`. Test keys (`sk_test_` / `rk_test_`)
 *     work without the opt-in. Any other key shape is rejected
 *     (`billing_stripe_secret_key_invalid`) so an unclassifiable key is never
 *     put on the wire.
 *   - The secret is held as a redacting {@link SecretMaterial} and revealed only
 *     to build the Authorization header. Every error string the collector
 *     surfaces is run through a redactor, so the key can never leak into a
 *     ledger entry, a thrown error, or a log.
 *
 * Idempotency is layered: this adapter derives a Stripe `Idempotency-Key` from
 * the invoice plus the settlement idempotency key, so a retry with the same
 * settlement key replays the same PaymentIntent instead of double-charging. The
 * ledger's own replay guard stays as the second layer.
 */
import { createHash } from "node:crypto";
import { SecretMaterial } from "@mendpoint/platform";
import type { Invoice } from "./invoice-boundary.js";
import {
  MockPaymentCollector,
  resolveCollectionMode,
  type BillingCollectionMode,
  type CollectionContext,
  type CollectionOutcome,
  type PaymentCollector,
} from "./payment-collection.js";

/** Env var holding the Stripe secret key (never logged, never stored at rest). */
export const STRIPE_SECRET_KEY_ENV = "STRIPE_SECRET_KEY" as const;
/** Explicit opt-in required before a live (`sk_live_`) key is allowed to charge. */
export const STRIPE_ALLOW_LIVE_ENV = "MENDPOINT_BILLING_ALLOW_LIVE" as const;

const DEFAULT_STRIPE_API_BASE = "https://api.stripe.com" as const;
/** Pin the Stripe API version so response shape is stable across account defaults. */
const STRIPE_API_VERSION = "2024-06-20" as const;

/**
 * Minimal HTTP seam, mirroring the connector fetch seam in
 * `packages/connectors/src/connector.ts`. Injecting it lets tests script the
 * Stripe path deterministically with no network and no real charge.
 */
export type StripeFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; json: unknown }>;

/** Real transport. Failures collapse to a non-ok, no-json result (retryable). */
export const defaultStripeFetch: StripeFetch = async (url, init) => {
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(20000),
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  }
};

/**
 * Where the charge is drawn from. In a wired deployment a tenant maps to a
 * Stripe customer with a default off-session payment method; this resolver is
 * the seam for that mapping. Without it the PaymentIntent has no payment method
 * and Stripe reports `requires_payment_method`, which maps to a (retryable)
 * `failed` outcome — safe, never a silent success.
 */
export type StripeChargeTarget = Readonly<{
  customer?: string;
  paymentMethod?: string;
}>;

export type StripeChargeResolver = (
  invoice: Invoice,
) => StripeChargeTarget | Promise<StripeChargeTarget>;

export type StripePaymentCollectorConfig = Readonly<{
  /** The Stripe secret key. Required; empty fails closed. */
  secretKey: string;
  /** Must be true to permit a live (`sk_live_` / `rk_live_`) key. */
  allowLive?: boolean;
  /** Injected transport for deterministic tests. Defaults to real fetch. */
  fetch?: StripeFetch;
  /** API base override (Stripe test/sandbox hosts). Defaults to api.stripe.com. */
  apiBaseUrl?: string;
  /** Optional tenant -> Stripe customer/payment-method resolver. */
  resolveCharge?: StripeChargeResolver;
}>;

/** Stripe zero-decimal currencies: the smallest unit is the whole currency unit. */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF",
  "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);
/** Three-decimal currencies are deliberately unsupported in this slice. */
const THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BHD", "JOD", "KWD", "OMR", "TND",
]);

/**
 * Micros-per-Stripe-minor-unit for a currency. Invoice money is in micros
 * (1_000_000 micros = one currency unit); Stripe wants the smallest unit
 * (10^decimals per unit), so micros-per-minor-unit is 10^(6 - decimals).
 * Returns null for currencies this slice will not charge.
 */
function microsPerMinorUnit(currency: string): number | null {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 1_000_000; // 10^(6-0)
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return null; // unsupported
  return 10_000; // 10^(6-2), the two-decimal default
}

/** Convert an amount-due in micros to a Stripe integer minor-unit amount. */
function toStripeAmount(
  currency: string,
  amountMicros: number,
): { ok: true; amount: number } | { ok: false } {
  const divisor = microsPerMinorUnit(currency);
  if (divisor === null) return { ok: false };
  if (!Number.isSafeInteger(amountMicros) || amountMicros < 1) return { ok: false };
  if (amountMicros % divisor !== 0) return { ok: false };
  return { ok: true, amount: amountMicros / divisor };
}

type StripeError = {
  code?: string;
  decline_code?: string;
  type?: string;
  payment_intent?: { id?: string; status?: string };
};

type StripePaymentIntent = {
  id?: string;
  status?: string;
  last_payment_error?: { code?: string; decline_code?: string };
};

function isLiveKey(key: string): boolean {
  return key.startsWith("sk_live_") || key.startsWith("rk_live_");
}

function isTestKey(key: string): boolean {
  return key.startsWith("sk_test_") || key.startsWith("rk_test_");
}

/** Real Stripe-backed collector. Fail-closed at construction; side-effect free
 * with respect to the invoice (returns an outcome, never mutates state). */
export class StripePaymentCollector implements PaymentCollector {
  readonly #secret: SecretMaterial;
  readonly #fetch: StripeFetch;
  readonly #api: string;
  readonly #resolveCharge: StripeChargeResolver | undefined;

  constructor(config: StripePaymentCollectorConfig) {
    const key = config.secretKey?.trim() ?? "";
    if (!key) throw new Error("billing_stripe_secret_key_missing");
    if (isLiveKey(key)) {
      if (config.allowLive !== true) throw new Error("billing_stripe_live_key_forbidden");
    } else if (!isTestKey(key)) {
      // Neither a recognizable test nor live key: refuse rather than risk
      // putting an unclassifiable secret on the wire.
      throw new Error("billing_stripe_secret_key_invalid");
    }
    this.#secret = new SecretMaterial(key);
    this.#fetch = config.fetch ?? defaultStripeFetch;
    this.#api = (config.apiBaseUrl ?? DEFAULT_STRIPE_API_BASE).replace(/\/+$/, "");
    this.#resolveCharge = config.resolveCharge;
  }

  /** Replace any occurrence of the raw key with a redaction marker. */
  #redact(text: string): string {
    if (!text) return text;
    const raw = this.#secret.reveal();
    return raw ? text.split(raw).join("[REDACTED]") : text;
  }

  #failed(reference: string, error: string): CollectionOutcome {
    return Object.freeze({ status: "failed" as const, reference, error: this.#redact(error) });
  }

  /**
   * Deterministic Stripe idempotency key: stable for a given invoice + amount +
   * settlement key, so a retry under the same settlement key replays the same
   * PaymentIntent and can never double-charge.
   */
  #idempotencyKey(invoice: Invoice, amountMicros: number, settlementKey: string): string {
    const digest = createHash("sha256")
      .update([
        "stripe-payment-intent-v1",
        invoice.tenantId,
        invoice.id,
        invoice.evidence.digest,
        String(amountMicros),
        invoice.currency,
        settlementKey,
      ].join("\n"))
      .digest("hex");
    return `mp-settle-${digest}`;
  }

  /** Local, key-free reference for an attempt Stripe never returned an id for. */
  #syntheticReference(invoice: Invoice, amountMicros: number): string {
    const digest = createHash("sha256")
      .update(`${invoice.tenantId}\n${invoice.id}\n${invoice.evidence.digest}\n${amountMicros}`)
      .digest("hex")
      .slice(0, 32);
    return `stripe-unsettled:${invoice.id}:${digest}`;
  }

  async attemptCollection(
    invoice: Invoice,
    context?: CollectionContext,
  ): Promise<CollectionOutcome> {
    const amountMicros = invoice.totalMoneyMicros - invoice.amountPaidMoneyMicros;
    const synthetic = this.#syntheticReference(invoice, amountMicros);
    const amount = toStripeAmount(invoice.currency, amountMicros);
    if (!amount.ok) {
      return this.#failed(synthetic, "billing_stripe_amount_not_representable");
    }

    const target = this.#resolveCharge ? await this.#resolveCharge(invoice) : {};
    const params = new URLSearchParams();
    params.set("amount", String(amount.amount));
    params.set("currency", invoice.currency.toLowerCase());
    params.set("confirm", "true");
    params.set("metadata[invoice_id]", invoice.id);
    params.set("metadata[tenant_id]", invoice.tenantId);
    params.set("metadata[reconciliation_digest]", invoice.evidence.digest);
    if (target.customer) {
      params.set("customer", target.customer);
      params.set("off_session", "true");
    }
    if (target.paymentMethod) params.set("payment_method", target.paymentMethod);

    const idempotencyKey = this.#idempotencyKey(
      invoice,
      amountMicros,
      context?.idempotencyKey ?? "",
    );

    const response = await this.#fetch(`${this.#api}/v1/payment_intents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#secret.reveal()}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": idempotencyKey,
        "Stripe-Version": STRIPE_API_VERSION,
      },
      body: params.toString(),
    });

    return this.#mapResponse(invoice, amountMicros, synthetic, response);
  }

  #mapResponse(
    invoice: Invoice,
    amountMicros: number,
    synthetic: string,
    response: { ok: boolean; status: number; json: unknown },
  ): CollectionOutcome {
    const body = (response.json ?? null) as
      | { error?: StripeError; id?: string; status?: string; last_payment_error?: unknown }
      | null;

    // Stripe error envelope (e.g. 402 card_declined, 401 auth, 429 rate limit).
    if (body && typeof body === "object" && body.error) {
      const err = body.error;
      const reference = err.payment_intent?.id ?? synthetic;
      const reason = err.decline_code ?? err.code ?? err.type ?? String(response.status);
      return this.#failed(reference, `billing_stripe_charge_declined:${reason}`);
    }

    // Transport/5xx with no parseable body: retryable.
    if (!body || typeof body !== "object") {
      return this.#failed(synthetic, `billing_stripe_request_failed:${response.status}`);
    }

    const intent = body as StripePaymentIntent;
    const id = typeof intent.id === "string" ? intent.id : undefined;
    if (!id) {
      return this.#failed(synthetic, "billing_stripe_unexpected_response");
    }

    switch (intent.status) {
      case "succeeded":
        return Object.freeze({ status: "settled" as const, reference: id });
      case "requires_action":
      case "requires_confirmation":
      case "processing":
        return Object.freeze({ status: "pending" as const, reference: id });
      case "requires_payment_method":
      case "canceled": {
        const reason =
          intent.last_payment_error?.decline_code ??
          intent.last_payment_error?.code ??
          intent.status;
        return this.#failed(id, `billing_stripe_charge_declined:${reason}`);
      }
      default:
        return this.#failed(id, `billing_stripe_status_unexpected:${intent.status ?? "unknown"}`);
    }
  }
}

/**
 * Build a Stripe collector from the environment. Reads {@link STRIPE_SECRET_KEY_ENV}
 * and the {@link STRIPE_ALLOW_LIVE_ENV} opt-in; all fail-closed enforcement lives
 * in the constructor. `overrides` is the injection point for the fetch seam,
 * API base, and charge resolver.
 */
export function createStripeCollectorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: Partial<Omit<StripePaymentCollectorConfig, "secretKey" | "allowLive">>,
): StripePaymentCollector {
  const secretKey = (env[STRIPE_SECRET_KEY_ENV] ?? "").trim();
  const allowLive = env[STRIPE_ALLOW_LIVE_ENV] === "1";
  return new StripePaymentCollector({ secretKey, allowLive, ...overrides });
}

/**
 * Single wiring point for the resolution table. Maps the collection mode to a
 * collector, fail-closed:
 *   - `disabled` (default / unset / any other value) -> no collector; settlement
 *     stays disabled and byte-identical to today.
 *   - `mock` -> the shipped {@link MockPaymentCollector} (moves no real money).
 *   - `stripe` -> {@link StripePaymentCollector}, which throws if the key is
 *     missing or a live key lacks the opt-in.
 */
export function resolvePaymentCollector(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: Partial<Omit<StripePaymentCollectorConfig, "secretKey" | "allowLive">>,
): { mode: BillingCollectionMode; collector: PaymentCollector | null } {
  const mode = resolveCollectionMode(env);
  switch (mode) {
    case "mock":
      return { mode, collector: new MockPaymentCollector() };
    case "stripe":
      return { mode, collector: createStripeCollectorFromEnv(env, overrides) };
    case "disabled":
    default:
      return { mode: "disabled", collector: null };
  }
}
