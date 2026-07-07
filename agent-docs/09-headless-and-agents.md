# Headless Usage and Agents

The engine has zero React and zero browser dependencies. React hooks are a thin optional layer on top. The same `StoreManager` that powers a browser UI runs in Node.js, serverless functions, CLI tools, or any other TypeScript environment.

This doc covers what changes when you run outside a browser.

## The Two Pluggable Seams

Two constructor options make the engine portable:

```typescript
const sm = new StoreManager({
  workspaceId: "agent-1",
  transport: {
    bootstrapFetcher: ...,
    sseClientFactory: (url) => new EventSource(url), // replaces browser EventSource
    modelStreams: [                                  // optional secondary SSE connections
      {
        url: "http://calc-engine/events",
        onStatusChange: (connected) => { /* handle disconnect/reconnect */ },
      },
    ],
  },
  persistence: { storageAdapter: new MemoryAdapter() }, // replaces IndexedDB
});
```

Everything else — ObjectPool, TransactionQueue, SyncConnection, undo stack, lazy collections — works identically in all environments.

### `storageAdapter`

Controls where model data and pending transactions are persisted.

| Adapter | Use when |
|---|---|
| `Database` (default) | Browser — needs IndexedDB |
| `MemoryAdapter` | Node.js agents, serverless, CLI — no persistence needed |
| Custom `StorageAdapter` | Need durability across restarts (SQLite, Redis, etc.) |

`MemoryAdapter` (`core/MemoryAdapter.ts`) is a full in-memory implementation backed by `Map` and an array. It satisfies the complete `StorageAdapter` interface with no platform dependencies. Data lives for the lifetime of the process only.

The `StorageAdapter` interface (`core/Database.ts`) is small — 12 methods. Implementing it for a custom backend (e.g. SQLite for a long-running agent that needs to survive restarts) is straightforward.

### `sseClientFactory`

Controls how the engine opens its SSE connection.

```typescript
// Browser (default — no config needed)
// Uses globalThis.EventSource

// Node.js
import EventSource from "eventsource"; // npm i eventsource
sseClientFactory: (url) => new EventSource(url)

// Serverless / fetch-based
sseClientFactory: (url) => makeFetchSSEClient(url)
```

The factory receives the fully-constructed URL (including `lastSyncId` and sync group params) and must return an object matching the `SSEClient` interface: `{ onmessage, onerror, close }`.

## Models in Headless Mode

Models must be registered with the engine before `bootstrap()` is called. In a browser app, this happens naturally because the model files are imported by components. In a headless agent, you must import them explicitly:

```typescript
import { StoreManager, MemoryAdapter } from "zerodrift";
import EventSource from "eventsource";

// Side-effect import — registers all model classes with ModelRegistry
import "./models";

const sm = new StoreManager({ ... });
await sm.bootstrap();
```

The model files must be imported (directly or transitively) before `bootstrap()` so their `@ClientModel` decorators have run and populated `ModelRegistry`. `reflect-metadata` is **not** needed — the engine registers metadata explicitly from decorator arguments and never reads `design:type`.

## Custom id generation with context

`StoreManager` is generic in `TContext`. When `advanced.identifierFn` is supplied, it's invoked for every client-side `new Model()` (records hydrated from the server or storage adapter keep their existing ids). Push runtime state with `sm.setContext`:

```typescript
type AgentContext = { agentId: string; tenantId: string };

const sm = new StoreManager<AgentContext>({
  workspaceId: "agent-1",
  transport: { bootstrapFetcher },
  advanced: {
    identifierFn: (meta, ctx) =>
      ctx == null
        ? crypto.randomUUID()
        : `${ctx.tenantId}:${meta.name}:${crypto.randomUUID()}`,
  },
});

sm.setContext({ agentId: "claude-1", tenantId: "acme" });
await sm.bootstrap();
```

Context is read on demand at id-mint time, not captured — re-call `setContext` whenever the relevant state changes. If `identifierFn` is omitted, ids fall back to `crypto.randomUUID()` and `setContext` is a no-op.

For entity-specific id schemes, prefer the per-entity `idStrategy` — `entity({ idStrategy })` in a schema or `@ClientModel({ idStrategy })` on a class. It has the same `IdentifierFn` signature (`(meta, ctx) => string`) and wins over the global `identifierFn`, so the global function doesn't have to branch on `meta.name` and a strategy can move between the two scopes unchanged.

## Field transforms — canonicalize values on the way in

`applyFieldTransforms` is the registry-walk companion to `identifierFn`: at engine init it visits every `(model, property)` pair and asks the rule whether to install a transform. Whatever it returns runs for **all data entering the pool** — inside the property setter (`issue.teamId = x`) and on every hydration (bootstrap payloads, IDB reads, SSE deltas, `create` / `draft` / `seed` inputs) — receiving `(value, instance, ctx)`. Use it to apply cross-cutting input rewrites — layer/tenant prefixing, string normalization — without sprinkling per-field decorators across every model.

