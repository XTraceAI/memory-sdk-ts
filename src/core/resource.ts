// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import type { XtraceMemoryManager } from '../client';

export abstract class APIResource {
  protected _client: XtraceMemoryManager;

  constructor(client: XtraceMemoryManager) {
    this._client = client;
  }
}
