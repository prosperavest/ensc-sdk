/**
 * Conversions: `/v1/conversions`.
 *
 * A conversion is one operation on the ENSC converter:
 *
 *   crypto-issue    pair token in (USDC, USDT, CELO)  ->  ENSC out
 *   crypto-redeem   ENSC in                           ->  pair token out
 *   fiat-issue      Naira bank transfer in            ->  ENSC out
 *   fiat-redeem     ENSC in                           ->  Naira bank payout out
 *
 * ENSC never holds a wallet key. `create` returns a signed voucher together
 * with the calldata the merchant wallet must sign: an optional
 * `approvalTransaction` (ERC-20 approve to the converter) and then
 * `transaction` (the converter call). After broadcasting, report the hash with
 * `events.submitted` and `events.confirmed`; the API verifies the receipt and
 * either completes the conversion or starts the Naira payout.
 *
 * A fiat-issue returns `paymentInstructions` instead: once the bank transfer
 * is confirmed the voucher is issued and can be fetched with `get` or forced
 * with `voucher`.
 */

import type * as api from '@ensc/api-schemas';
import type { HttpClient, ListParams } from '@ensc/sdk-core';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { ChainInput, Pair } from '../chains.js';

export type ConversionType = api.ConversionType;
export type ConversionStatus = api.ConversionStatus;
export type Conversion = api.Conversion;
export type IssuedVoucher = api.IssuedVoucher;
export type PaymentInstructions = api.PaymentInstructions;
export type QuoteResponse = api.QuoteResponse;
export type ScreeningStatusResponse = api.ScreeningStatusResponse;
/**
 * A conversion's screening status. `travel_rule_pending` (the compliance
 * check of a crypto transfer has not completed) and
 * `wallet_ownership_unproven` (the customer wallet is not proven: send
 * `counterparty.walletProof`) are holds, never an approval or a decline.
 */
export type ScreeningStatus = api.ScreeningStatus;
export type TravelRuleHoldReason = api.TravelRuleHoldReason;
/**
 * Proof that your customer controls `counterparty.wallet` on the chain of the
 * request. `transfer`: on a crypto-issue, the customer's pay-in (a mined,
 * successful transfer of the conversion's token and exact amount from the
 * wallet on that chain); on a crypto-redeem, the earlier pay-in that proved
 * the wallet; one transaction proves one wallet for one account. `signature`:
 * an EIP-191 personal_sign by the wallet over {@link walletProofMessage}
 * (ERC-1271 for a contract wallet). A proven wallet is remembered for your
 * account on that chain.
 */
export type WalletProof =
  | { type: 'transfer'; txHash: string }
  | { type: 'signature'; signature: string };

export interface PayoutDestination {
  bankCode: string;
  accountNumber: string;
  /** Must match the name `accounts.resolve` returns (case and spacing folded). */
  accountName: string;
}

export interface Payer {
  email: string;
  name?: string;
  phone?: string;
}

/** Your customer: the other party of the conversion. */
export interface ScreeningCounterparty {
  type?: 'individual' | 'company';
  name?: string;
  /** Your customer's own wallet (never your signing wallet). */
  wallet?: string;
  /** Proof that your customer controls `wallet`; needs `wallet`. */
  walletProof?: WalletProof;
}