```typescript
import { PropertyType, StoreManager } from "zerodrift";

type LayerContext = { layerId: string };

const sm = new StoreManager<LayerContext>({
  workspaceId: "agent-1",
  transport: { bootstrapFetcher },
  advanced: {
    applyFieldTransforms: (_meta, prop) => {
      if (prop.type !== PropertyType.Reference) return undefined;
      return (value, instance, ctx) => {
        if (typeof value !== "string" || value === "" || value.includes("/")) {
          return value;
        }
        // Prefer the instance's own layerId; fall back to live context for
        // freshly-constructed models that haven't been assigned one yet.
        const layerId =
          (instance as { layerId?: string }).layerId ?? ctx?.layerId;
        return layerId != null ? `${layerId}/${value}` : value;
      };
    },
  },
});
sm.setContext({ layerId: "layer-prod" });
```

Storage is per-StoreManager — rebuilding the engine swaps the rules cleanly without mutating `ModelRegistry`. The rule is invoked at most once per property; the setter and hydrate hot paths early-exit when nothing was registered. Read sibling fields from `instance` first; fall back to `ctx` when the instance hasn't been hydrated yet (during hydration the instance may be partially populated).

Transforms MUST be idempotent (a canonical form is a fixed point — note the `value.includes("/")` guard above). Values are persisted already-transformed and transformed again when rehydrated from IDB or echoed back over SSE; a non-idempotent transform would compound on every round-trip.

## Reactivity Without React

React's observer model (`useSyncExternalStore`, `useEffect`) doesn't exist in Node.js. The engine exposes three callback-based APIs for headless reactivity.

### `objectPool.subscribe` — type-level reactivity

Fires whenever models of a given type are added or removed from the pool. This is the primary event loop for an agent reacting to new or deleted models from the SSE stream:

```typescript
const unsubscribe = sm.objectPool.subscribe("Issue", () => {
  const issues = sm.objectPool.getAll("Issue");
  // re-evaluate, make decisions, write back
});

unsubscribe(); // call on shutdown
```

The SSE stream delivers a delta → pool updates → subscription fires → agent acts → write queued → server broadcasts → all clients and agents update. No polling.

Note: `objectPool.subscribe` fires on structural changes (instances added/removed). For property-level changes on existing instances, use `model.watch()` below — in-place updates go through MobX observable boxes, not pool-level notifications.

### `collection.watch` — relationship-level reactivity

Fires when `items` change — a child is attached or detached by the inverse-link machinery (delta inserts / removes / FK changes), `setItems` runs, or `load()` resolves. Same verb as `model.watch` / `store.<entity>.watchAll`. See [10-inverse-links-and-reactivity.md](./10-inverse-links-and-reactivity.md).

```typescript
const team = sm.objectPool.getById("Team", teamId) as Team;
const unwatch = team.issues.watch(() => {
  // team.issues.items is now current
});
```

### `model.watch()` — per-property reactivity

Fires only when a specific property (or derived condition) changes on a model you already hold:

```typescript
const issue = sm.objectPool.getById("Issue", id) as Issue;

const unwatch = issue.watch(
  (m) => m.priority,
  (newValue, oldValue) => {
    console.log(`priority: ${oldValue} → ${newValue}`);
  },
);

unwatch(); // call to stop observing
```

The selector can read multiple properties — only the return value is compared:

```typescript
issue.watch(
  (m) => m.status === "done",
  (isDone) => isDone && notifyHuman(),
);
```

Use `model.watch()` on models obtained from the pool (`objectPool.getById` / `objectPool.getAll`). It's powered by MobX observables that are wired at hydration time.

**Boundary**: `watch` tracks changes on a model you already hold. It does not fire when a new model arrives in the pool. For new arrivals, use `objectPool.subscribe`.

## Isolated vs Shared Agent State

### Isolated agents

Each agent creates its own `StoreManager`. Independent working memory. All instances converge via the SSE stream — a write by one agent arrives at every other in real time:

```typescript
const mk = () => new StoreManager({
  workspaceId,
  transport: { bootstrapFetcher },
  persistence: { storageAdapter: new MemoryAdapter() },
});
const agentA = mk();
const agentB = mk();

await Promise.all([agentA.bootstrap(), agentB.bootstrap()]);
// Both connected, both receiving the same SSE stream
```

Use this for parallel agents working independently on different parts of a problem.

### Shared agents

Multiple agents share one `StoreManager`. Single pool, one SSE connection. Writes from any agent are immediately visible to all others with no server round-trip:

```typescript
const sm = new StoreManager({ ... });
await sm.bootstrap();

// agentA and agentB both operate on the same StoreManager
const agentAView = sm.objectPool.getById("Issue", id);
const agentBView = sm.objectPool.getById("Issue", id);

agentAView === agentBView; // true — same instance
agentAView.title = "Updated by A";
agentBView.title; // "Updated by A" — immediately
```

Use this for tightly-collaborating agents, or for an agent running alongside a UI that needs to see and react to human edits instantly.

## Undo Works for Agent Writes

The undo stack is not React-specific. An agent can undo its own previous action:

```typescript
issue.title = "Changed by agent";
issue.save();

await sm.undo(); // reverts the title — visible to all consumers of the pool
```

