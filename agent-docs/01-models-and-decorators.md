# Models and Decorators

Models are defined as TypeScript classes decorated with metadata. That metadata — about which fields exist, what their types are, how they relate to other models — is the engine's schema. It drives everything: IndexedDB table structure, change tracking, relationship resolution, and cascade deletes.

> **Schema-first alternative.** A second authoring path declares models as plain data via `defineSchema(...)` and produces a fully-typed `store.<entity>.*` API. Both paths compile to the same `ModelRegistry` shape and can coexist in one app — see [`11-schema-first-authoring.md`](11-schema-first-authoring.md).

## The ModelRegistry

Every decorator, at class-definition time, writes into a global singleton called `ModelRegistry` (`core/ModelRegistry.ts`). You never interact with it directly; the decorators do it for you.

```
Class definition time
        │
        ▼
  @ClientModel(...)         ─── registers the class, load strategy, schema version
  @Property(...)            ─── registers a persisted, observable field
  @Reference(...)           ─── registers a foreign-key relationship
  @ReferenceCollection(...) ─── registers a one-to-many relationship
  @BackReference(...)       ─── registers an inverse/owned relationship
  @Action(...)              ─── marks a method for MobX batching
  @Computed(...)            ─── marks a getter for MobX memoization
        │
        ▼
  ModelRegistry.models: Map<string, ModelMeta>
```

The `ModelMeta` for each class includes:

```typescript
{
  name: "Issue",
  loadStrategy: LoadStrategy.Eager,
  usedForPartialIndexes: true,
  schemaVersion: 1,
  ctor: Issue,                        // the class constructor
  properties: Map<string, PropertyMeta>,
  actions: Set<string>,
  computedProps: Set<string>,
}
```

A **schemaHash** is computed from all models + versions + property names. This fingerprint is stored in IndexedDB and compared on startup — if it differs, a schema migration runs. See `03-indexeddb-and-persistence.md`.

## Decorators in Detail

### `@ClientModel`

```typescript
@ClientModel({ name: "Issue", loadStrategy: LoadStrategy.Eager, usedForPartialIndexes: true })
export class Issue extends BaseModel { ... }
```

