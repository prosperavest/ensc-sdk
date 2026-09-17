/**
 * API keys, `/v1/api-keys`.
 *
 * Read-only from the SDK. Issuing, rotating and revoking API keys, and editing
 * the IP allowlist, are dashboard-only operations: the API gates those writes
 * to the dashboard's signed-in sessions and answers `ENSC_DASHBOARD_ONLY` (403) to
 * anything else, so the SDK does not expose them. Manage keys at
 * https://app.prosperavest.com.
 */

import type * as api from '@ensc/api-schemas';
import type { HttpClient, ListByEnvParams } from '../http.js';

export class ApiKeysResource {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** List API keys (cursor-paginated). Key material is never returned. */
  list(params: ListByEnvParams = {}): Promise<api.ListApiKeysResponse> {
    return this.#http.request<api.ListApiKeysResponse>({
      method: 'GET',
      path: '/v1/api-keys',
      query: { limit: params.limit, cursor: params.cursor, env: params.env },
    });
  }
}
