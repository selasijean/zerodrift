# Lazy Loading and Heap Size

The engine can hold thousands of model instances in memory. Without lazy loading, all of them would be loaded at startup and live in the JavaScript heap for the entire session. Lazy loading lets the engine load data incrementally — only what's needed, when it's needed.

## Why Heap Size Matters

The JS heap is garbage collected. Large heaps cause:
- Slower GC pauses (the browser freezes briefly while GC runs)
- Higher memory pressure (browser may kill the tab or slow down)
- Slower startup (more data to deserialize and hydrate)

An app with 50,000 issues, 10,000 comments, and 1,000 users doesn't need all of that in RAM if the user is only viewing 30 issues. Lazy loading lets the heap stay proportional to what's actually visible.

## Load Strategies

Every model declares a `LoadStrategy` via `@ClientModel`:

```typescript
@ClientModel({ loadStrategy: LoadStrategy.Eager })
export class Team extends BaseModel { ... }

@ClientModel({ loadStrategy: LoadStrategy.Partial })
export class DocumentContent extends BaseModel { ... }
```

| Strategy | Loaded at startup | Loaded when |
|---|---|---|
| `Eager` | Yes — all instances | Bootstrap |
| `Lazy` | No | First access fetches the whole table |
| `Partial` | No | Only the subset reached via an index/relation |
| `LocalOnly` | From IDB | Persisted locally, never synced |
| `Ephemeral` | No | Pool-only, fed by SSE / `ModelStream` |

`Partial` models get a `PartialStore` (starts empty, fills on demand); `Ephemeral` gets an `EphemeralStore` (pool-only); everything else gets a `FullStore` that loads from IDB/bootstrap.

**`Eager` is the only strategy that ships in the *initial* full-bootstrap payload** — the bootstrap pipeline restricts `onlyModels` to Eager. Lazy / Partial models reach the client through one of three on-demand paths that all reuse the same `bootstrapFetcher`:

- `getOrLoadCollection(modelName, indexKey, value)` — subset by FK/index.
- `getOrLoadById` / `getOrLoadByIds` — single-id or batch by id.
- `getOrLoadAll(modelName, { syncGroups? })` — *every* instance of the model (optionally scoped to a set of sync groups). Issues a `bootstrapFetcher(Full, { onlyModels: [name], syncGroups })` and records `*`-coverage in `partialIndexCoverage` so subsequent same-scope calls short-circuit.

Local stays in IDB only; Ephemeral lives in the pool and is fed by SSE.

### Concurrent SSE during a `getOrLoadAll` fetch

The server's snapshot is taken at some syncId; SSE may deliver inserts, updates, or deletes for the same model before the response lands. To prevent the older snapshot from clobbering newer SSE-delivered state, `getOrLoadAll` flips `isModelFullyLoaded(modelName) → true` *before* it issues the fetch (via a refcounted "pending" flag that `shouldHydrateInsert` reads), so SSE inserts during the window land in the pool. The merge step then:

- **drops snapshot records whose id was deleted in flight** — the SSE `D`/`A` handler tombstones the id via `recordInflightDelete`; the merge filters those out so a deleted record isn't resurrected.
- **skips snapshot records the pool already holds** — SSE got there first with potentially newer data, and `hydrateAndPut` would overwrite via `existing.hydrate(data)`.
- **writes IDB via `writeModelsIfAbsent`** — preserves any newer rows the SSE pipeline already wrote in step 2 of delta processing.

`fetchDeferredModels` (Phase 2 of bootstrap) follows the same tombstone pattern so deletes during its window can't resurrect records either.

Concurrent `getOrLoadAll` calls for the same `(modelName, scope)` are coalesced into a single in-flight promise. Different scopes for the same model run in parallel and share the tombstone set via the refcount.

**The critical insight:** for `Partial` and `Lazy` models, records exist in IndexedDB but their hydrated instances don't exist in the ObjectPool or in the heap. They only enter the heap when explicitly loaded.

