/**
 * Signing keys, `/v1/signing-keys`.
 *
 * Signing keys are issued by the dashboard. You receive `signingKeyId` and the
 * private key once (at onboarding, or when you rotate from the dashboard's
 * Signing Keys tab), then pass them to `EnscClient`.
 *
 * Read-only from the SDK. Registering, rotating and revoking signing keys are
 * dashboard-only writes (`ENSC_DASHBOARD_ONLY` otherwise). Rotation keeps the
 * previous key usable for 24 hours so a deployment can roll without downtime.
 */

import type * as api from '@ensc/api-schemas';
import type { HttpClient, ListByEnvParams } from '../http.js';

/** One entry in the signing-keys list. */
export interface SigningKeySummary {
  id: string;
  env: api.RegisterSigningKeyResponse['env'];
  publicKey: string;
  name: string | null;
  status: 'active' | 'rotated' | 'revoked';
  /** Unix seconds after which a `rotated` key stops working; null otherwise. */
  expiresAt: number | null;
  createdAt: number;
}

export interface ListSigningKeysResponse {
  keys: SigningKeySummary[];
  pagination: api.Pagination;
}

export class SigningKeysResource {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** List registered signing keys (cursor-paginated). */
  list(params: ListByEnvParams = {}): Promise<ListSigningKeysResponse> {
    return this.#http.request<ListSigningKeysResponse>({
      method: 'GET',
      path: '/v1/signing-keys',
      query: { limit: params.limit, cursor: params.cursor, env: params.env },
    });
  }
}
