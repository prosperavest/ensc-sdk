/**
 * Accounts: `/v1/accounts/resolve`.
 *
 * Bank account name enquiry. Call it before a fiat-redeem so the account name
 * you submit matches the bank record; the API refuses a mismatch.
 */

import type * as api from '@ensc/api-schemas';
import type { HttpClient } from '../http.js';

export interface ResolveAccountParams {
  /** Bank code from `banks.list()`. */
  bankCode: string;
  /** 10-digit NUBAN. */
  accountNumber: string;
  idempotencyKey?: string;
}

export class AccountsResource {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  resolve(params: ResolveAccountParams): Promise<api.ResolveAccountResponse> {
    const { idempotencyKey, ...rest } = params;
    return this.#http.request<api.ResolveAccountResponse>({
      method: 'POST',
      path: '/v1/accounts/resolve',
      body: rest,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
  }
}
