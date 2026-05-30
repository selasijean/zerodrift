# Real-Time Sync

Real-time sync is handled by `SyncConnection` (`core/SyncConnection.ts`). It maintains an SSE (Server-Sent Events) connection, receives delta packets, and applies them to the ObjectPool and IndexedDB.

## Why SSE

SSE is a long-lived HTTP connection where the server pushes line-delimited text messages to the client. It's simpler than WebSockets for unidirectional server→client data, automatically reconnects, and works over standard HTTP/2. The client doesn't need to send data over the SSE connection — writes go over normal HTTP POST.

## The Connection

```typescript
connect() {
  // Always-subscribed (Eager + Ephemeral) ∪ models the adapter has rows for.
  const subscribed = [...new Set([
    ...ModelRegistry.alwaysSubscribedModelNames(),
    ...db.loadedModels,
  ])].sort();
  // Per-element encode so commas inside any ID/name (e.g. `"a,b"`)
  // become `%2C` and don't collide with the join separator.
  const groups = meta.subscribedSyncGroups.map(encodeURIComponent).join(",");
  const url = `${baseUrl}/stream?lastSyncId=${meta.lastSyncId}`
              + `&syncGroups=${groups}`
              + (subscribed.length > 0
                  ? `&onlyModels=${subscribed.map(encodeURIComponent).join(",")}`
                  : "");

  this.eventSource = new EventSource(url);

  this.eventSource.onmessage = (event) => {
    const action = JSON.parse(event.data);
    this.enqueuePacket({ syncActions: [action] });
  };

  this.eventSource.onerror = () => {
    this.eventSource.close();
    this.openEventSource(); // reconnect with fresh meta — picks up any new lastSyncId
  };
}
```

Three things worth noting:

1. **`lastSyncId` in the URL.** The server uses this to catch the client up. If the tab was in the background for 5 minutes and missed 200 deltas, the server sends all 200 before switching to live streaming.

2. **Manual reconnect on error.** The browser's built-in SSE reconnect reuses the original URL — stale `lastSyncId`. The engine closes and re-opens with a fresh URL read from `__meta`, which has the latest `lastSyncId` from the most recently processed packet.

3. **`onlyModels` filter.** The `StorageAdapter` tracks which models have at least one row locally — seeded on `connect()` and grown by `writeModels` / `clearModelStore`. The catchup URL sends the union of that set with `ModelRegistry.alwaysSubscribedModelNames()` (Eager + Ephemeral, which pre-subscribe even when the workspace happens to have zero rows for them) so the server skips deltas (catchup *and* live stream) only for models the client neither pre-subscribes to nor has touched. When the set transitions mid-session (first `getOrLoadCollection` for a Partial model, or a schema-migration clear), `StoreManager` debounces a reconnect via `setTimeout(0)` so consecutive awaited writes coalesce into one round-trip. If both sets are empty, the param is omitted and the server sends everything.

## Delta Packets

The unit of real-time sync is a `DeltaPacket`:

```typescript
interface DeltaPacket {
  syncId: number;      // monotonically increasing watermark for the packet
  syncActions: SyncAction[];
  addedSyncGroups?: string[];
  removedSyncGroups?: string[];
}

interface SyncAction {
  modelName: string;   // "Issue"
  modelId: string;     // "issue-abc123"
  action: "I" | "U" | "D" | "A" | "V" | "C";
  data?: Record<string, unknown>;
}
```

