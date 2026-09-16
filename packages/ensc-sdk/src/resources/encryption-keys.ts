/**
 * Encryption keys, `/v1/encryption-keys`.
 *
 * The AES-256-GCM keys that encrypt request bodies (ENSC-ENC-V1). Issued,
 * rotated and revoked from the dashboard only; the SDK can list them so an
 * integration can confirm which `enc_…` id is active. Key material is never
 * returned by the API after issuance.
 */

import type * as api from '@ensc/api-schemas';
import type { HttpClient, ListParams } from '../http.js';

export class EncryptionKeysResource {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** List encryption keys (cursor-paginated). */
  list(params: ListParams = {}): Promise<api.ListEncryptionKeysResponse> {
    return this.#http.request<api.ListEncryptionKeysResponse>({
      method: 'GET',
      path: '/v1/encryption-keys',
      query: { limit: params.limit, cursor: params.cursor },
    });
  }
}