## RefCollection

Defined in `core/LazyCollection.ts`. Runtime object backing both `@ReferenceCollection` (eager) and `@LazyReferenceCollection` (lazy). Represents a one-to-many relationship where the **child holds the foreign key**.

Example: `Team.issues` — all Issues where `issue.teamId === team.id`.

```
team.issues  ←  RefCollection
                  referencedModelName: "Issue"
                  inverseKey:          "teamId"
                  parentId:            "team-eng"
                  state:               idle | loading | loaded
                  items:               BaseModel[]
```

### Two resolution paths

**Sync (pool-first):** If the Issues are already in the pool (already loaded), the collection just filters:

```typescript
resolveFromPool(pool): Issue[] {
  return pool.getAll("Issue").filter(i => i.teamId === this.parentId);
}
```

No async, no IDB. This runs every time you access `.items` and the collection is loaded.

**Async (IDB):** If the collection hasn't been loaded yet, calling `.load()`:

1. Queries IDB by index: `readModelsByIndex("Issue", "teamId", "team-eng")`
2. For each returned record, hydrates an Issue instance
3. Puts each instance into the pool
4. Marks `state = Loaded`

After this, the pool has those Issue instances and future calls use the sync path.

### Inverse links

When a delta packet inserts a new Issue with `teamId: "team-eng"`, the pool walks the registry, finds the `@ReferenceCollection` on Team that targets Issue (`inverseOf: "teamId"`), and calls `team.issues.attach(newIssue)` directly. Items is a live MobX-observable array — observers reading it (or anything derived from it via `@Computed`) wake up automatically. No invalidation, no re-query, no `.load()` cycle.

The same happens in reverse on delete (`detach`) and on FK reassignment (detach from old parent, attach to new parent), and the pool also seeds children that arrived before their parent did via `populateOwnedCollectionsFromPool`. See **[10-inverse-links-and-reactivity.md](./10-inverse-links-and-reactivity.md)** for the full mechanism.

## BackRef

Represents a one-to-one inverse relationship where the parent owns the child.

Example: `issue.favorite` — find the Favorite record where `favorite.issueId === issue.id`.

```
issue.favorite  ←  BackRef
                    referencedModelName: "Favorite"
                    inverseOf:           "issueId"
                    parentId:            "issue-123"
                    value:               Favorite | null
```

Like `RefCollection`, loading it queries IDB and hydrates the result into the pool.

The ownership relationship means cascade delete is built in: when the Issue is deleted, the engine automatically deletes the Favorite.

## OwnedRefs

Backs both `@OwnedCollection` (eager) and `@LazyOwnedCollection` (lazy). Represents a one-to-many relationship where the **parent stores the array of child IDs**.

Example: `team.memberIds: string[]` + `@OwnedCollection("User", { idsField: "memberIds" })` → `team.members`.

```
team.members  ←  OwnedRefs
                  referencedModelName: "User"
                  idsGetter:           () => team.memberIds   ← live, not a snapshot
```

The `idsGetter` is a live function that reads the current array. When `team.memberIds` changes (a delta adds a new member), the next call to `collection.load()` picks up the new IDs automatically — no invalidation needed.

**Resolution:** maps IDs to pool lookups, falls back to IDB for any missing ones.

## How This Helps Heap Size

Consider a workspace with:
- 200 Teams (Eager)
- 50,000 Issues (Eager)
- 200,000 Comments (Lazy)
- 50,000 DocumentContent records (Partial)

At startup:
- 200 Team instances in heap ✓
- 50,000 Issue instances in heap ✓ (unavoidable — Eager)
- 0 Comment instances in heap ✓ (in IDB only)
- 0 DocumentContent instances in heap ✓ (in IDB only)

When user opens Team A:
- Team A's Issues already in pool (loaded at bootstrap)
- `team.issues.load()` → filters pool → returns Issues already there (no new allocations)
- `issue.comments.load()` for each visible issue → fetches ~20 comments each → ~600 Comment instances hydrated
- Heap grew by 600 objects, not 200,000

