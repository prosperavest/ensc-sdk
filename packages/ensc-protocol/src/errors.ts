/**
 * ENSC error taxonomy.
 *
 * Every error response from the API has shape:
 *
 *   {
 *     "error": {
 *       "code": "ENSC_VALIDATION_FAILED",
 *       "message": "human-readable message",
 *       "requestId": "req_01...",
 *       "details": { ... } // optional structured details
 *     }
 *   }
 *
 * Codes are namespaced with ENSC_ prefix so they're greppable in customer logs.
 * The set is closed: adding a code requires updating this file (and CHANGELOG).
 */

export type EnscErrorCode =
  // 4xx - caller's fault
  | 'ENSC_VALIDATION_FAILED'
  | 'ENSC_MISSING_API_KEY'
  | 'ENSC_INVALID_API_KEY'
  | 'ENSC_INVALID_API_KEY_FORMAT'
  | 'ENSC_KEY_REVOKED'
  | 'ENSC_KEY_EXPIRED'
  | 'ENSC_IP_NOT_ALLOWED'
  | 'ENSC_INSUFFICIENT_SCOPE'
  | 'ENSC_MISSING_SIGNATURE'
  | 'ENSC_BAD_SIGNATURE_FORMAT'
  | 'ENSC_INVALID_SIGNATURE'
  | 'ENSC_TIMESTAMP_OUT_OF_WINDOW'
  | 'ENSC_NONCE_REUSED'
  | 'ENSC_MISSING_PUBLIC_KEY'
  | 'ENSC_IDEMPOTENCY_CONFLICT'
  | 'ENSC_RATE_LIMITED'
  | 'ENSC_NOT_FOUND'
  | 'ENSC_FORBIDDEN'
  | 'ENSC_INVALID_CHAIN'
  | 'ENSC_INVALID_ASSET'
  | 'ENSC_AMOUNT_TOO_LARGE'
  | 'ENSC_AMOUNT_TOO_SMALL'
  | 'ENSC_INSUFFICIENT_BALANCE'
  | 'ENSC_INVALID_RECIPIENT'
  | 'ENSC_TEST_LIVE_MISMATCH'
  | 'ENSC_UNSUPPORTED_API_VERSION'
  // Conversions (ENSCConverter: issue / redeem, crypto and fiat legs)
  | 'ENSC_CONVERTER_UNAVAILABLE'
  | 'ENSC_INVALID_REFERENCE'
  | 'ENSC_REFERENCE_CONFLICT'
  | 'ENSC_INVALID_STATE'
  | 'ENSC_QUOTE_FAILED'
  | 'ENSC_RATE_STALE'
  | 'ENSC_RATE_DRIFT'
  | 'ENSC_RESERVE_INSUFFICIENT'
  | 'ENSC_RESERVE_UNAVAILABLE'
  | 'ENSC_VOUCHER_REFUSED'
  | 'ENSC_VOUCHER_UNAVAILABLE'
  | 'ENSC_SETTLEMENT_UNAVAILABLE'
  | 'ENSC_SETTLEMENT_VERIFICATION_FAILED'
  | 'ENSC_TX_ALREADY_USED'
  | 'ENSC_PAYOUT_DETAILS_REQUIRED'
  | 'ENSC_PAYOUT_REF_MISMATCH'
  | 'ENSC_PAYOUT_NOT_READY'
  | 'ENSC_PAYMENT_MISMATCH'
  | 'ENSC_PAYMENT_NOT_CONFIRMED'
  // Compliance (transaction screening)
  | 'ENSC_KYT_DECLINED'
  | 'ENSC_KYT_HOLD'
  | 'ENSC_KYT_REFERENCE_STALE'
  | 'ENSC_SCREENING_UNAVAILABLE'
  // Upstream services (payments, transaction screening)
  | 'ENSC_PROVIDER_NOT_CONFIGURED'
  | 'ENSC_PROVIDER_ERROR'
  | 'ENSC_PROVIDER_RATE_LIMITED'
  | 'ENSC_ACCOUNT_RESOLUTION_FAILED'
  // Payload encryption (ENSC-ENC-V1 request envelope, ENSC-RESP-V1 and V2 sealed response)
  | 'ENSC_ENCRYPTION_REQUIRED'
  | 'ENSC_DECRYPTION_FAILED'
  | 'ENSC_UNKNOWN_ENCRYPTION_KEY'
  | 'ENSC_ENCRYPTION_KEY_REVOKED'
  | 'ENSC_IP_ALLOWLIST_REQUIRED'
  // Requests made on behalf of an account
  | 'ENSC_MISSING_ACTOR_TOKEN'
  | 'ENSC_INVALID_ACTOR_TOKEN'
  | 'ENSC_OBO_REQUIRED'
  | 'ENSC_ACTOR_TOKEN_EXPIRED'
  | 'ENSC_MISSING_ON_BEHALF_OF'
  | 'ENSC_INVALID_ON_BEHALF_OF'
  | 'ENSC_ON_BEHALF_OF_MISMATCH'
  | 'ENSC_NOT_PLATFORM_KEY'
  | 'ENSC_DASHBOARD_ONLY'
  // Vaults API (positions, vault programmes, FX quotes)
  | 'ENSC_VAULTS_NOT_ENROLLED'
  | 'ENSC_VAULTS_NOT_APPROVED'
  | 'ENSC_VAULTS_NOT_DEPLOYED'
  | 'ENSC_ASSET_CLASS_NOT_ALLOWED'
  | 'ENSC_PARTICIPANT_ID_REQUIRED'
  | 'ENSC_PARTICIPANT_ID_UNKNOWN'
  | 'ENSC_PARTICIPANT_INACTIVE'
  | 'ENSC_VAULT_NOT_FOUND'
  | 'ENSC_POSITION_NOT_FOUND'
  | 'ENSC_LEDGER_ENTRY_NOT_FOUND'
  | 'ENSC_FX_RATE_UNAVAILABLE'
  | 'ENSC_SUBSCRIPTION_NOT_FOUND'
  | 'ENSC_VAULT_NOT_OPEN'
  | 'ENSC_VAULT_CAPACITY_EXCEEDED'
  | 'ENSC_WALLET_NOT_REGISTERED'
  | 'ENSC_MAX_TOTAL_PAY_TOO_LOW'
  | 'ENSC_ALLOWANCE_INSUFFICIENT'
  | 'ENSC_REDEMPTION_NOT_FOUND'
  | 'ENSC_REDEMPTION_NOT_ELIGIBLE'
  | 'ENSC_REDEMPTION_IN_PROGRESS'
  | 'ENSC_BENEFICIARY_NOT_FOUND'
  | 'ENSC_BENEFICIARY_EXISTS'
  | 'ENSC_FX_PAYOUT_NOT_FOUND'
  | 'ENSC_CREDIT_LINE_INSUFFICIENT'
  | 'ENSC_QUOTE_EXPIRED'
  | 'ENSC_REBALANCE_NOT_FOUND'
  | 'ENSC_REBALANCE_IN_PROGRESS'
  // Vaults API collection (senders, collection accounts, deposits)
  | 'ENSC_SENDER_NOT_FOUND'
  | 'ENSC_SENDER_EXISTS'
  | 'ENSC_SENDER_NOT_ACTIVE'
  | 'ENSC_SENDER_PAYOUT_LIMIT'
  | 'ENSC_COLLECTION_ACCOUNT_NOT_FOUND'
  | 'ENSC_COLLECTION_ACCOUNT_EXISTS'
  | 'ENSC_DEPOSIT_NOT_FOUND'
  | 'ENSC_FEE_BATCH_NOT_FOUND'
  | 'ENSC_PAYOUT_ACCOUNT_NOT_FOUND'
  | 'ENSC_FIAT_PAYOUT_NOT_FOUND'
  // 5xx - our fault
  | 'ENSC_INTERNAL'
  | 'ENSC_CHAIN_UNAVAILABLE'
  | 'ENSC_UPSTREAM_FAILED'
  | 'ENSC_NOT_IMPLEMENTED'
  | 'ENSC_DB_UNAVAILABLE'
  | 'ENSC_JWKS_UNAVAILABLE';

