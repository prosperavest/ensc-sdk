/**
 * Balance: `/v1/balance`.
 *
 * On-chain token balance for an account. Read-only; needs only the API key.
 */

import type * as api from '@ensc/api-schemas';
import type { Asset, ChainInput } from '../chains.js';
import type { HttpClient } from '../http.js';

/** A whitelisted asset symbol the balance endpoint accepts. */
export type BalanceAsset = Asset;

export interface GetBalanceParams {
  /** EVM address to read the balance of. */
  account: string;
  /** Chain to read from (must belong to the key's environment). */
  chain: ChainInput;
  /** Asset symbol; supply this or `contractAddress`. */
  asset?: BalanceAsset;
  /** Raw token contract address; supply this or `asset`. */
  contractAddress?: string;
}

export class BalanceResource {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /**
   * Get an account's token balance. Provide either `asset` (a whitelisted
   * symbol) or `contractAddress` (a raw token address).
   */
  get(params: GetBalanceParams): Promise<api.BalanceResponse> {
    return this.#http.request<api.BalanceResponse>({
      method: 'GET',
      path: '/v1/balance',
      query: {
        account: params.account,
        chain: params.chain,
        asset: params.asset,
        contractAddress: params.contractAddress,
      },
    });
  }
}