Registers the class with the registry. `name` is the registry key — what `ModelMeta.name` becomes, what cross-references resolve against, and the handle for `useRecord(Issue, …)`. It defaults to `ctor.name`, but **minifiers mangle class names in production**, so pass an explicit `name` (or configure your bundler's `keep_classnames`) for any shipped build. Omitting it logs a one-time dev warning. The `loadStrategy` controls when instances are loaded into memory — see `04-lazy-loading.md` for the full breakdown of strategies.

Available strategies: `Eager` (the default — in bootstrap, fully resident), `Lazy` (whole table fetched on first access), `Partial` (only the on-demand subset), `LocalOnly` (persisted to IDB but never synced), and `Ephemeral` (pool-only, never touches IDB; typically fed by `ModelStream` — live metrics, computed results).

`usedForPartialIndexes: true` means other models can use this model's ID fields as index keys in IndexedDB (used by `RefCollection` queries).

`eviction` controls the declarative eviction policy. Set `false` to exempt a model from eviction entirely. Set `{ syncGroupKey: "teamId" }` to auto-evict records when the matching sync group is deactivated. Set `{ maxResident: 500 }` to cap the pool size with FIFO watermark eviction. Both options can be combined. See `02-object-pool.md` and `04-lazy-loading.md` for details.

#### Abstract base classes

`@Property` / `@Reference` / `@Action` / `@Computed` and friends do **not** register a model on their own. They stash their metadata in a per-class side-table; only `@ClientModel` registers a model and at that point drains the side-table for the concrete class plus every ancestor up the prototype chain. So you can declare shared fields on an abstract base without registering it:

```ts
abstract class TaskBase extends BaseModel {
  @Property() public title = "";
  @Property({ indexed: true }) public projectId = "";
}

@ClientModel({ name: "Issue", loadStrategy: LoadStrategy.Eager })
export class Issue extends TaskBase {
  @Property() public priority = 0;
}

@ClientModel({ name: "Bug", loadStrategy: LoadStrategy.Eager })
export class Bug extends TaskBase {
  @Property() public severity = 0;
}
```

`Issue`'s registry entry contains `title` + `projectId` + `priority`; `Bug`'s contains `title` + `projectId` + `severity`. `TaskBase` itself never appears in `ModelRegistry.allModels()`. Subclass-declared properties win when a name collides.

### `@Property`

```typescript
@Property({ indexed: true })
public teamId: string | null = null;

@Property({ serializer: dateSerializer, deserializer: dateDeserializer })
public createdAt: Date = new Date();
```

Marks a field as persisted and observable.

- `indexed: true` → IndexedDB creates a secondary index on this field. Enables fast `readModelsByIndex("Issue", "teamId", "team-123")` instead of full table scan.
- `serializer/deserializer` → custom JSON conversion. Dates get stored as ISO strings and deserialized back to `Date` objects on hydration.

### `@EphemeralProperty`

```typescript
@EphemeralProperty()
public lastUserInteraction: Date | null = null;
```

Observable but **never persisted** to IndexedDB and never sent to the server. Lives in memory only. Good for UI state that should be reactive but doesn't belong in the database — hover state, loading flags, etc.

### `@Reference`

```typescript
@Property({ indexed: true })
public teamId: string | null = null;

@Reference("Team", { onDelete: "cascade" })
public team: Team;
```

This is a two-part declaration. You define the raw ID field with `@Property`, and then `@Reference` promotes it into a relationship. At runtime, `issue.team` becomes a virtual getter that calls `objectPool.getById("Team", this.teamId)` — an O(1) lookup with no async required.

The `onDelete` option tells the engine what to do when the referenced model is deleted:

- `"cascade"` — delete this model too (e.g., delete Issue when Team is deleted)
- `"nullify"` — set the ID field to null (e.g., clear `assigneeId` when User is deleted)
- `"restrict"` — throw a `RestrictDeleteError` if any instance still holds this reference (i.e., you must clean up first)

The `@Reference` getter is reactive to pool identity changes (insert / remove / replacement) via per-id MobX atoms — observers reading `issue.team` wake up when the target's pool slot transitions, not just when the FK itself changes. See [10-inverse-links-and-reactivity.md](./10-inverse-links-and-reactivity.md).

### `@LazyReference`

The lazy variant of `@Reference`. Same getter/setter semantics, but `makeModelObservable()` does NOT call `storeManager.getOrLoadById` — the accessor returns whatever's in the pool right now (or `null`). Use when the referenced model is loaded by another path (separate fetch, lazy hook, etc.). See `04-lazy-loading.md`.

### `@ReferenceArray`

```typescript
@ReferenceArray("Label")
public labelIds: string[] = [];
```

The parent stores an array of IDs directly on itself. The decorator creates a virtual getter `labels` that resolves each ID from the pool. Unlike `@ReferenceCollection`, the IDs live on the parent — not on the children.

### `@ReferenceCollection` / `@LazyReferenceCollection`

```typescript
@ReferenceCollection("Issue", { inverseOf: "teamId" })
public issues: RefCollection<Issue>;
```

One-to-many where the **foreign key lives on the child**. `team.issues` is a `RefCollection` (the runtime class) that exposes `.items`, `.load()`, `.isLoaded`, etc.

- `@ReferenceCollection` — eager. `makeModelObservable()` fires `.load()` so children land in the pool alongside the parent. Recursion is automatic: each loaded child runs its own `makeModelObservable`, so eager relationships nested further down the tree also load.
- `@LazyReferenceCollection` — lazy. Collection stays Idle until something triggers `.load()` or the `useRelation` hook subscribes.

The `inverseOf` FK isn't only used for IDB queries — the pool also uses it to keep `team.issues.items` reactive to delta inserts/deletes/FK changes without a re-fetch. See [10-inverse-links-and-reactivity.md](./10-inverse-links-and-reactivity.md). And see [04-lazy-loading.md](./04-lazy-loading.md) for the loading machinery.

### `@BackReference`

```typescript
@BackReference("Favorite", "issueId")
public favorite: BackRef;
```

The inverse of a `@Reference`. Means: "find the Favorite record that has `issueId` pointing to me." This is also an ownership relationship — when this Issue is deleted, the engine will cascade-delete the Favorite. Like `@ReferenceCollection`, the pool keeps `issue.favorite.value` in sync with the inverse FK automatically — see [10-inverse-links-and-reactivity.md](./10-inverse-links-and-reactivity.md).

### `@OwnedCollection` / `@LazyOwnedCollection`

```typescript
@Property()
public memberIds: string[] = [];

@OwnedCollection("User", { idsField: "memberIds" })
public members: OwnedRefs<User>;
```

The parent stores an array of child IDs directly as a `@Property`. The decorator turns that array into a runtime `OwnedRefs` collection that resolves IDs from the pool / IDB. When the array changes, the collection reflects it on next load.

- `@OwnedCollection` — eager. `makeModelObservable()` fires `.load()` to pull owned items into the pool alongside the parent.
- `@LazyOwnedCollection` — lazy. Collection stays Idle until `.load()` is called.

### `@Action`

```typescript
@Action
moveToTeam(newTeamId: string) {
  this.teamId = newTeamId;
}
```

Wraps the method in a MobX `action()`. This batches all property changes inside the method into a single notification — instead of one re-render per property set, there's one re-render for the entire method call.

### `@Computed`

```typescript
@Computed
get identifier() {
  return `${(this.teamId ?? "").slice(0, 4)}-${this.sortOrder}`;
}
```

Wraps the getter in MobX `computed()`. The value is memoized and only re-evaluated when its tracked dependencies (`teamId`, `sortOrder`) change. Components that read `issue.identifier` only re-render when those fields change — not on every unrelated property change.

## Editing models: `assign`, `save`, `discardUnsavedChanges`

`BaseModel` has exactly one staging primitive and one commit primitive — nothing both stages and commits:

- **`model.assign(data)`** — bulk-stage field changes on the in-memory instance, tracked in `pendingChanges`. **Does not enqueue a transaction.** Visible locally; commit with `save()` (or an enclosing `StoreManager.atomic()` / `store.batch()`), or roll back with `discardUnsavedChanges()`.

- **`model.save()`** — flush `pendingChanges` to the transaction queue at the current boundary. On a not-yet-pooled instance (`store === null`) it routes through `commitCreate` instead — this is the create path `store.<entity>.create` / `draft(input).save()` compose.

- **`model.discardUnsavedChanges()`** — drop staged changes, reset to the last-saved values.

> The schema-first surface wraps these as `store.<entity>.create / patch / draft / delete / archive` — see [11-schema-first-authoring.md](11-schema-first-authoring.md).

The optimistic flow lets you stage a multi-step user action and commit-or-discard at the boundary:

```typescript
storeManager.atomic(async () => {
  book.assign({ title: "X" });
  issue.assign({ status: "done" });
  await api.someServerCall();
  // resolve → save() runs on every touched model, in one batch
});
// throw inside the callback → discardUnsavedChanges() runs on every touched model
```

If a delta packet arrives during the `await` for a field you've optimistically edited, `pendingChanges` rebases its baseline to the server value while keeping your optimistic value visible — so a later discard lands on server truth, not the stale pre-edit value. Echoes of your own change are no-ops.

`runUndoable` side effects pass through `atomic` unchanged: their server mutation is **not** rolled back when the block throws — you must compensate manually if needed.

## How Hydration Works

When the engine loads a raw record from IndexedDB or a server response, it calls `model.hydrate(data)` on a new or existing instance. Hydration runs the deserializers, sets property values, and resolves references via the pool.

```
Raw JSON from server or IDB:
{ id: "issue-1", title: "Fix bug", teamId: "team-eng", createdAt: "2024-01-15T..." }
        │
        ▼
model.hydrate(data)
        │
  ├─ id, title, teamId set directly
  ├─ createdAt: dateDeserializer("2024-01-15T...") → Date object
  └─ team: virtual getter set up → resolves pool.getById("Team", "team-eng")
        │
        ▼
Pool.put("Issue", model)  →  notify listeners  →  React re-renders
```

The model is observable (via MobX) from this point forward. Any subsequent property change fires reactivity.