When user opens Issue X's document:
- `issue.documentContent.load()` → fetches 1 DocumentContent record → 1 new instance
- Heap grew by 1 object, not 50,000

The heap grows proportionally to what's been viewed, not the total workspace size.

### Eviction keeps the heap bounded

By default, once a record is loaded into the pool it stays there for the session. For long-lived sessions on large workspaces, this can accumulate. The eviction system addresses this:

- **Watermark (automatic).** Models that declare `eviction: { maxResident: N }` (or a global `eviction.maxResident` in `StoreManagerConfig`) are evicted FIFO down to `lowWaterRatio` (default 0.75) whenever the pool count exceeds the cap. Watermark always uses `keepInDb: true`, so for persisted models (`Lazy` / `Partial`) the rows stay in IDB and rehydrate cheaply. `Ephemeral` models have no IDB, so `keepInDb` is moot: eviction drops the only copy, their collection coverage is session-scoped (never persisted, and a stale entry from an older build is ignored on reload), and a reload must come from the server via the on-demand fetcher. The global cap covers eviction-eligible models (`Lazy` / `Partial` / `Ephemeral`); `Eager` and `LocalOnly` are exempt by default, since `Eager` means "always resident". An `Eager` model opts in with its own `eviction` config — `eviction: {}` accepts the global cap, `eviction: { maxResident: N }` sets a per-model one.
- **Sync-group-leave (explicit).** The `onSyncGroupDelete` callback fires when `deactivateSyncGroup` or a server-pushed `removedSyncGroups` removes a group. Use `sm.evictByIndex(modelName, indexKey, groupId)` to drop the group's records. Pass `{ safe: true }` to respect the safety predicate.

The safety predicate (`canEvict`) refuses to evict records with unsaved changes, in-flight transactions, or active observation refcounts (records being rendered by React hooks). Watermark eviction always applies it; explicit `evictByIndex` applies it only with `{ safe: true }`. Watermark-evicted records are also marked so the self-heal path can reload them when a `@Reference` getter or React hook accesses them — from IDB for persisted models, or from the server via the on-demand fetcher for `Ephemeral` models (so an `Ephemeral` record only self-heals when on-demand fetching is configured). Explicit eviction is a deliberate removal and does not self-heal. See `02-object-pool.md` for the self-heal mechanism.

## Eager vs lazy — pick the decorator

Each relationship has an eager and a lazy variant. The eager decorator (no prefix) loads alongside the parent during `makeModelObservable()`; the `@Lazy*` variant stays Idle until something explicitly asks for it.

```typescript
// Eager — pulled into the pool when the parent hydrates
@Reference("User") public assignee: User;
@ReferenceCollection("Issue", { inverseOf: "teamId" }) public issues: RefCollection<Issue>;
@OwnedCollection("Label", { idsField: "labelIds" }) public labels: OwnedRefs<Label>;

// Lazy — load on demand
@LazyReference("User") public reviewer: User;
@LazyReferenceCollection("Comment", { inverseOf: "issueId" }) public comments: RefCollection<Comment>;
@LazyOwnedCollection("Tag", { idsField: "tagIds" }) public tags: OwnedRefs<Tag>;
```

When the parent is hydrated and `makeModelObservable()` runs, each eager relationship fires its load immediately:

- `@Reference` → `storeManager.getOrLoadById(referenceTo, id)` so accessors don't return `null` on first read.
- `@ReferenceCollection` → `collection.load()` to pull all matching children into the pool.
- `@OwnedCollection` → `collection.load()` over the current id array.

The kick-off is fire-and-forget — `makeModelObservable()` is synchronous, so observers re-render when each collection's state transitions to `Loaded`. Tests that need to await completion can call `await collection.load()`, which is idempotent and returns the in-flight Promise when one is already running.