/**
 * Codes a server-side package adds to the set, by declaration merging: each
 * key is a code. The SDKs add none, so for a client the set is exactly
 * `EnscErrorCode`. A package that adds codes also registers their HTTP
 * statuses (`registerErrorStatuses`).
 */
// biome-ignore lint/suspicious/noEmptyInterface: filled by declaration merging
export interface EnscErrorCodeExtensions {}

/** Every code an `EnscError` may carry: `EnscErrorCode` plus the registered extensions. */
export type AnyEnscErrorCode = EnscErrorCode | Extract<keyof EnscErrorCodeExtensions, string>;

/** The extension codes (none for a client). */
export type EnscErrorCodeExtension = Exclude<AnyEnscErrorCode, EnscErrorCode>;

export interface EnscErrorBody {
  code: AnyEnscErrorCode;
  message: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

export interface EnscErrorResponse {
  error: EnscErrorBody;
}

/**
 * Map error codes to HTTP status. Single source of truth.
 */
export const ERROR_STATUS: Record<EnscErrorCode, number> = {
  ENSC_VALIDATION_FAILED: 400,
  ENSC_MISSING_API_KEY: 401,
  ENSC_INVALID_API_KEY: 401,
  ENSC_INVALID_API_KEY_FORMAT: 401,
  ENSC_KEY_REVOKED: 401,
  ENSC_KEY_EXPIRED: 401,
  ENSC_IP_NOT_ALLOWED: 403,
  ENSC_INSUFFICIENT_SCOPE: 403,
  ENSC_MISSING_SIGNATURE: 401,
  ENSC_BAD_SIGNATURE_FORMAT: 401,
  ENSC_INVALID_SIGNATURE: 401,
  ENSC_TIMESTAMP_OUT_OF_WINDOW: 401,
  ENSC_NONCE_REUSED: 401,
  ENSC_MISSING_PUBLIC_KEY: 401,
  ENSC_IDEMPOTENCY_CONFLICT: 409,
  ENSC_RATE_LIMITED: 429,
  ENSC_NOT_FOUND: 404,
  ENSC_FORBIDDEN: 403,
  ENSC_INVALID_CHAIN: 400,
  ENSC_INVALID_ASSET: 400,
  ENSC_AMOUNT_TOO_LARGE: 400,
  ENSC_AMOUNT_TOO_SMALL: 400,
  ENSC_INSUFFICIENT_BALANCE: 400,
  ENSC_INVALID_RECIPIENT: 400,
  ENSC_TEST_LIVE_MISMATCH: 400,
  ENSC_UNSUPPORTED_API_VERSION: 400,
  ENSC_CONVERTER_UNAVAILABLE: 400,
  ENSC_INVALID_REFERENCE: 400,
  ENSC_REFERENCE_CONFLICT: 409,
  ENSC_INVALID_STATE: 409,
  ENSC_QUOTE_FAILED: 502,
  ENSC_RATE_STALE: 409,
  ENSC_RATE_DRIFT: 409,
  ENSC_RESERVE_INSUFFICIENT: 409,
  ENSC_RESERVE_UNAVAILABLE: 503,
  ENSC_VOUCHER_REFUSED: 422,
  ENSC_VOUCHER_UNAVAILABLE: 503,
  ENSC_SETTLEMENT_UNAVAILABLE: 503,
  ENSC_SETTLEMENT_VERIFICATION_FAILED: 409,
  ENSC_TX_ALREADY_USED: 409,
  ENSC_PAYOUT_DETAILS_REQUIRED: 400,
  ENSC_PAYOUT_REF_MISMATCH: 409,
  ENSC_PAYOUT_NOT_READY: 409,
  ENSC_PAYMENT_MISMATCH: 409,
  ENSC_PAYMENT_NOT_CONFIRMED: 409,
  ENSC_KYT_DECLINED: 403,
  ENSC_KYT_HOLD: 409,
  ENSC_KYT_REFERENCE_STALE: 409,
  ENSC_SCREENING_UNAVAILABLE: 503,
  ENSC_PROVIDER_NOT_CONFIGURED: 503,
  ENSC_PROVIDER_ERROR: 502,
  ENSC_PROVIDER_RATE_LIMITED: 429,
  ENSC_ACCOUNT_RESOLUTION_FAILED: 422,
  ENSC_ENCRYPTION_REQUIRED: 400,
  ENSC_DECRYPTION_FAILED: 400,
  ENSC_UNKNOWN_ENCRYPTION_KEY: 401,
  ENSC_ENCRYPTION_KEY_REVOKED: 401,
  ENSC_IP_ALLOWLIST_REQUIRED: 400,
  ENSC_MISSING_ACTOR_TOKEN: 401,
  ENSC_INVALID_ACTOR_TOKEN: 401,
  ENSC_OBO_REQUIRED: 401,
  ENSC_ACTOR_TOKEN_EXPIRED: 401,
  ENSC_MISSING_ON_BEHALF_OF: 400,
  ENSC_INVALID_ON_BEHALF_OF: 400,
  ENSC_ON_BEHALF_OF_MISMATCH: 403,
  ENSC_NOT_PLATFORM_KEY: 403,
  ENSC_DASHBOARD_ONLY: 403,
  ENSC_VAULTS_NOT_ENROLLED: 404,
  ENSC_VAULTS_NOT_APPROVED: 403,
  ENSC_VAULTS_NOT_DEPLOYED: 404,
  ENSC_ASSET_CLASS_NOT_ALLOWED: 403,
  ENSC_PARTICIPANT_ID_REQUIRED: 400,
  ENSC_PARTICIPANT_ID_UNKNOWN: 403,
  ENSC_PARTICIPANT_INACTIVE: 409,
  ENSC_VAULT_NOT_FOUND: 404,
  ENSC_POSITION_NOT_FOUND: 404,
  ENSC_LEDGER_ENTRY_NOT_FOUND: 404,
  ENSC_FX_RATE_UNAVAILABLE: 503,
  ENSC_SUBSCRIPTION_NOT_FOUND: 404,
  ENSC_VAULT_NOT_OPEN: 409,
  ENSC_VAULT_CAPACITY_EXCEEDED: 409,
  ENSC_WALLET_NOT_REGISTERED: 403,
  ENSC_MAX_TOTAL_PAY_TOO_LOW: 409,
  ENSC_ALLOWANCE_INSUFFICIENT: 409,
  ENSC_REDEMPTION_NOT_FOUND: 404,
  ENSC_REDEMPTION_NOT_ELIGIBLE: 409,
  ENSC_REDEMPTION_IN_PROGRESS: 409,
  ENSC_BENEFICIARY_NOT_FOUND: 404,
  ENSC_BENEFICIARY_EXISTS: 409,
  ENSC_FX_PAYOUT_NOT_FOUND: 404,
  ENSC_CREDIT_LINE_INSUFFICIENT: 409,
  ENSC_QUOTE_EXPIRED: 409,
  ENSC_REBALANCE_NOT_FOUND: 404,
  ENSC_REBALANCE_IN_PROGRESS: 409,
  ENSC_SENDER_NOT_FOUND: 404,
  ENSC_SENDER_EXISTS: 409,
  ENSC_SENDER_NOT_ACTIVE: 409,
  ENSC_SENDER_PAYOUT_LIMIT: 409,
  ENSC_COLLECTION_ACCOUNT_NOT_FOUND: 404,
  ENSC_COLLECTION_ACCOUNT_EXISTS: 409,
  ENSC_DEPOSIT_NOT_FOUND: 404,
  ENSC_FEE_BATCH_NOT_FOUND: 404,
  ENSC_PAYOUT_ACCOUNT_NOT_FOUND: 404,
  ENSC_FIAT_PAYOUT_NOT_FOUND: 404,
  ENSC_INTERNAL: 500,
  ENSC_CHAIN_UNAVAILABLE: 502,
  ENSC_UPSTREAM_FAILED: 502,
  ENSC_NOT_IMPLEMENTED: 501,
  ENSC_DB_UNAVAILABLE: 503,
  ENSC_JWKS_UNAVAILABLE: 503,
};

const EXTENSION_STATUS = new Map<string, number>();

/**
 * Register the HTTP status of each extension code (see
 * `EnscErrorCodeExtensions`). A code of the base set cannot be registered,
 * and a status must be an HTTP error status (400 to 599).
 */
export function registerErrorStatuses(
  statuses: Readonly<Record<EnscErrorCodeExtension, number>>,
): void {
  const entries = Object.entries(statuses) as Array<[string, number]>;
  // All or nothing: every entry is checked before any is registered.
  for (const [code, status] of entries) {
    if (Object.hasOwn(ERROR_STATUS, code)) {
      throw new TypeError(`${code} is a base error code; its status is not registered`);
    }
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new TypeError(`${code}: ${status} is not an HTTP error status`);
    }
  }
  for (const [code, status] of entries) EXTENSION_STATUS.set(code, status);
}

