/**
 * Transfer: `/v1/transfer`.
 *
 * Builds an unsigned ENSC `transfer` for the merchant's wallet to sign and
 * broadcast. ENSC never signs or broadcasts. See `@ensc/sdk/web3` for an
 * optional signer.
 */

import type * as api from '@ensc/api-schemas';
import type { ChainInput } from '../chains.js';
import type { HttpClient } from '../http.js';

export interface TransferParams {
  /** Sender EVM address (the wallet that will sign). */
  from: string;
  /** Recipient EVM address. */
  recipient: string;
  /** Amount of ENSC as a decimal string, e.g. "150.25". */
  amount: string;
  chain: ChainInput;
  clientReference?: string;
  idempotencyKey?: string;
}

export class TransferResource {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Build a transfer. Returns the `unsignedTransaction` to sign. */
  create(params: TransferParams): Promise<api.TransferResponse> {
    const { idempotencyKey, ...rest } = params;
    return this.#http.request<api.TransferResponse>({
      method: 'POST',
      path: '/v1/transfer',
      body: { ...rest, asset: 'ENSC' },
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
  }
}
