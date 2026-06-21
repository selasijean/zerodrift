# The Object Pool

The ObjectPool (`core/ObjectPool.ts`) is the in-memory store for every model instance. It is the engine's single source of truth at runtime — IndexedDB is the persistent backing store, but the ObjectPool is what React reads from and what your code talks to.

## Structure

```typescript
private pool = new Map<string, Map<string, BaseModel>>();
//               modelName       id       instance

pool.get("Issue")?.get("issue-123")  // → Issue instance
pool.get("Team")?.get("team-eng")    // → Team instance
```

It's simply two nested Maps. Lookup is O(1) by model name and ID.

## Why It Exists

### 1. Fast relationship resolution

When you access `issue.team`, you don't query IndexedDB asynchronously. The `@Reference` getter does:

```typescript
get team() {
  return pool.getById("Team", this.teamId);
}
```

This is synchronous and O(1). Without the pool, every relationship traversal would be an async IDB read, making it impractical to use in synchronous React renders.

### 2. Identity guarantee

The pool ensures there is exactly **one instance per ID** in memory. If you access `issue.team` ten times from ten different components, they all get back the same JavaScript object reference. When a delta arrives and updates `team.name`, all ten components see the change — because they're pointing at the same object.

Without this, you'd have multiple copies of the same entity drifting out of sync.

### 3. React reactivity

The pool has a pub/sub system:

```typescript
private listeners = new Map<string, Set<() => void>>();

subscribe(modelName: string, listener: () => void): () => void
notify(modelName: string): void
```

`pool.put()` and `pool.remove()` call `notify(modelName)`, which fires all subscribed listeners for that model type. The React hooks (`useRecords`, `useRecord`) subscribe to these notifications via `useSyncExternalStore`.

Note: `hydrateAndPut` is the primary method for adding or updating models. When updating an existing instance, it hydrates data in-place (updating MobX observable boxes directly) **without** calling `put`/`notify` — avoiding unnecessary pool-level notifications and snapshot cache invalidation. MobX handles property-level reactivity through the observable boxes. Pool-level `notify` only fires on structural changes (new instance added or instance removed).

This is the mechanism that makes the UI feel live — components don't poll; they're subscribed.

## Benefits

### Eager, synchronous relationship traversal
No `await` needed to navigate from an Issue to its Team to the Team's members. It's all in-memory object graph traversal.

### Single instance per entity
Mutations are immediately visible everywhere. You can't have stale copies.

### Cheap reactivity
The notification is coarse-grained (model type level), but that's intentional. `useSyncExternalStore` then compares snapshots to decide if a particular component actually needs to re-render. This avoids the overhead of per-instance subscriptions.

### Works offline
Once data is hydrated into the pool at bootstrap, the app is fully functional with no network access. The pool is the entire working dataset.

### O(1) everything
Insert, lookup, delete — all constant time regardless of how many instances exist.

## Drawbacks