A human can also undo what an agent did. This is foundational for human-in-the-loop workflows where trust is being established incrementally.

## Write Flow in Headless Mode

Writes work identically to the browser:

```typescript
// Optimistic — applies locally immediately
issue.title = "Fixed by agent";
issue.save();
// → TransactionQueue batches and POSTs to server
// → Server acknowledges, broadcasts SSE delta
// → All other agents and browser clients update
```

The local update is visible instantly (before the server ACK). If the server rejects the write, the optimistic update is rolled back automatically.

## ModelStream and Refresh APIs

### Secondary SSE connections

`ModelStream` connections are configured via the `modelStreams` option. They receive updates from external services (calculation engines, analytics, etc.) and apply them to existing pool models. They never insert new models — only update ones that are already loaded.

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
            console.log("Calc engine disconnected — data may be stale");
          }
        },
      },
    ],
  },
});
```

### Refreshing stale data

When a secondary stream disconnects, models it was updating may become stale. Three refresh APIs re-fetch data from the server while preserving object identity — any agent or component holding a reference to a model instance continues to see the same object, just with updated values:

```typescript
// Re-fetch a specific collection (e.g., all metrics for a given label)
const metrics = await sm.refreshCollection("Metric", "label", "cpu");

// Re-fetch specific models by ID
const models = await sm.refreshModels("Metric", ["m1", "m2"]);

// Re-fetch everything previously loaded for a model type
await sm.refreshAllOfModel("Metric");
```

All three methods:
- Fetch fresh data directly from the server (via `onDemandFetcher` / `onDemandBatchFetcher`)
- Update existing pool instances in-place (preserving object identity)
- Remove models the server no longer returns (server-side deletions)
- Skip IDB for ephemeral models
- Update IDB for non-ephemeral models

A typical pattern is to trigger a refresh from the `onStatusChange` callback when a stream reconnects, or proactively when it disconnects:

```typescript
onStatusChange: (connected) => {
  if (!connected) {
    sm.refreshAllOfModel("Metric");
  }
}
```

## Observability

Headless deployments often need structured error reporting more than the browser does — a server-side process can't show toast notifications, and silent failures in eager loads or transaction retries can mask real outages. `StoreManagerConfig.onError` is a single hook that fires for every async failure the engine catches internally:

```typescript
import { StoreManager, type EngineErrorContext } from "zerodrift";

const sm = new StoreManager({
  workspaceId,
  transport: { bootstrapFetcher },
  hooks: {
    onError: (err, ctx: EngineErrorContext) => {
      log.error({ err, ...ctx }, `engine: ${ctx.kind}`);
    },
  },
});
```

`ctx.kind` is a tagged-union discriminator. Each kind carries fields specific to its failure site:

| `ctx.kind` | When it fires | Extra fields |
|---|---|---|
| `eagerReferenceLoad` | `@Reference` (eager) — `storeManager.getOrLoadById` rejects | `modelName`, `id` |
| `eagerCollectionLoad` | `@ReferenceCollection` (eager) — loader rejects | `modelName`, `parentModelName`, `parentId` |
| `lazyCollectionLoad` | `@LazyReferenceCollection` — loader rejects on explicit `.load()` | same as above |
| `lazyOwnedCollectionLoad` | `@OwnedCollection` / `@LazyOwnedCollection` loader rejects | `modelName` |
| `lazyBackRefLoad` | `@BackReference` loader rejects | `modelName`, `parentId` |
| `deferredBootstrap` | Phase-2 deferred-models bootstrap fetcher rejects | `modelNames` |
| `syncGroupFetch` | `bootstrapFetcher` with `syncGroups` rejects (during activation or SSE-driven addition) | `groups` |
| `ssePacketParse` | The SSE message handler throws (malformed JSON, unknown action, etc.) | `url`, `raw` |
| `sseConstruction` | The `sseClientFactory` throws when opening the connection | `url` |
| `transactionSend` | `transactionSender` rejects; the batch is re-queued for retry | `batchSize` |
| `onSyncGroupDelete` | The adopter's `onSyncGroupDelete` callback throws | `groupId` |
| `optimisticSettle` | An `optimistic()` commit or rollback throws while settling one model (e.g. a consumer serializer/deserializer fails); other models still settle | `phase` (`"commit"` \| `"rollback"`), `modelName?`, `modelId` |

Errors thrown from inside `onError` itself are swallowed, so a buggy logger can't crash the engine. Without `onError` configured, internal failures stay silent (existing behavior preserved).

Other lifecycle hooks on the same config:

- `onPhaseChange(phase, detail)` — bootstrap state machine: `Idle` → `CreatingStores` → `ConnectingDatabase` → `Fetching` → `Hydrating` → `ConnectingSync` → `Ready` (or `Error`).
- `onDeltaPacket(packet)` — fires on every SSE delta after it processes (useful for "last activity" timestamps).
- `onReady()` — fires once when bootstrap completes.

## Teardown

Always call `teardown()` when done to close the SSE connection, flush pending transactions, and release resources:

```typescript
process.on("SIGINT", async () => {
  await sm.teardown();
  process.exit(0);
});
```
