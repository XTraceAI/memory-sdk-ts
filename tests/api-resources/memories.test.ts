// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import XtraceMemoryManager from 'xtrace-memory-manager';

const client = new XtraceMemoryManager({
  apiKey: 'My API Key',
  orgID: 'My Org ID',
  baseURL: process.env['TEST_API_BASE_URL'] ?? 'http://127.0.0.1:4010',
});

describe('resource memories', () => {
  // Mock server tests are disabled
  test.skip('create: only required params', async () => {
    const responsePromise = client.memories.create({
      conv_id: 'conv-2026-05-15-abc',
      messages: [{ content: 'I like Thai food and spicy dishes.', role: 'user' }],
      user_id: 'alice',
    });
    const rawResponse = await responsePromise.asResponse();
    expect(rawResponse).toBeInstanceOf(Response);
    const response = await responsePromise;
    expect(response).not.toBeInstanceOf(Response);
    const dataAndResponse = await responsePromise.withResponse();
    expect(dataAndResponse.data).toBe(response);
    expect(dataAndResponse.response).toBe(rawResponse);
  });

  // Mock server tests are disabled
  test.skip('create: required and optional params', async () => {
    const response = await client.memories.create({
      conv_id: 'conv-2026-05-15-abc',
      messages: [
        {
          content: 'I like Thai food and spicy dishes.',
          role: 'user',
          date: {},
          dia_id: 'dia_id',
        },
      ],
      user_id: 'alice',
      wait: true,
      agent_id: 'agent_id',
      app_id: 'app_id',
      extract_artifacts: true,
      metadata: { foo: 'bar' },
    });
  });

  // Mock server tests are disabled
  test.skip('list', async () => {
    const responsePromise = client.memories.list();
    const rawResponse = await responsePromise.asResponse();
    expect(rawResponse).toBeInstanceOf(Response);
    const response = await responsePromise;
    expect(response).not.toBeInstanceOf(Response);
    const dataAndResponse = await responsePromise.withResponse();
    expect(dataAndResponse.data).toBe(response);
    expect(dataAndResponse.response).toBe(rawResponse);
  });

  // Mock server tests are disabled
  test.skip('list: request options and params are passed correctly', async () => {
    // ensure the request options are being passed correctly by passing an invalid HTTP method in order to cause an error
    await expect(
      client.memories.list(
        {
          agent_id: 'agent_id',
          app_id: 'app_id',
          conv_id: 'conv_id',
          cursor: 'cursor',
          include: 'include',
          limit: 1,
          order: 'created_at_desc',
          type: 'fact',
          user_id: 'user_id',
        },
        { path: '/_stainless_unknown_path' },
      ),
    ).rejects.toThrow(XtraceMemoryManager.NotFoundError);
  });

  // Mock server tests are disabled
  test.skip('getJobStatus', async () => {
    const responsePromise = client.memories.getJobStatus('job_id');
    const rawResponse = await responsePromise.asResponse();
    expect(rawResponse).toBeInstanceOf(Response);
    const response = await responsePromise;
    expect(response).not.toBeInstanceOf(Response);
    const dataAndResponse = await responsePromise.withResponse();
    expect(dataAndResponse.data).toBe(response);
    expect(dataAndResponse.response).toBe(rawResponse);
  });

  // Mock server tests are disabled
  test.skip('search: only required params', async () => {
    const responsePromise = client.memories.search({ query: 'who likes thai food?' });
    const rawResponse = await responsePromise.asResponse();
    expect(rawResponse).toBeInstanceOf(Response);
    const response = await responsePromise;
    expect(response).not.toBeInstanceOf(Response);
    const dataAndResponse = await responsePromise.withResponse();
    expect(dataAndResponse.data).toBe(response);
    expect(dataAndResponse.response).toBe(rawResponse);
  });

  // Mock server tests are disabled
  test.skip('search: required and optional params', async () => {
    const response = await client.memories.search({
      query: 'who likes thai food?',
      cursor: 'cursor',
      filters: { user_id: 'bar' },
      include: ['full_content'],
      limit: 1,
    });
  });
});
