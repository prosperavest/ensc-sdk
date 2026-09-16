/**
 * Webhook endpoints - `/v1/webhook-endpoints`.
 *
 * Register URLs that ENSC delivers signed event payloads to. Verify inbound
 * deliveries with `EnscClient.verifyWebhookSignature(...)`.
 */

import type { HttpClient, ListParams } from '../http.js';

export type WebhookEnv = 'test' | 'live';
export type WebhookEndpointStatus = 'active' | 'disabled';

export interface CreateWebhookEndpointParams {
  env: WebhookEnv;
  /** Destination URL ENSC POSTs events to. */
  url: string;
  description?: string;
  /** Event types this endpoint subscribes to (1–64 entries). */
  eventTypes: string[];
  /** Optional API version to pin deliveries to. */
  apiVersion?: string;
}

export interface UpdateWebhookEndpointParams {
  url?: string;
  description?: string;
  eventTypes?: string[];
  status?: WebhookEndpointStatus;
}

/**
 * Created endpoint. Deliveries are signed with ENSC's Ed25519 key (ENSC-WH-V1);
 * verify them with `EnscClient.verifyWebhookSignature` against the public keys
 * document. No per-endpoint secret is issued.
 */
export interface CreateWebhookEndpointResponse {
  id: string;
  env: WebhookEnv;
  url: string;
  description: string | null;
  eventTypes: string[];
  status: 'active';
  createdAt: number;
}

export interface WebhookEndpoint {
  id: string;
  env: WebhookEnv;
  url: string;
  description: string | null;
  eventTypes: string[];
  status: WebhookEndpointStatus;
  createdAt: number;
}

export interface ListWebhookEndpointsResponse {
  endpoints: WebhookEndpoint[];
  pagination: { nextCursor: string | null; hasMore: boolean };
}

export interface UpdateWebhookEndpointResponse {
  id: string;
  /** Names of the fields that were changed. */
  updated: string[];
}

export interface RemoveWebhookEndpointResponse {
  id: string;
  deleted: true;
}

export interface SendTestEventParams {
  /** Event type to synthesize. Defaults server-side to `synthetic.test_event`. */
  eventType?: string;
  /** Arbitrary payload to include in the test event. */
  payload?: Record<string, unknown>;
}

export interface ListWebhookEndpointsParams extends ListParams {
  env?: WebhookEnv;
}

export class WebhookEndpointsResource {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Register a webhook endpoint. The `secret` in the response is shown once. */
  create(params: CreateWebhookEndpointParams): Promise<CreateWebhookEndpointResponse> {
    return this.#http.request<CreateWebhookEndpointResponse>({
      method: 'POST',
      path: '/v1/webhook-endpoints',
      body: params,
    });
  }

  /** List webhook endpoints (cursor-paginated). */
  list(params: ListWebhookEndpointsParams = {}): Promise<ListWebhookEndpointsResponse> {
    return this.#http.request<ListWebhookEndpointsResponse>({
      method: 'GET',
      path: '/v1/webhook-endpoints',
      query: { limit: params.limit, cursor: params.cursor, env: params.env },
    });
  }

  /** Fetch a single webhook endpoint by id. */
  get(id: string): Promise<WebhookEndpoint> {
    return this.#http.request<WebhookEndpoint>({
      method: 'GET',
      path: `/v1/webhook-endpoints/${encodeURIComponent(id)}`,
    });
  }

  /** Update a webhook endpoint's URL, description, subscribed events, or status. */
  update(id: string, params: UpdateWebhookEndpointParams): Promise<UpdateWebhookEndpointResponse> {
    return this.#http.request<UpdateWebhookEndpointResponse>({
      method: 'PATCH',
      path: `/v1/webhook-endpoints/${encodeURIComponent(id)}`,
      body: params,
    });
  }

  /** Delete a webhook endpoint. */
  remove(id: string): Promise<RemoveWebhookEndpointResponse> {
    return this.#http.request<RemoveWebhookEndpointResponse>({
      method: 'DELETE',
      path: `/v1/webhook-endpoints/${encodeURIComponent(id)}`,
    });
  }

  /** Send a synthetic test event to an endpoint to verify the integration. */
  sendTest(id: string, params: SendTestEventParams = {}): Promise<unknown> {
    return this.#http.request<unknown>({
      method: 'POST',
      path: `/v1/webhook-endpoints/${encodeURIComponent(id)}/test`,
      body: params,
    });
  }
}
