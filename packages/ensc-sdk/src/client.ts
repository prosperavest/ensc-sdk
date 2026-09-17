/**
 * EnscClient, the entry point.
 *
 * Construct one per merchant with the four credentials the dashboard issued.
 * Resources hang off the instance as properties:
 *
 *   const ensc = new EnscClient({
 *     apiKey: process.env.ENSC_API_KEY!,
 *     merchantId: process.env.ENSC_MERCHANT_ID!,
 *     encryptionKey: process.env.ENSC_ENCRYPTION_KEY!,
 *     encryptionKeyId: process.env.ENSC_ENCRYPTION_KEY_ID!,
 *     signingPrivateKey: process.env.ENSC_SIGNING_PRIVATE_KEY!,
 *     signingKeyId: process.env.ENSC_SIGNING_KEY_ID!,
 *   });
 *
 *   await ensc.balance.get({ account, chain: 'celo', asset: 'ENSC' });
 *   const conversion = await ensc.conversions.create({
 *     type: 'crypto-issue', chain: 'celo', wallet, pair: 'USDC', amount: '100',
 *   });
 *   // sign conversion.voucher.approvalTransaction (if any), then conversion.voucher.transaction
 *   await ensc.conversions.events.confirmed(conversion.reference, txHash);
 *
 * Every write is encrypted (ENSC-ENC-V1) and signed (ENSC-V1); every successful
 * response is verified against ENSC's published key and opened (ENSC-RESP-V1)
 * before it is returned. None of that is visible to callers.
 */

import { type Ed25519Keypair, generateKeypair } from '@ensc/protocol';
import { type EnscClientConfig, resolveConfig } from './config.js';
import { HttpClient } from './http.js';
import { AccountsResource } from './resources/accounts.js';
import { ApiKeysResource } from './resources/api-keys.js';
import { BalanceResource } from './resources/balance.js';
import { BanksResource } from './resources/banks.js';
import { ConversionsResource } from './resources/conversions.js';
import { EncryptionKeysResource } from './resources/encryption-keys.js';
import { EventsResource } from './resources/events.js';
import { OriginsResource } from './resources/origins.js';
import { SigningKeysResource } from './resources/signing-keys.js';
import { TestEventsResource } from './resources/test-events.js';
import { TransferResource } from './resources/transfer.js';
import { WebhookEndpointsResource } from './resources/webhook-endpoints.js';
import {
  constructEvent,
  type FetchPublicKeysOptions,
  fetchEnscPublicKeys,
  type VerifyWebhookOptions,
  verifyWebhookSignature,
  type WebhookEvent,
  type WebhookVerificationResult,
} from './webhooks.js';

export class EnscClient {
  // ── Management (reads; issuance is dashboard-only) ──────────────────────
  readonly apiKeys: ApiKeysResource;
  readonly signingKeys: SigningKeysResource;
  readonly encryptionKeys: EncryptionKeysResource;
  readonly origins: OriginsResource;
  readonly webhookEndpoints: WebhookEndpointsResource;
  readonly events: EventsResource;
  /** Sandbox-only synthetic events for exercising your webhook receiver. */
  readonly testEvents: TestEventsResource;

  // ── Reads ───────────────────────────────────────────────────────────────
  readonly balance: BalanceResource;
  readonly banks: BanksResource;

  // ── Conversions and transfers (return calldata for the merchant wallet) ─
  readonly conversions: ConversionsResource;
  readonly accounts: AccountsResource;
  readonly transfer: TransferResource;

  // The transport - and the resolved config / secrets it closes over - is held
  // privately. It is not enumerable and not reachable from outside the instance.
  readonly #http: HttpClient;

  constructor(config: EnscClientConfig) {
    const resolved = resolveConfig(config);
    this.#http = new HttpClient(resolved);

    this.apiKeys = new ApiKeysResource(this.#http);
    this.signingKeys = new SigningKeysResource(this.#http);
    this.encryptionKeys = new EncryptionKeysResource(this.#http);
    this.origins = new OriginsResource(this.#http);
    this.webhookEndpoints = new WebhookEndpointsResource(this.#http);
    this.events = new EventsResource(this.#http);
    this.testEvents = new TestEventsResource(this.#http);

    this.balance = new BalanceResource(this.#http);
    this.banks = new BanksResource(this.#http);

    this.conversions = new ConversionsResource(this.#http);
    this.accounts = new AccountsResource(this.#http);
    this.transfer = new TransferResource(this.#http);
  }

  /**
   * Generate a fresh Ed25519 keypair locally. Advanced use only: integrators
   * receive their signing key from the dashboard and never need to call this.
   *
   * Registration is a dashboard-only operation (403 `ENSC_DASHBOARD_ONLY`
   * from the SDK), so a keypair generated here cannot be installed through
   * this SDK. Use it when you need an Ed25519 keypair for an unrelated
   * purpose, or to check the key format the dashboard issues.
   */
  static generateKeypair(): Ed25519Keypair {
    return generateKeypair();
  }

  /**
   * Verify an inbound webhook delivery's signature. Never throws - returns a
   * result object. Static: webhook receivers don't need a configured client.
   */
  static verifyWebhookSignature(opts: VerifyWebhookOptions): WebhookVerificationResult {
    return verifyWebhookSignature(opts);
  }

  /**
   * Verify an inbound webhook delivery and return the parsed event. Throws
   * `EnscError('ENSC_INVALID_SIGNATURE')` if verification fails.
   */
  static constructEvent<T = unknown>(opts: VerifyWebhookOptions): WebhookEvent<T> {
    return constructEvent<T>(opts);
  }

  /**
   * Load ENSC's current webhook signing keys, `{ [kid]: publicKey }`, for
   * `constructEvent` and `verifyWebhookSignature`. Cache the result and refetch
   * when a delivery names a key id you do not hold.
   */
  static fetchPublicKeys(options?: FetchPublicKeysOptions): Promise<Record<string, string>> {
    return fetchEnscPublicKeys(options);
  }
}