Action codes:
- `"I"` — Insert (new model)
- `"U"` — Update (field changes)
- `"D"` — Delete (permanent)
- `"A"` — Archive (soft delete)
- `"V"` — Validate (server confirms a client's optimistic write)
- `"C"` — Custom (app-specific operation)

Packets are processed **sequentially** — the engine queues incoming packets and processes one at a time. This prevents race conditions where two overlapping deltas could leave the pool in an inconsistent state.

## 7-Step Delta Processing

`processDeltaPacket` is the core of the sync engine. Every incoming packet goes through these steps:

**Step 1: Handle sync group changes**
If the packet adds or removes sync groups, update `__meta.subscribedSyncGroups` and trigger the appropriate data fetch or purge. See [05-sync-groups.md](./05-sync-groups.md).

**Step 2–3: (internal bookkeeping)**

**Step 4: Write to IndexedDB**
Before touching the in-memory pool, persist every action to IDB. This ensures durability — if the tab crashes after this point, the data is on disk.

```typescript
for (const action of packet.syncActions) {
  if (["I", "U", "V", "C"].includes(action.action)) {
    await db.writeModels(action.modelName, [{ id: action.modelId, ...action.data }]);
  } else if (["D", "A"].includes(action.action)) {
    await db.deleteModel(action.modelName, action.modelId);
  }
}
```

**Step 5: Apply to the ObjectPool**
For each action, call `applySyncAction()` — see details below.

**Step 6: Update `lastSyncId`**
The packet's `syncId` becomes the new `lastSyncId` in `__meta`. This is the watermark for future reconnects.

**Step 7: Resolve waiting transactions**
Any `TransactionQueue` entries in the `awaitingSync` state that were waiting for this sync ID are marked `Completed` and removed from IDB.

## Applying Sync Actions to the Pool

### Insert (`"I"`)

```
Is this model already in the pool?
  Yes → hydrate update (merge new data into existing instance)
  No  → should we load it? (based on LoadStrategy + sync groups)
        Yes → create instance, hydrate, pool.put()
        No  → skip (model is out of scope for this client)
```

After inserting, the engine rebases any pending `UpdateTransaction` for this model against the new data. The pool itself takes care of attaching the new instance to every parent's `@ReferenceCollection` / `@BackReference` inline — see [10-inverse-links-and-reactivity.md](./10-inverse-links-and-reactivity.md).

### Update (`"U"`, `"V"`, `"C"`)

1. Find the existing instance in the pool
2. Hydrate the update (apply new field values via `box.set` on each MobX observable)
3. Rebase any pending `UpdateTransaction` for this model against the new data

`BaseModel.hydrate` dispatches FK changes to the pool, which detaches the model from the old parent's collection and attaches to the new one — all in a single batched MobX action.

### Delete (`"D"`) and Archive (`"A"`)

1. Run cascade delete: find all models that reference this one with `onDelete: "cascade"` or via `@BackReference`, and delete them recursively
2. Handle `onDelete: "nullify"` references: set those ID fields to null on affected models
3. Remove from pool — the pool's `remove` detaches the instance from every parent collection and bumps its per-id atom so `@Reference` observers see `null` on next read

## Cascade Delete

When a model is deleted, `SyncConnection` walks the entire `ModelRegistry` looking for relationships that point at it:

```
Issue "issue-123" deleted
  │
  ├── Scan ModelRegistry for all models with @Reference("Issue")
  │     DocumentContent has @Reference("Issue", { onDelete: "cascade" })
  │     → delete all DocumentContent where issueId === "issue-123"
  │
  ├── Scan for @BackReference("Issue", ...)
  │     Favorite has @BackReference("Issue", "issueId")
  │     → delete Favorite where issueId === "issue-123"
  │
  └── Scan for @Reference("Issue", { onDelete: "nullify" })
      → set those fields to null on any affected models
```

This cascade runs **client-side** — the client applies it locally without waiting for the server to send individual delete packets for each child. The server should be consistent, but the client doesn't wait for it.

## Inverse-link Maintenance

Every `pool.put` / `pool.remove` walks a memoized cache of parent-side declarations and updates the matching `RefCollection.items` / `BackRef.value` directly. Foreign-key reassignments fire from `BaseModel.propertyChanged` (user setters) and `BaseModel.hydrate` (delta box.set writes) and re-route the child between parents in one batched action.

```
Delta: Issue "issue-abc" updated, teamId changed from "team-a" to "team-b"
  │
  ├── Team("team-a").issues.detach("issue-abc")
  └── Team("team-b").issues.attach(issueAbc)
```

`@Reference` getters read through a per-`(modelName, id)` MobX atom that the pool bumps on insert / remove / identity swap, so observers reading `holder.target` wake up even when the target is removed without an FK change. Full mechanism in [10-inverse-links-and-reactivity.md](./10-inverse-links-and-reactivity.md).

## Conflict Rebase

When a delta updates a model for which you have a pending local change, the engine rebases your change:

```
Your pending write: issue.title = "My Title" (oldValue: "Original")
Incoming delta: issue.title = "Server Title", priority = 2
  │
  ├── Apply delta: issue.title = "Server Title", priority = 2
  ├── Rebase your pending: oldValue → "Server Title" (new baseline)
  └── Re-apply your pending: issue.title = "My Title"

Result: title = "My Title", priority = 2
```

Your change wins (last-writer-wins). The server's other field changes are preserved. Your undo record is updated to reflect "Server Title" as the revert target.

The same rebase property holds for **optimistic edits staged via `atomic()`** — there's no `UpdateTransaction` yet, but `BaseModel.hydrate` mirrors the conflict-detection rule against the field's `pendingChanges` baseline. The optimistic value stays visible through the await, and a later `discardUnsavedChanges()` (e.g. when the atomic block throws) lands on the server's rebased value instead of the stale pre-edit one.

See [06-transactions-and-undo.md](./06-transactions-and-undo.md) for the full rebase story.

## ModelStream — Secondary SSE Connections

`SyncConnection` handles the primary SSE stream from the main server. `ModelStream` (`core/ModelStream.ts`) provides secondary SSE connections for external services — calculation engines, analytics pipelines, or any service that pushes model updates.

Key differences from `SyncConnection`:
- **Update-only**: ModelStream only updates models already in the pool — it never inserts new ones. If a message arrives for a model not in the pool, it's ignored.
- **No sync state**: No `lastSyncId`, no delta packets, no transaction resolution. Each message is a simple `{ modelName, modelId, data }` update.
- **Ephemeral-aware**: For `Ephemeral` models, updates skip IDB entirely. For non-ephemeral models, updates are written to IDB.
- **Lifecycle hooks**: `onStatusChange(connected: boolean)` fires on connect, disconnect, error, and reconnect — enabling consumers to trigger refresh APIs when a stream drops and comes back.

Both `SyncConnection` and `ModelStream` extend `BaseSSEConnection`, which provides shared reconnect logic with a 3-second delay.

### Configuration

```typescript
const sm = new StoreManager({
  workspaceId,
  transport: {
    bootstrapFetcher,
    modelStreams: [
      {
        url: "http://calc-engine/events",
        onStatusChange: (connected) => {
          if (!connected) {
            sm.refreshAllOfModel("Metric");
          }
        },
      },
    ],
  },
});
```

## TransportConfig reference

`StoreManagerConfig.transport: TransportConfig` is the single place every server-touching wire is plugged in — `bootstrapFetcher` is the only required field, the rest are opt-in. The full shape (exported from `zerodrift`):

| Field | Type | Purpose |
|---|---|---|
| `bootstrapFetcher` | `BootstrapFetcher` | **Required.** `async (type, options) => BootstrapResponse`. Called for full and partial bootstraps; the engine picks `type` based on persisted `__meta`. Receives `lastSyncId`, `syncGroups`, `onlyModels` so the server can tailor the payload. |
| `transactionSender` | `TransactionSender?` | `async (batch) => BatchResponse`. Called for every committed batch (`save()` / `batch()` / `atomic()` / `runUndoable()`). Omit for read-only clients. |
| `syncUrl` | `SSEEndpoint?` | SSE endpoint for live deltas — either a string or `() => string`, re-evaluated on every (re)connect. Engine appends `?lastSyncId=…&syncGroups=…&onlyModels=…` to whatever the thunk returns. Omit to disable live sync (bootstrap-only). |
| `bootstrapSyncGroups` | `() => Promise<string[]>?` | Seeds `dbMeta.subscribedSyncGroups` before the first bootstrap so every `bootstrapFetcher` call sees the union (persisted ∪ this hook ∪ server-supplied). Failure is fatal. Skip if the server owns scope. |
| `modelStreams` | `ModelStreamConfig[]?` | Secondary SSE endpoints (e.g. a calc service). Each entry's `url` is `string \| () => string` — the thunk form is the natural place to fold in a cursor read from localStorage (`() => \`${base}?since=${localStorage.getItem(cursorKey) ?? "0"}\``) since ModelStream doesn't append params of its own. Each is gated by `onlyModels`, applies updates pool-first, and writes to IDB unless the model is `Ephemeral`. |
| `sseClientFactory` | `SSEClientFactory?` | Override the default browser `EventSource`. Use `(url) => new EventSource(url)` from `eventsource` for Node/agents. When set, `sseInit` is ignored. |
| `sseInit` | `EventSourceInit?` | Forwarded to the default `EventSource` (e.g. `{ withCredentials: true }`). Applies to the main stream and every `modelStreams` entry. |
| `syncTransform` | `SyncMessageTransform?` | `(raw) => DeltaPacket \| null`. Use when the backend envelope diverges from the canonical packet. Return `null` to drop a message. |

`BootstrapFetcher`, `TransactionSender`, `BootstrapResponse`, `BatchResponse`, `ModelStreamConfig`, `SSEEndpoint`, `SyncMessageTransform`, `SSEClientFactory`, and `EngineErrorContext` are all re-exported from the root `zerodrift` entry — type-import them when wiring custom transports. The engine normalizes the grouped config (`transport` / `loading` / `persistence` / `hooks` / `advanced`) into one flat `NormalizedConfig` exactly once, in the constructor.

## Ephemeral Models in Delta Processing

When `SyncConnection` processes a delta for an `Ephemeral` model, it skips IDB writes and deletes. The model is updated in the ObjectPool only. This also applies to cascade deletes — if a deleted model has ephemeral children via `@BackReference` or `@Reference({ onDelete: "cascade" })`, those children are removed from the pool without touching IDB.

## Sequence Diagram: Full Round-Trip

```
User                  Client                   Server              Other Client
  │                     │                         │                      │
  │ issue.title = "X"   │                         │                      │
  │ issue.save()        │                         │                      │
  │─────────────────────▶ enqueue UpdateTx        │                      │
  │                     │ pool.put (optimistic)   │                      │
  │                     │─── POST /sync ──────────▶                      │
  │                     │                         │ process write        │
  │                     │◀── 200 OK, syncId=42 ───│                      │
  │                     │ tx → CompletedButUnsynced                       │
  │                     │                         │── SSE delta ─────────▶
  │                     │◀── SSE delta (syncId=42)│                      │
  │                     │ write IDB               │                      │
  │                     │ pool.put                │                      │
  │                     │ notify("Issue")         │  pool.put            │
  │                     │ tx → Completed          │  notify("Issue")     │
  │                     │                         │                      │
  │ (no visible change) │                         │                      │
```

The user sees `"X"` immediately (optimistic update in pool at `enqueue` time). The SSE round-trip is invisible — it just confirms and propagates to others.