### Coarse-grained subscriptions
The pool notifies at the model-type level, not per-instance. Every component subscribed to "Issue" re-checks its snapshot when **any** issue changes. For large collections with many subscribers, this can cause unnecessary snapshot comparison work. (React's `useSyncExternalStore` handles this — it only re-renders if the snapshot actually changed — but the comparison still runs.)

### Memory is unbounded by default
For models with `LoadStrategy.Eager`, **every instance is loaded into the pool at bootstrap** and stays there unless explicitly opted into eviction. If you have 50,000 issues across 100 teams, and a user is only ever on one team, all 50,000 still live in the pool.

This is mitigated by `LoadStrategy.Lazy` and `LoadStrategy.Partial`, and by the declarative eviction policy — models can declare `eviction: { syncGroupKey, maxResident }` to auto-evict on sync-group leave or when the pool exceeds a resident-count watermark. See the eviction section below.

### Eviction

The pool supports declarative eviction via `ObjectPool.evictBatch` and `ObjectPool.evictInstance`. Evicted records are removed from the pool and marked in a transient `recentlyEvicted` set so the self-heal path can distinguish eviction from server-side deletion.

**Observation tracking.** React hooks (`useRecord`, `useRecords`, `useRecordsByIndex`) maintain per-instance refcounts via `observeInstance` / `unobserveInstance`. The eviction safety predicate (`StoreManager.canEvict`) checks `pool.isObserved(modelName, id)` and refuses to evict records that a mounted component is rendering.

**Self-heal.** When a `@Reference` getter accesses an evicted target, `trackModel` sees the eviction marker and fires the rehydrator callback (`getOrLoadById`), which restores the record from IDB or the server in the background. The React hook self-heal works similarly: `useRecordByName` detects "had data, lost it to eviction" via `wasEvicted` and calls `reload()`.

**Stale marker cleanup.** When a record re-enters the pool via `put` or `hydrateAndPut`, any stale eviction marker is cleared automatically (guarded by `recentlyEvicted.size > 0` so it's zero-cost during bootstrap).

### No query language
The pool is just a flat Map per model type. There are no indexes, no filtering, no sorting built into the pool itself. If you want all Issues with `priority > 2`, you call `pool.getAll("Issue").filter(...)`. For large datasets, this is a linear scan. IndexedDB indexes exist for efficient bootstrap loading, but in-memory querying is always O(n).

### Reference resolution can return null silently
If `issue.teamId` is set but the Team hasn't been loaded yet, `issue.team` returns `null`. This is correct behavior (partial loading), but it means code that traverses relationships needs to handle nulls defensively, even for non-nullable declared references.

### Instance identity makes diffing harder
Because you have one instance per entity, there's no "previous vs current" snapshot to diff — the instance is mutated in place. The undo/redo system handles this by recording old/new values in Transaction objects, but it does mean you can't naively compare two pool snapshots to see what changed.

## The Eager vs Partial Split

Not all models live fully in the pool. The `LoadStrategy` on each model controls this:

| Strategy | Pool at startup | Loaded when |
|---|---|---|
| `Eager` | All instances | Bootstrap |
| `Lazy` | None | On first access via collection or explicit load |
| `Partial` | Only referenced ones | When a parent model referencing them is loaded |
| `LocalOnly` | From IDB | Persisted locally, never synced |
| `Ephemeral` | None | On demand via `getOrLoadCollection`/`getOrLoadByIds`; never persisted to IDB |

`FullStore` (for Eager models) loads everything at bootstrap. `PartialStore` (for the rest) loads nothing — instances trickle in on demand and stay in the pool once loaded. `EphemeralStore` (for Ephemeral models) is a no-op — it skips both `loadFromDatabase` and `loadFromServer`, since ephemeral models are loaded on-demand and never touch IDB.

This is the key mechanism for keeping the pool small. See `04-lazy-loading.md` for more detail.

## Bidirectional Relationships Are Maintained Inline

The pool keeps parent-side `@ReferenceCollection` / `@BackReference` collections in sync with child entries automatically. When a child enters the pool with its FK set, the pool walks the model registry, finds every parent declaration targeting the child's type, and pushes the child into the parent's runtime collection. When the child leaves or its FK changes, the pool detaches and re-attaches accordingly. `@Reference` getters are made reactive to pool identity changes via per-`(modelName, id)` MobX atoms.

Adopters never call `invalidate()` or push children into parents by hand. See **[10-inverse-links-and-reactivity.md](./10-inverse-links-and-reactivity.md)** for the full mechanism.

## In-Place Updates and Object Identity

`hydrateAndPut` preserves object identity. When called with data for a model that already exists in the pool, it updates the existing instance in-place via `hydrate()` rather than creating a new one. This means components and hooks holding a reference to a model instance will see updated values without needing to re-resolve from the pool.

This is critical for the refresh APIs (`refreshCollection`, `refreshModels`, `refreshAllOfModel`), which re-fetch data from the server without breaking existing references.

## Pool-only inserts: `materializePoolOnly`

`StoreManager.materializePoolOnly(modelName, records)` inserts server-shaped records straight into the pool with no `CreateTransaction` and no IDB write. It validates every record has a string `id`, rejects collisions by default, and calls `objectPool.hydrateAndPut` — the same insert path SSE uses. Inverse-link wiring, `@ReferenceCollection` membership, and `notifyModelChanged` reactivity all fire automatically.

Use it for optimistic in-memory mirrors while the server's authoritative version is in flight — e.g. materializing draft-layer `Object` records under ids like `draftLayerId:objectId`. When the server's records eventually arrive via SSE on the same ids, pass `{ onCollision: "hydrate" }` only when you intentionally want the same in-place `hydrate()` behavior as SSE / refresh paths.

`StoreManager.clonePoolOnly(sources, transform)` is a convenience wrapper for cloning existing instances into pool-only mirrors. It serializes each source, runs `transform(data, source)`, requires a different `id`, then delegates to `materializePoolOnly`.

## Pool vs IndexedDB

It's worth being explicit about the division of responsibility:

| | ObjectPool | IndexedDB |
|---|---|---|
| Lives in | RAM (JS heap) | On-disk browser storage |
| Survives page refresh | No | Yes |
| Query speed | Fast (O(1) by ID, O(n) scan) | Slower (IDB overhead), but indexed |
| What it holds | Hydrated model instances | Serialized JSON records |
| Modified by | Delta packets + local edits | Delta packets + bootstrap |
| Drives | React reactivity | Offline bootstrap / partial loads |

The ObjectPool is the working memory. IndexedDB is the durable snapshot you bootstrap from on next page load.
