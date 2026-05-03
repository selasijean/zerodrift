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
@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class Team extends BaseModel { ... }

@ClientModel({ loadStrategy: LoadStrategy.Partial })
export class DocumentContent extends BaseModel { ... }
```

| Strategy | Loaded at startup | Loaded when |
|---|---|---|
| `Instant` | Yes — all instances | Bootstrap |
| `Lazy` | No | First access via collection or hook |
| `Partial` | No | When a parent referencing them is viewed |
| `ExplicitlyRequested` | No | Only when code calls `sm.loadOne(modelName, id)` |

`Instant` models get a `FullStore`. All others get a `PartialStore`. The `FullStore` loads everything at bootstrap; the `PartialStore` starts empty and fills on demand.

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
- 200 Teams (Instant)
- 50,000 Issues (Instant)
- 200,000 Comments (Lazy)
- 50,000 DocumentContent records (Partial)

At startup:
- 200 Team instances in heap ✓
- 50,000 Issue instances in heap ✓ (unavoidable — Instant)
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

### The Trade-off

The heap never shrinks. There's no eviction — once a Comment is loaded into the pool, it stays there for the session. If the user browses through 50 teams over an hour, all their comments accumulate. This is acceptable for most sessions but can become significant for very long-lived sessions on large workspaces.

This is a deliberate trade-off: eviction requires cache invalidation logic (what if a comment in the pool gets stale?), and the complexity cost was deemed higher than the memory cost for typical usage patterns.

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

- `@Reference` → `storeManager.loadOne(referenceTo, id)` so accessors don't return `null` on first read.
- `@ReferenceCollection` → `collection.load()` to pull all matching children into the pool.
- `@OwnedCollection` → `collection.load()` over the current id array.

The kick-off is fire-and-forget — `makeModelObservable()` is synchronous, so observers re-render when each collection's state transitions to `Loaded`. Tests that need to await completion can call `await collection.load()`, which is idempotent and returns the in-flight Promise when one is already running.

**Recursion is automatic.** An eager `@ReferenceCollection` on `Owner` triggers `loadCollection` for the children → each child arrives via `objectPool.hydrateAndPut` → that calls the child's `makeModelObservable` → any eager relationships *on the child* fire their own loads. The recursion is bounded because `hydrateAndPut` short-circuits when an instance is already in the pool, and `loadOne` short-circuits the same way.

**When to use eager.** Reach for the eager decorator when a parent is useless without its children (a Document without its Blocks, an Order without its LineItems) and you want a single `await` to settle the whole subtree. Use `@Lazy*` for relationships that are only sometimes opened (a Team's full Issue list when most pages only need a count).

## The `usedForPartialIndexes` Flag

```typescript
@ClientModel({ loadStrategy: LoadStrategy.Instant, usedForPartialIndexes: true })
export class Issue extends BaseModel { ... }
```

When this is `true`, the engine adds the model's ID to a `partialIndexValues` set on any `RefCollection` that points at it. This allows the IDB query for those collections to use an index scan instead of a full table scan, even for partial models.

In practice: if DocumentContent (Partial) references Issue (Instant, `usedForPartialIndexes: true`), then loading all DocumentContent for a given Issue uses an indexed IDB query rather than scanning the entire DocumentContent table.

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

The React hooks read this state machine: `useCollection` and `useBackRef` (which wrap a runtime collection / back-ref directly) expose `isLoading`, `isLoaded`, and `error`. The pool-keyed hooks (`useModel`, `useModels`, `useIndexedCollection`) expose only `isLoading` and `error` — they don't carry `isLoaded` because their data may come from the pool synchronously.
