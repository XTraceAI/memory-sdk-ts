# Memories

Types:

- <code><a href="./src/resources/memories/memories.ts">MemoryRetrieveResponse</a></code>
- <code><a href="./src/resources/memories/memories.ts">MemoryUpdateResponse</a></code>
- <code><a href="./src/resources/memories/memories.ts">MemoryListResponse</a></code>
- <code><a href="./src/resources/memories/memories.ts">MemoryIngestResponse</a></code>
- <code><a href="./src/resources/memories/memories.ts">MemorySearchResponse</a></code>

Methods:

- <code title="get /v1/memories/{memory_id}">client.memories.<a href="./src/resources/memories/memories.ts">retrieve</a>(memoryID) -> MemoryRetrieveResponse</code>
- <code title="patch /v1/memories/{memory_id}">client.memories.<a href="./src/resources/memories/memories.ts">update</a>(memoryID, { ...params }) -> MemoryUpdateResponse</code>
- <code title="get /v1/memories">client.memories.<a href="./src/resources/memories/memories.ts">list</a>({ ...params }) -> MemoryListResponse</code>
- <code title="delete /v1/memories/{memory_id}">client.memories.<a href="./src/resources/memories/memories.ts">delete</a>(memoryID) -> void</code>
- <code title="post /v1/memories">client.memories.<a href="./src/resources/memories/memories.ts">ingest</a>({ ...params }) -> MemoryIngestResponse</code>
- <code title="post /v1/memories/search">client.memories.<a href="./src/resources/memories/memories.ts">search</a>({ ...params }) -> MemorySearchResponse</code>

## Jobs

Types:

- <code><a href="./src/resources/memories/jobs.ts">JobRetrieveResponse</a></code>

Methods:

- <code title="get /v1/memories/jobs/{job_id}">client.memories.jobs.<a href="./src/resources/memories/jobs.ts">retrieve</a>(jobID) -> JobRetrieveResponse</code>
