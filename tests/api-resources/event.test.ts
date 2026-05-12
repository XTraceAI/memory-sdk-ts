// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import XtraceMemoryManager from 'xtrace-memory-manager';

const client = new XtraceMemoryManager({
  apiKey: 'My API Key',
  bearerToken: 'My Bearer Token',
  orgID: 'My Org ID',
  baseURL: process.env['TEST_API_BASE_URL'] ?? 'http://127.0.0.1:4010',
});

describe('resource event', () => {
  // Mock server tests are disabled
  test.skip('retrieve', async () => {
    const responsePromise = client.event.retrieve('event_id');
    const rawResponse = await responsePromise.asResponse();
    expect(rawResponse).toBeInstanceOf(Response);
    const response = await responsePromise;
    expect(response).not.toBeInstanceOf(Response);
    const dataAndResponse = await responsePromise.withResponse();
    expect(dataAndResponse.data).toBe(response);
    expect(dataAndResponse.response).toBe(rawResponse);
  });
});
