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
import type { ChainInput, Pair } from '../chains.js';
import type { HttpClient, ListParams } from '../http.js';

export type ConversionType = api.ConversionType;
export type ConversionStatus = api.ConversionStatus;
export type Conversion = api.Conversion;
export type IssuedVoucher = api.IssuedVoucher;
export type PaymentInstructions = api.PaymentInstructions;
export type QuoteResponse = api.QuoteResponse;
export type ScreeningStatusResponse = api.ScreeningStatusResponse;

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

export interface ScreeningCounterparty {
  type?: 'individual' | 'company';
  name?: string;
  wallet?: string;
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

  /** The wallet did not, or could not, send the transaction. */
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
   * poll `screening` or `get`, then call `voucher` once approved.
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
