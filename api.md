# Memories

Types:

- <code><a href="./src/resources/memories.ts">Artifact</a></code>
- <code><a href="./src/resources/memories.ts">Episode</a></code>
- <code><a href="./src/resources/memories.ts">Fact</a></code>
- <code><a href="./src/resources/memories.ts">MemoryItem</a></code>
- <code><a href="./src/resources/memories.ts">MemoryListResponse</a></code>
- <code><a href="./src/resources/memories.ts">MemoryDeleteResponse</a></code>
- <code><a href="./src/resources/memories.ts">MemoryAddResponse</a></code>
- <code><a href="./src/resources/memories.ts">MemorySearchResponse</a></code>

Methods:

- <code title="get /v1/memories/{memory_id}/">client.memories.<a href="./src/resources/memories.ts">retrieve</a>(memoryID) -> MemoryItem</code>
- <code title="patch /v1/memories/{memory_id}/">client.memories.<a href="./src/resources/memories.ts">update</a>(memoryID, { ...params }) -> MemoryItem</code>
- <code title="post /v1/memories/">client.memories.<a href="./src/resources/memories.ts">list</a>({ ...params }) -> MemoryListResponse</code>
- <code title="delete /v1/memories/{memory_id}/">client.memories.<a href="./src/resources/memories.ts">delete</a>(memoryID) -> unknown</code>
- <code title="post /v1/memories/add/">client.memories.<a href="./src/resources/memories.ts">add</a>({ ...params }) -> MemoryAddResponse</code>
- <code title="post /v1/memories/search/">client.memories.<a href="./src/resources/memories.ts">search</a>({ ...params }) -> MemorySearchResponse</code>
