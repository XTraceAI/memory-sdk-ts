// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class Event extends APIResource {
  /**
   * Event Status
   */
  retrieve(eventID: string, options?: RequestOptions): APIPromise<EventRetrieveResponse> {
    return this._client.get(path`/v1/event/${eventID}/`, {
      ...options,
      __security: { apiKeyHeaderAuth: true, orgIDAuth: true, bearerTokenAuth: true },
    });
  }
}

export interface EventRetrieveResponse {
  event_id: string;

  status: string;

  message?: string;

  result?: { [key: string]: unknown } | null;
}

export declare namespace Event {
  export { type EventRetrieveResponse as EventRetrieveResponse };
}
