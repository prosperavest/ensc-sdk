/**
 * Events - `/v1/events`.
 *
 * The merchant-visible log of webhook events ENSC has generated, with per-event
 * delivery history. Read-only.
 */

import type { HttpClient, ListParams } from '../http.js';

export type EventEnv = 'test' | 'live';

export interface EventSummary {
  id: string;
  env: EventEnv;
  eventType: string;
  status: string;
  createdAt: number;
  payload: unknown;
}

export interface EventDelivery {
  id: string;
  status: string;
  attempt: number;
  createdAt: number;
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
  /** Filter by event type, e.g. `payment_intent.succeeded`. */
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
