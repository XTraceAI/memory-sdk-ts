// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import Xtraceai from '@xtraceai/memory';

const client = new Xtraceai({
  apiKey: 'My API Key',
  orgID: 'My Org ID',
  baseURL: process.env['TEST_API_BASE_URL'] ?? 'http://127.0.0.1:4010',
});

describe('resource memories', () => {
  test('retrieve', async () => {
    const responsePromise = client.memories.retrieve('memory_id');
    const rawResponse = await responsePromise.asResponse();
    expect(rawResponse).toBeInstanceOf(Response);
    const response = await responsePromise;
    expect(response).not.toBeInstanceOf(Response);
    const dataAndResponse = await responsePromise.withResponse();
    expect(dataAndResponse.data).toBe(response);
    expect(dataAndResponse.response).toBe(rawResponse);
  });

  test('update', async () => {
    const responsePromise = client.memories.update('memory_id', {});
    const rawResponse = await responsePromise.asResponse();
    expect(rawResponse).toBeInstanceOf(Response);
    const response = await responsePromise;
    expect(response).not.toBeInstanceOf(Response);
    const dataAndResponse = await responsePromise.withResponse();
    expect(dataAndResponse.data).toBe(response);
    expect(dataAndResponse.response).toBe(rawResponse);
  });

  test('list', async () => {
    const responsePromise = client.memories.list();
    const rawResponse = await responsePromise.asResponse();
    expect(rawResponse).toBeInstanceOf(Response);
    const response = await responsePromise;
    expect(response).not.toBeInstanceOf(Response);
    const dataAndResponse = await responsePromise.withResponse();
    expect(dataAndResponse.data).toBe(response);
    expect(dataAndResponse.response).toBe(rawResponse);
  });

  test('list: request options and params are passed correctly', async () => {
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
    ).rejects.toThrow(Xtraceai.NotFoundError);
  });

  test('delete', async () => {
    const responsePromise = client.memories.delete('memory_id');
    const rawResponse = await responsePromise.asResponse();
    expect(rawResponse).toBeInstanceOf(Response);
    const response = await responsePromise;
    expect(response).not.toBeInstanceOf(Response);
    const dataAndResponse = await responsePromise.withResponse();
    expect(dataAndResponse.data).toBe(response);
    expect(dataAndResponse.response).toBe(rawResponse);
  });

  test('ingest: only required params', async () => {
    const responsePromise = client.memories.ingest({
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

  test('ingest: required and optional params', async () => {
    const response = await client.memories.ingest({
      conv_id: 'conv-2026-05-15-abc',
      messages: [
        {
          content: 'I like Thai food and spicy dishes.',
          role: 'user',
          date: '2019-12-27T18:11:19.117Z',
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

  test('search: only required params', async () => {
    const responsePromise = client.memories.search({ query: 'who likes thai food?' });
    const rawResponse = await responsePromise.asResponse();
    expect(rawResponse).toBeInstanceOf(Response);
    const response = await responsePromise;
    expect(response).not.toBeInstanceOf(Response);
    const dataAndResponse = await responsePromise.withResponse();
    expect(dataAndResponse.data).toBe(response);
    expect(dataAndResponse.response).toBe(rawResponse);
  });

  test('search: required and optional params', async () => {
    const response = await client.memories.search({
      query: 'who likes thai food?',
      cursor: 'cursor',
      filters: { user_id: 'bar' },
      include: ['full_content'],
      limit: 1,
    });
  });
});
