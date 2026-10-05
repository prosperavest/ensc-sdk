/**
 * @ensc/sdk, the official ENSC API client.
 *
 * Server-side only. Construct an {@link EnscClient} with the four credentials
 * the dashboard issued (API key, encryption key, signing key and their ids);
 * call resource methods; catch {@link EnscError}. Request encryption, request
 * signing and sealed-response verification are automatic. See the README.
 */

// ── API contract types (re-exported from @ensc/api-schemas) ───────────────
// Power users can reach the full request/response/enum schemas under `api`.
export type * as api from '@ensc/api-schemas';
// ── Signing primitives (re-exported from @ensc/protocol) ──────────────────
export {
  type Ed25519Keypair,
  generateKeypair,
  publicKeyFromPrivate,
} from '@ensc/protocol';
// ── Errors and list / pagination input (from the shared client core) ─────
export {
  type DeprecationNotice,
  EnscError,
  type EnscErrorCode,
  isClientError,
  isEnscError,
  isEnscErrorCode,
  isEnscErrorResponse,
  isServerError,
  type ListByEnvParams,
  type ListParams,
} from '@ensc/sdk-core';
// ── Chains ────────────────────────────────────────────────────────────────
export {
  ASSETS,
  type Asset,
  type ChainInput,
  type ChainSlug,
  CONVERTER_CHAINS,
  isKnownChain,
  KNOWN_CHAINS,
  MAINNET_CHAINS,
  PAIRS,
  type Pair,
  TESTNET_CHAINS,
} from './chains.js';
// ── Client ────────────────────────────────────────────────────────────────
export { EnscClient } from './client.js';
// ── Configuration ─────────────────────────────────────────────────────────
export {
  DEFAULT_API_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RESPONSE_MAX_SKEW_SECONDS,
  DEFAULT_TIMEOUT_MS,
  type EnscClientConfig,
  PUBLIC_KEYS_PATH,
} from './config.js';
export type { ResolveAccountParams } from './resources/accounts.js';
export type { BalanceAsset, GetBalanceParams } from './resources/balance.js';
export type {
  Conversion,
  ConversionStatus,
  ConversionType,
  CreateConversionParams,
  CreateCryptoIssueParams,
  CreateCryptoRedeemParams,
  CreateFiatIssueParams,
  CreateFiatRedeemParams,
  IssuedVoucher,
  ListConversionsParams,
  Payer,
  PaymentInstructions,
  PayoutDestination,
  QuoteParams,
  QuoteResponse,
  ReportEventParams,
  ScreeningCounterparty,
  ScreeningStatusResponse,
} from './resources/conversions.js';
export type {
  EventDelivery,
  EventDetail,
  EventEnv,
  EventOutboxStatus,
  EventSummary,
  ListEventsParams,
  ListEventsResponse,
} from './resources/events.js';
// ── Resource types ────────────────────────────────────────────────────────
export type {
  ListSigningKeysResponse,
  SigningKeySummary,
} from './resources/signing-keys.js';
export type {
  EmitTestEventParams,
  EmitTestEventResponse,
  ListTestEventsResponse,
  TestEventTemplate,
} from './resources/test-events.js';
export type { TransferParams } from './resources/transfer.js';
export type {
  CreateWebhookEndpointParams,
  CreateWebhookEndpointResponse,
  ListWebhookEndpointsParams,
  ListWebhookEndpointsResponse,
  RemoveWebhookEndpointResponse,
  SendTestEventParams,
  SendTestEventResponse,
  UpdateWebhookEndpointParams,
  UpdateWebhookEndpointResponse,
  WebhookEndpoint,
  WebhookEndpointStatus,
  WebhookEnv,
} from './resources/webhook-endpoints.js';
// ── Webhooks (for receivers) ──────────────────────────────────────────────
export {
  constructEvent,
  createEnscWebhookKeyCache,
  type FetchPublicKeysOptions,
  fetchEnscPublicKeys,
  type VerifyWebhookOptions,
  verifyWebhookSignature,
  WEBHOOK_KEY_REFRESH_INTERVAL_MS,
  type WebhookEvent,
  type WebhookHeaders,
  type WebhookKeyCache,
  type WebhookKeyCacheOptions,
  type WebhookVerificationResult,
} from './webhooks.js';
