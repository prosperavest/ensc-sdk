/**
 * Banks: `/v1/banks`.
 *
 * Nigerian banks the payment rail of the key's environment can pay out to.
 * Read-only; needs only the API key. Cached server-side for one hour.
 */

import type * as api from '@ensc/api-schemas';
import type { HttpClient } from '../http.js';

export class BanksResource {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  list(): Promise<api.BanksResponse> {
    return this.#http.request<api.BanksResponse>({ method: 'GET', path: '/v1/banks' });
  }
}
