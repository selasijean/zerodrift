# Sync Engine — Architecture Overview

This is a real-time collaborative data sync engine. Think of it as a client-side database that stays automatically in sync with a server and with all other connected clients, while also persisting locally so the app survives page refreshes and works offline.

The engine is a publishable npm package at `packages/sync-engine`. All source files live under `packages/sync-engine/src/`. When file paths appear in these docs as `core/X.ts` or `react/X.ts`, they are relative to `packages/sync-engine/src/`.

## The Four Pillars

```
┌─────────────────────────────────────────────────────────┐
│           React Components  /  Headless Agents           │
│   useRecords / useRecord / useRelation / model.watch()   │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│                   ObjectPool (in-memory)                 │
│  Map<modelName, Map<id, instance>>                       │
│  All hydrated model instances live here                  │
│  Fires pub/sub events → React re-renders / agent hooks  │
└──────┬──────────────────────────────────────┬───────────┘
       │                                      │
┌──────▼──────────────┐          ┌────────────▼──────────┐
│  TransactionQueue   │          │   SyncConnection      │
│  User edits →       │          │   SSE stream from     │
│  HTTP POST to server│          │   server → applies    │
│  Undo/redo stack    │          │   delta packets       │
└──────┬──────────────┘          └────────────┬──────────┘
                                              │
                                 ┌────────────▼──────────┐
                                 │   ModelStream(s)      │
                                 │   Secondary SSE from  │
                                 │   external services   │
                                 │   (e.g. calc engines) │
                                 └────────────┬──────────┘
       │                                      │
┌──────▼──────────────────────────────────────▼──────────┐
│              StorageAdapter (pluggable)                  │
│  Database   → IndexedDB (browser default)               │
│  MemoryAdapter → in-memory Map (Node.js / agents)       │
└─────────────────────────────────────────────────────────┘
```

## The Major Components

All files are under `packages/sync-engine/src/`.

| Component | File | One-line role |
|---|---|---|
| `ModelRegistry` | `core/ModelRegistry.ts` | Stores metadata for every model class (properties, types, relationships) |
| `ObjectPool` | `core/ObjectPool.ts` | In-memory cache of all live instances; drives React reactivity and agent subscriptions |
| `BaseModel` | `core/BaseModel.ts` | Base class all models extend; hydration, change tracking, lazy collections, `watch()` |
| Decorators | `core/decorators.ts` | The language you use to define models (`@Property`, `@Reference`, etc.) |
| Observability | `core/observability.ts` | MobX box wiring — creates observable getters/setters for `@Property` fields |
| `StorageAdapter` | `core/Database.ts` | Interface for pluggable storage backends |
| `Database` | `core/Database.ts` | `StorageAdapter` backed by IndexedDB; handles schema migration and persistence |
| `MemoryAdapter` | `core/MemoryAdapter.ts` | `StorageAdapter` backed by in-memory Maps; for Node.js agents and headless use |
| `Store` (Full/Partial) | `core/Store.ts` | Per-model bootstrap loader — instant vs on-demand loading |
| `LazyCollection` types | `core/LazyCollection.ts` | Deferred one-to-many relationships; only load data when accessed |
| `TransactionQueue` | `core/TransactionQueue.ts` | Batches user edits, sends to server, manages undo/redo |
| `SyncConnection` | `core/SyncConnection.ts` | Listens to SSE stream; processes and applies delta packets; accepts custom `sseClientFactory` |
| `BaseSSEConnection` | `core/BaseSSEConnection.ts` | Abstract base class for SSE connections with reconnect, lifecycle hooks (`onOpen`/`onClose`) |
| `ModelStream` | `core/ModelStream.ts` | Secondary SSE connection for external services; updates existing pool models in-place, never inserts new ones |
| `EphemeralStore` | `core/Store.ts` | No-op store for `Ephemeral` models — skips all IDB loading |
| `StoreManager` | `core/StoreManager.ts` | Top-level orchestrator; wires everything together |
| React hooks | `react/index.tsx` | `useRecords`, `useRecord`, `useRecordsByIndex`, `useRelation`, `useUndoRedo` |

## The Data Flow

### Writing (user or agent makes a change)

1. Code sets a property: `issue.title = "New Title"`
2. The setter records the old value for undo
3. `issue.save()` creates an `UpdateTransaction` and enqueues it
4. `TransactionQueue` debounces 50ms, then HTTP POSTs to the server
5. Server processes it and returns an ACK with a `syncId`
6. Transaction moves to `CompletedButUnsynced`
7. Server broadcasts the change to all clients via SSE
8. When the SSE delta arrives with matching `syncId`, transaction is fully `Completed`

### Reading (delta arrives from server)

1. `SyncConnection` receives SSE message, parses delta packet
2. Writes the new data to the `StorageAdapter` (durable first)
3. Updates the model instance in the ObjectPool
4. ObjectPool fires subscribers for that model type
5. React: `useSyncExternalStore` sees the snapshot changed → component re-renders
   Agent: `objectPool.subscribe` callback fires → agent reacts

## Lifecycle of the StoreManager

```
bootstrap()
  │
  ├─ 1. Create FullStore/PartialStore per model type
  ├─ 2. Connect to StorageAdapter (Database runs IDB migration; MemoryAdapter is a no-op)
  ├─ 3. Determine bootstrap type: Full / Partial / Local
  │       Full    → no local cache, fetch everything from server
  │       Partial → has local cache, fetch only delta since lastSyncId
  │       Local   → offline, use cache only
  ├─ 4. Load data (two-phase: critical models first, deferred in background)
  ├─ 5. Open SSE connection (via sseClientFactory — browser EventSource or Node.js eventsource)
  ├─ 6. Open ModelStream connections (if `modelStreams` configured)
  └─ 7. Signal Ready → UI renders / agent begins work
```

## Environments

The engine runs anywhere TypeScript runs. Two seams make it portable:

| Seam | Browser default | Node.js / agent |
|---|---|---|
| `storageAdapter` | `new Database(workspaceId)` (IndexedDB) | `new MemoryAdapter()` or custom |
| `sseClientFactory` | built-in `EventSource` | `eventsource` npm package |

See [09-headless-and-agents.md](./09-headless-and-agents.md) for the full headless usage guide.

## Reading Order for These Docs

1. **[01-models-and-decorators.md](./01-models-and-decorators.md)** — How models are defined and what the decorators do
2. **[02-object-pool.md](./02-object-pool.md)** — The in-memory store: benefits, drawbacks, memory trade-offs
3. **[03-indexeddb-and-persistence.md](./03-indexeddb-and-persistence.md)** — Local persistence, schema migration, bootstrap types
4. **[04-lazy-loading.md](./04-lazy-loading.md)** — How lazy collections work and why they matter for heap size
5. **[05-sync-groups.md](./05-sync-groups.md)** — What sync groups are and how they partition data subscriptions
6. **[06-transactions-and-undo.md](./06-transactions-and-undo.md)** — Transaction lifecycle, batching, undo/redo, offline resilience
7. **[07-realtime-sync.md](./07-realtime-sync.md)** — SSE connection, delta packets, conflict rebase, cascade delete
8. **[08-react-integration.md](./08-react-integration.md)** — How the engine plugs into React
9. **[09-headless-and-agents.md](./09-headless-and-agents.md)** — Running the engine outside the browser: agents, Node.js, reactivity without React
10. **[10-inverse-links-and-reactivity.md](./10-inverse-links-and-reactivity.md)** — How parent collections and `@Reference` getters stay reactive to pool changes automatically
