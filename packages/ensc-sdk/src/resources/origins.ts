/**
 * Allowed origins, `/v1/origins`.
 *
 * Per-merchant CORS allowlist for browser-originated calls made with a
 * publishable (`pk`) key. Read-only from the SDK: adding and removing origins
 * are dashboard-only writes (`ENSC_DASHBOARD_ONLY` otherwise).
 */

import type * as api from '@ensc/api-schemas';
import type { HttpClient, ListByEnvParams } from '../http.js';

export class OriginsResource {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** List allowed origins (cursor-paginated). */
  list(params: ListByEnvParams = {}): Promise<api.ListAllowedOriginsResponse> {
    return this.#http.request<api.ListAllowedOriginsResponse>({
      method: 'GET',
      path: '/v1/origins',
      query: { limit: params.limit, cursor: params.cursor, env: params.env },
    });
  }
}