/** The HTTP status of a code: the base map, then the registered extensions, else 500. */
export function errorStatusOf(code: AnyEnscErrorCode): number {
  return (
    (ERROR_STATUS as Partial<Record<string, number>>)[code] ?? EXTENSION_STATUS.get(code) ?? 500
  );
}

export interface EnscErrorExtra {
  /** HTTP status actually received, when it differs from the code's default. */
  status?: number | undefined;
  /** The `X-ENSC-Request-Id` of the failed call; quote it to support. */
  requestId?: string | undefined;
}

export class EnscError extends Error {
  readonly code: AnyEnscErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;

  constructor(
    code: AnyEnscErrorCode,
    message: string,
    details?: Record<string, unknown>,
    extra?: EnscErrorExtra,
  ) {
    super(message);
    this.name = 'EnscError';
    this.code = code;
    // A code the API added after this client was built still gets a status.
    this.status = extra?.status ?? errorStatusOf(code);
    if (details !== undefined) this.details = details;
    if (extra?.requestId !== undefined) this.requestId = extra.requestId;
  }

  toJSON(requestId?: string): EnscErrorResponse {
    const body: EnscErrorBody = { code: this.code, message: this.message };
    if (requestId) body.requestId = requestId;
    if (this.details) body.details = this.details;
    return { error: body };
  }
}

/** Type guard for the SDK */
export function isEnscErrorResponse(x: unknown): x is EnscErrorResponse {
  return (
    typeof x === 'object' &&
    x !== null &&
    'error' in x &&
    typeof (x as EnscErrorResponse).error?.code === 'string'
  );
}