/** An address in EIP-55 mixed case; refuses anything that is not 0x and 40 hex characters. */
function checksumAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new TypeError('wallet must be 0x and 40 hex characters');
  }
  const lower = address.slice(2).toLowerCase();
  const hash = bytesToHex(keccak_256(utf8ToBytes(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const c = lower[i] as string;
    out += Number.parseInt(hash[i] as string, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/**
 * The exact text your customer's wallet signs (EIP-191 personal_sign) for a
 * `signature` wallet proof. It binds your merchant id, the wallet (written
 * EIP-55 checksummed here, whatever case you pass) and the chain id; it holds
 * no secret and does not expire.
 */
export function walletProofMessage(input: {
  merchantId: string;
  wallet: string;
  chainId: number;
}): string {
  return [
    'ENSC wallet ownership',
    `Merchant: ${input.merchantId}`,
    `Wallet: ${checksumAddress(input.wallet)}`,
    `Chain ID: ${input.chainId}`,
    'I confirm that I control this wallet.',
  ].join('\n');
}

interface CreateConversionBase {
  /** Converter chain of the key's environment: `celo` (live) or `celo-sepolia` (test). */
  chain: ChainInput;
  /** The merchant wallet that will sign the converter call; the voucher binds to it. */
  wallet: string;
  /** Amount in major units as a decimal string (see each type). */
  amount: string;
  /** Your own reference `op:<type>:<hex>`; minted by the API when omitted. */
  reference?: string;
  counterparty?: ScreeningCounterparty;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface CreateCryptoIssueParams extends CreateConversionBase {
  type: 'crypto-issue';
  /** Pair token paid in; `amount` is in that token. */
  pair: Pair;
}

export interface CreateCryptoRedeemParams extends CreateConversionBase {
  type: 'crypto-redeem';
  /** Pair token received; `amount` is ENSC. */
  pair: Pair;
}

export interface CreateFiatIssueParams extends CreateConversionBase {
  type: 'fiat-issue';
  /** `amount` is NGN (2 dp); ENSC is issued one to one. */
  payer: Payer;
}

export interface CreateFiatRedeemParams extends CreateConversionBase {
  type: 'fiat-redeem';
  /** `amount` is ENSC (2 dp); NGN is paid out one to one. */
  payout: PayoutDestination;
}

export type CreateConversionParams =
  | CreateCryptoIssueParams
  | CreateCryptoRedeemParams
  | CreateFiatIssueParams
  | CreateFiatRedeemParams;

export interface ListConversionsParams extends ListParams {
  status?: ConversionStatus;
  type?: ConversionType;
}

export interface QuoteParams {
  type: 'crypto-issue' | 'crypto-redeem';
  chain: ChainInput;
  pair: Pair;
  /** Pair token amount for crypto-issue, ENSC amount for crypto-redeem. */
  amount: string;
}

export interface ReportEventParams {
  txHash?: string;
  error?: string;
  idempotencyKey?: string;
}

export class ConversionEventsResource {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  #post(
    reference: string,
    event: 'onchain_submitted' | 'onchain_confirmed' | 'failed',
    params: ReportEventParams,
  ) {
    const { idempotencyKey, ...rest } = params;
    return this.#http.request<Conversion>({
      method: 'POST',
      path: `/v1/conversions/${encodeURIComponent(reference)}/events`,
      body: { event, ...rest },
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
  }

  /** The signed transaction was broadcast. */
  submitted(
    reference: string,
    txHash: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<Conversion> {
    return this.#post(reference, 'onchain_submitted', { txHash, ...opts });
  }

  /**
   * The transaction was mined. The API verifies the receipt (status, ENSC
   * movement, converter event, reference) and settles the conversion.
   */
  confirmed(
    reference: string,
    txHash: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<Conversion> {
    return this.#post(reference, 'onchain_confirmed', { txHash, ...opts });
  }

  /**
   * The wallet did not, or could not, send the transaction. `failed` is
   * final, so the API accepts it only once no transaction can still settle the
   * conversion. A conversion with no voucher yet is closed at once. Otherwise
   * it throws `ENSC_INVALID_STATE` (409) and `details.reason` says what to do:
   *
   * - `voucher_live`: the voucher can still be executed. Wait
   *   `details.retryAfterSeconds` seconds and call `failed` again; until then
   *   the conversion is pending, not failed.
   * - `voucher_used`: the voucher was executed on chain. Report that
   *   transaction with `confirmed(reference, txHash)` instead.
   * - `payment_received`: a `fiat-issue` whose payment has arrived. Ask for
   *   a new voucher with `conversions.voucher(reference)`.
   */
  failed(
    reference: string,
    error?: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<Conversion> {
    return this.#post(reference, 'failed', { ...(error !== undefined ? { error } : {}), ...opts });
  }
}

export class ConversionsResource {
  readonly #http: HttpClient;
  /** Report what happened to the transaction you signed. */
  readonly events: ConversionEventsResource;

  constructor(http: HttpClient) {
    this.#http = http;
    this.events = new ConversionEventsResource(http);
  }

  /**
   * Create a conversion. Returns the conversion with its voucher (crypto legs,
   * fiat-redeem) or bank-transfer instructions (fiat-issue). A conversion on a
   * transaction-screening hold comes back with `status: 'screening_hold'`;
   * poll `screening` or `get`, then call `voucher` once approved. A crypto
   * leg can also be held with `screening.status` `travel_rule_pending` or
   * `wallet_ownership_unproven`: create again with the same reference and
   * `counterparty.walletProof`, or call `voucher` once the check completes.
   */
  create(params: CreateConversionParams): Promise<Conversion> {
    const { idempotencyKey, ...rest } = params;
    return this.#http.request<Conversion>({
      method: 'POST',
      path: '/v1/conversions',
      body: rest,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
  }

  get(reference: string): Promise<Conversion> {
    return this.#http.request<Conversion>({
      method: 'GET',
      path: `/v1/conversions/${encodeURIComponent(reference)}`,
    });
  }

  list(params: ListConversionsParams = {}): Promise<api.ListConversionsResponse> {
    return this.#http.request<api.ListConversionsResponse>({
      method: 'GET',
      path: '/v1/conversions',
      query: {
        limit: params.limit,
        cursor: params.cursor,
        status: params.status,
        type: params.type,
      },
    });
  }

  /** Indicative quote for a crypto leg, priced by the converter contract. */
  quote(params: QuoteParams): Promise<QuoteResponse> {
    return this.#http.request<QuoteResponse>({
      method: 'GET',
      path: '/v1/conversions/quote',
      query: { type: params.type, chain: params.chain, pair: params.pair, amount: params.amount },
    });
  }

  /** Transaction screening status for a reference. */
  screening(reference: string): Promise<ScreeningStatusResponse> {
    return this.#http.request<ScreeningStatusResponse>({
      method: 'GET',
      path: '/v1/conversions/screening',
      query: { reference },
    });
  }

  /**
   * Issue or re-issue the voucher: after a screening hold is lifted, after a
   * fiat-issue bank transfer is confirmed, or when a voucher expired unused.
   */
  voucher(reference: string, opts: { idempotencyKey?: string } = {}): Promise<Conversion> {
    return this.#http.request<Conversion>({
      method: 'POST',
      path: `/v1/conversions/${encodeURIComponent(reference)}/voucher`,
      body: {},
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
  }

  /** Retry a fiat-redeem payout that is waiting to be initiated. */
  payout(reference: string, opts: { idempotencyKey?: string } = {}): Promise<Conversion> {
    return this.#http.request<Conversion>({
      method: 'POST',
      path: `/v1/conversions/${encodeURIComponent(reference)}/payout`,
      body: {},
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
  }
}
