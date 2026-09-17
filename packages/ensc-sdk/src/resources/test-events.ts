/**
 * Test events - `/v1/test-data/events`.
 *
 * Sandbox-only: emit an event of any type into your test event stream, in the
 * shape a real event of that type carries, so every subscribed test endpoint
 * receives a signed delivery. `list()` returns the catalogue with a sample
 * payload per type. To target one endpoint, use `webhookEndpoints.sendTest`.
 */

import type { HttpClient } from '../http.js';

export interface TestEventTemplate {
  eventType: string;
  samplePayload: Record<string, unknown>;
}

export interface ListTestEventsResponse {
  supported: TestEventTemplate[];
}

export interface EmitTestEventParams {
  /** Any event type. The catalogue types get a realistic payload; others a generic one. */
  eventType: string;
  /** Fields merged over the default payload. */
  overrides?: Record<string, unknown>;
}

export interface EmitTestEventResponse {
  eventId: string;
  eventType: string;
  env: 'test';
  payload: Record<string, unknown>;
  scheduled: boolean;
  supportedEvents: string[];
}

export class TestEventsResource {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** The event types with a built-in template, each with a sample payload. */
  list(): Promise<ListTestEventsResponse> {
    return this.#http.request<ListTestEventsResponse>({
      method: 'GET',
      path: '/v1/test-data/events',
    });
  }

  /** Emit a synthetic event into the test stream. Any key may call it; the event is always a Sandbox event. */
  emit(params: EmitTestEventParams): Promise<EmitTestEventResponse> {
    return this.#http.request<EmitTestEventResponse>({
      method: 'POST',
      path: '/v1/test-data/events',
      body: params,
    });
  }
}