**Recursion is automatic.** An eager `@ReferenceCollection` on `Owner` triggers `getOrLoadCollection` for the children → each child arrives via `objectPool.hydrateAndPut` → that calls the child's `makeModelObservable` → any eager relationships *on the child* fire their own loads. The recursion is bounded because `hydrateAndPut` short-circuits when an instance is already in the pool, and `getOrLoadById` short-circuits the same way.

**When to use eager.** Reach for the eager decorator when a parent is useless without its children (a Document without its Blocks, an Order without its LineItems) and you want a single `await` to settle the whole subtree. Use `@Lazy*` for relationships that are only sometimes opened (a Team's full Issue list when most pages only need a count).

## Auto-derived covering indexes (`transientIndexDepth`)

`RefCollection`s union additional index queries on top of the direct `inverseOf` axis. Adopters can declare them manually:

```ts
@LazyReferenceCollection("Comment", {
  inverseOf: "issueId",
  coveringIndexes: ["teamId"],   // Comment also has indexed teamId (denormalized)
})
public comments: RefCollection<Comment>;
```

The engine ALSO auto-derives these from the FK graph at `RefCollection` construction. Walking the parent's outgoing FK chain up to `transientIndexDepth` (default 3, set via `StoreManagerConfig.transientIndexDepth`), each hop's FK name is intersected with the child's indexed properties. Every match becomes a `CoveringPath` resolved at `hydrate()`:

- **Depth 1** — the parent's direct FK names that match a child indexed prop. Read off the parent: `readFk(parent, axis)`.
- **Depth 2+** — chains like `Issue.teamId → Team.organizationId` where the child has indexed `organizationId`. Resolved by walking through `pool.getById(throughModel, id)` for each intermediate hop. If any intermediate model isn't in the pool, the path is silently skipped (its query will fire next time the chain is resolvable).

Manual `coveringIndexes` and auto-derived paths are union'd, deduped by `(key, value)` signature. The manual list is the override — adopters can declare an explicit smaller set when they want to scope back, or larger set when they have axes the registry can't see (computed properties, etc.).

`transientIndexDepth = 0` disables auto-derivation entirely; manual `coveringIndexes` still applies.

## The `usedForPartialIndexes` Flag

```typescript
@ClientModel({ loadStrategy: LoadStrategy.Eager, usedForPartialIndexes: true })
export class Issue extends BaseModel { ... }
```

When this is `true`, the engine adds the model's ID to a `partialIndexValues` set on any `RefCollection` that points at it. This allows the IDB query for those collections to use an index scan instead of a full table scan, even for partial models.

In practice: if DocumentContent (Partial) references Issue (Eager, `usedForPartialIndexes: true`), then loading all DocumentContent for a given Issue uses an indexed IDB query rather than scanning the entire DocumentContent table.

## Collection States

All three lazy collection types share the same state machine:

```
Idle
  │ (first .load() call)
  ▼
Loading
  │ (IDB query completes)
  ▼
Loaded
```

Or:
```
Loading
  │ (IDB error)
  ▼
Error
```

The state tracks whether the loader has run — *not* whether `items` is current. Items is kept in sync with the pool by the inverse-link machinery (see **[10-inverse-links-and-reactivity.md](./10-inverse-links-and-reactivity.md)**), so a `Loaded` collection stays correct as deltas arrive without ever transitioning back to `Idle`. `invalidate()` still exists on the collection API — it forces the next access to re-query IDB — but the engine itself doesn't call it during normal delta flow.

The React hooks read this state machine through the uniform `AsyncResource` shape (`{ data, isLoading, isLoaded, error, reload }`). `useRelation` (which wraps a runtime collection / back-ref directly) reflects the collection's own `isLoaded`; the pool-keyed hooks (`useRecord`, `useRecords`, `useRecordsByIndex`) derive `isLoaded` as "ready, not loading, no error" — true from frame zero for a pool hit, since their data can come from the pool synchronously.
