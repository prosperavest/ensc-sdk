/**
 * @ensc/sdk-core: the client core every ProsperaVest SDK is built on.
 *
 * One implementation of the wire protocol (configuration and its validation,
 * the transport with retries and idempotency, ENSC-ENC-V1 request encryption,
 * ENSC-V2 request signing, ENSC-RESP-V2 sealed-response verification and
 * opening, ENSC-WH-V1 webhook verification, the error taxonomy), parameterised
 * by an {@link SdkProduct}. `@ensc/sdk` and `@prosperavest/vaults` are each
 * one descriptor plus their resources, and inline this package at build time;
 * it is not published on its own.
 */

export {
  type ClientConfigBase,
  type ClientConfigInput,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RESPONSE_MAX_SKEW_SECONDS,
  DEFAULT_TIMEOUT_MS,
  type DeprecationNotice,
  type ResolvedClientConfig,
  resolveClientConfig,
} from './config.js';
export {
  buildResponseCanonical,
  type EncryptRequestInput,
  encryptRequestBody,
  KEY_FETCH_ATTEMPTS,
  type OpenSealedInput,
  openSealedResponse,
  PublicKeyResolver,
  RESPONSE_HEADERS,
  RESPONSE_SIGNATURE_VERSION,
} from './crypto.js';
export {
  EnscError,
  type EnscErrorCode,
  isClientError,
  isEnscError,
  isEnscErrorCode,
  isEnscErrorResponse,
  isServerError,
} from './errors.js';
export {
  HttpClient,
  type ListByEnvParams,
  type ListParams,
  type QueryParams,
  type QueryValue,
  type RequestOptions,
} from './http.js';
export type { SdkProduct } from './product.js';
export {
  generateIdempotencyKey,
  generateNonce,
  generateResponseNonce,
  type SignatureHeaders,
  type SignMutationInput,
  signMutation,
} from './signing.js';
export {
  constructEvent,
  createWebhookKeyCache,
  type FetchPublicKeysOptions,
  fetchPublicKeys,
  type VerifyWebhookOptions,
  verifyWebhookSignature,
  WEBHOOK_KEY_REFRESH_INTERVAL_MS,
  type WebhookEvent,
  type WebhookHeaders,
  type WebhookKeyCache,
  type WebhookKeyCacheOptions,
  type WebhookVerificationResult,
} from './webhooks.js';
