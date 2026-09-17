/**
 * Events - `/v1/events`.
 *
 * The merchant-visible log of webhook events ENSC has generated, with per-event
 * delivery history. Read-only.
 */

import type { HttpClient, ListParams } from '../http.js';

export type EventEnv = 'test' | 'live';

/**
 * The status of an event in the outbox: `created` (not yet picked up),
 * `in_flight` (being delivered), `dispatched` (every subscribed endpoint got
 * its first attempt; retries continue per delivery) or `abandoned` (no
 * endpoint subscribed).
 */
export type EventOutboxStatus =
  | 'created'
  | 'in_flight'
  | 'dispatched'
  | 'abandoned'
  | (string & {});

export interface EventSummary {
  id: string;
  env: EventEnv;
  eventType: string;
  apiVersion: string;
  status: EventOutboxStatus;
  createdAt: number;
  dispatchedAt: number | null;
  payload: unknown;
}

/**
 * One delivery attempt. `status` is `pending` (row written, POST not yet
 * made), `delivered` (2xx), `failed` (retry scheduled at `nextAttemptAt`) or
 * `gave_up` (no more retries).
 */
export interface EventDelivery {
  id: string;
  endpointId: string;
  status: 'pending' | 'delivered' | 'failed' | 'gave_up' | (string & {});
  /** HTTP status your endpoint answered, or null when no answer arrived. */
  responseStatus: number | null;
  attempt: number;
  deliveredAt: number | null;
  nextAttemptAt: number | null;
  createdAt: number;
  /** First 500 characters of your endpoint's response body, or the transport error. */
  responseSnippet: string | null;
}

/** A single event with its full delivery history. */
export interface EventDetail extends EventSummary {
  deliveries: EventDelivery[];
}

export interface ListEventsResponse {
  events: EventSummary[];
  pagination: { nextCursor: string | null; hasMore: boolean };
}

export interface ListEventsParams extends ListParams {
  env?: EventEnv;
  /** Filter by event type, e.g. `conversion.succeeded`. */
  type?: string;
}

export class EventsResource {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** List events (cursor-paginated), optionally filtered by env and type. */
  list(params: ListEventsParams = {}): Promise<ListEventsResponse> {
    return this.#http.request<ListEventsResponse>({
      method: 'GET',
      path: '/v1/events',
      query: {
        limit: params.limit,
        cursor: params.cursor,
        env: params.env,
        type: params.type,
      },
    });
  }

  /** Fetch a single event by id, including its delivery attempts. */
  get(id: string): Promise<EventDetail> {
    return this.#http.request<EventDetail>({
      method: 'GET',
      path: `/v1/events/${encodeURIComponent(id)}`,
    });
  }
}
