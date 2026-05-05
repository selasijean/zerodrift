# React Integration

The sync engine exposes a React API in `react/index.tsx`. The design goal is: components should be able to read models and collections declaratively, re-render automatically when data changes, and never have to think about when or how to refetch.

## SyncProvider

Wrap your app in `SyncProvider`. It creates the `StoreManager`, runs bootstrap, and provides the engine instance to all children via context.

```typescript
<SyncProvider
  config={{
    workspaceId: "workspace-123",
    baseUrl: "/api/sync",
  }}
  fallback={<LoadingScreen />}
>
  <App />
</SyncProvider>
```

- `fallback` renders while bootstrap is in progress (before `Ready` phase)
- Once `Ready`, children render and have full access to the engine
- On unmount, `sm.teardown()` closes the SSE connection and cleans up

## useSyncEngine

```typescript
const { sm, status } = useSyncEngine();
```

Gives you the raw `StoreManager` and current `status`. You won't need `sm` often — the higher-level hooks cover most cases. `status.phase` is useful if you want to show different UI during different bootstrap phases.

## The hook surface

Five public hooks for reading data, plus `useUndoRedo` for the transaction stack. Every reading hook returns the same shape — `{ item | items, isLoading, error, reload }` — so consumer code looks uniform regardless of whether the underlying source is the pool, IDB, or the server.

| Hook | What it returns | When the loader fires |
|---|---|---|
| `useModel(name, id)` | `{ item, isLoading, error, reload }` | `loadOne` only when the pool is missing the entry. In-pool models render with `isLoading: false` from frame zero. |
| `useModels(name, ids?)` | `{ items, isLoading, error, reload }` | No `ids` → reactive snapshot of every instance of the type, no loader. With `ids` → `loadByIds` only when at least one id is missing. Items follow the input `ids` order. |
| `useIndexedCollection(name, indexKey, value)` | `{ items, isLoading, error, reload }` | `loadCollection` once per `(name, indexKey, value)` triple, gated by `sm.isCollectionLoaded(...)`. |
| `useCollection(refCollection)` | `{ items, isLoading, isLoaded, error, reload }` | Wraps a `RefCollection` / `OwnedRefs` you already hold (e.g. `team.issues`). Calls `.load()` on mount if not yet loaded. |
| `useBackRef(backRef)` | `{ value, isLoading, isLoaded, error, reload }` | Wraps a `BackRef` (e.g. `issue.favorite`). Calls `.load()` on mount if not yet loaded. |

`reload()` always re-fires the loader regardless of cache state. Auto-fire on mount is gated, so already-cached data doesn't trigger a redundant IDB scan.

```typescript
// Pool-first read of a single model; falls back to loadOne on pool miss.
const { item: issue } = useModel<Issue>("Issue", issueId);

// All Issues in the pool, reactive.
const { items: issues } = useModels<Issue>("Issue");

// Specific subset by id, in input order, with async backfill for any missing.
const { items } = useModels<Issue>("Issue", ["i1", "i2"]);

// Query by FK index — useful when you don't hold the parent model.
const { items } = useIndexedCollection<Issue>("Issue", "teamId", teamId);
```

`useModels` compares `ids` by content (joined string) so inline literals don't re-trigger. `useIndexedCollection` gates auto-fire on `sm.isCollectionLoaded(...)` so remounts don't re-scan IDB.

### useCollection / useBackRef — wrapping a runtime collection

```typescript
const { item: team } = useModel<Team>("Team", teamId);
const { items, isLoading } = useCollection<Issue>(team?.issues);

const { item: issue } = useModel<Issue>("Issue", issueId);
const { value: favorite } = useBackRef<Favorite>(issue?.favorite);
```

When you already have the parent model, these wrap its `RefCollection` / `OwnedRefs` / `BackRef` directly. The collection is passed by reference, not by name, so TypeScript narrows the element type from the model definition. The runtime collection objects own their loading state, and the inverse-link machinery (see [10-inverse-links-and-reactivity.md](./10-inverse-links-and-reactivity.md)) keeps `items` / `value` in sync with the pool — no invalidate / reload needed on delta.

## Schema-first hooks — `useDb*`

If you author models via [`defineSchema(...)`](11-schema-first-authoring.md), three additional hooks accept the typed `db.<entity>` namespace directly. They infer the record type from the namespace and constrain the index key against the schema's `.indexed()` fields.

```typescript
import { useDbModel, useDbModels, useDbIndexedCollection } from "sync-engine/react";

const { item: issue } = useDbModel(db.issue, issueId);
//        ^? Issue inferred from the schema, including singular relations
//           (issue.team) and reverse collections (team.issues.items).
const { items: teams } = useDbModels(db.team);
const { items: teamIssues } = useDbIndexedCollection(db.issue, "teamId", teamId);
//                                                            ^^^^^^^^ autocompletes to
//                                                                     fields actually
//                                                                     marked .indexed().
```

Same return shape and reactivity contract as the string-keyed hooks (`{ item | items, isLoading, error, reload }`). Internally they extract the registry name from the namespace and delegate to `useModel` / `useModels` / `useIndexedCollection`, so the underlying `useSyncExternalStore + pool.subscribe` plumbing is identical — there's no separate runtime path.

Both hook families coexist; pick whichever matches your authoring style. Decorator-defined models keep using the string-keyed hooks; schema-first apps pick up `useDb*` for autocomplete and the typed indexed-key constraint.

## useUndoRedo

```typescript
const { undo, redo, canUndo, canRedo } = useUndoRedo();
```

Exposes the undo/redo stack. `canUndo` and `canRedo` are reactive — they update when the stack changes. Useful for toolbar buttons.

```typescript
<button onClick={undo} disabled={!canUndo}>Undo</button>
<button onClick={redo} disabled={!canRedo}>Redo</button>
```

## Reactivity Model

The reactivity chain for a component using `useModels("Issue")`:

```
Delta packet arrives
        │
SyncConnection.processDeltaPacket()
        │
pool.put("Issue", updatedIssue)
        │
   ├─ inverse-link maintenance: parent collections updated
   ├─ per-id MobX atom bumped (wakes @Reference observers)
   └─ pool.notify("Issue") fires per-type listeners
        │
useSyncExternalStore detects callback fired, calls getSnapshot()
        │
React compares new snapshot to previous
  → snapshot changed → re-render
  → snapshot same   → no re-render
```

The `getSnapshot()` for `useModels` returns `pool.getAll("Issue")` — the same array reference if nothing changed, or a new array if anything was added/removed/updated. React uses referential equality on the snapshot to decide whether to re-render. Components reading `team.issues.items` inside a MobX `observer` are woken by the inverse-link layer above instead.

## Writing Data

Writing doesn't go through a hook — you just mutate model instances and call `save()`:

```typescript
const { sm } = useSyncEngine();

const handleRename = (issue: Issue, newTitle: string) => {
  (issue as any).title = newTitle;
  issue.save();
};

const handleDelete = (issue: Issue) => {
  sm.deleteModel(issue);
};
```

`issue.save()` creates and enqueues an `UpdateTransaction`. The pool is updated optimistically — the component re-renders immediately with the new value before the server round-trip completes. If the server rejects, the transaction reverts and the UI rolls back.

For multi-model atomic operations:

```typescript
sm.batch(() => {
  issue.title = "X";
  issue.save();
  team.name = "Y";
  team.save();
});
// Both changes undo together as one undo step
```

## Phase-Gated Returns

All hooks return empty/null data fields before `status.phase === Ready`. This prevents rendering stale or empty states during bootstrap. `useModels` returns `{ items: [], … }`, `useModel` returns `{ item: null, … }`, and so on — the wrapper shape is always present.

The `SyncProvider`'s `fallback` prop handles showing a loading state during bootstrap. Once `Ready`, the fallback is replaced with the app tree, and all hooks return live data.

## Storybook / testing

Two patterns for rendering components that depend on `<SyncProvider>` without hitting a real backend.

### Pattern A — declarative fixtures via `bootstrapFetcher`

Best when each story has a stable fixture set. The mock data flows through the normal bootstrap path, so coverage state, loaded-models tracking, and IDB are all consistent with a real session.

```tsx
import { SyncProvider } from "sync-engine/react";
import { MemoryAdapter } from "sync-engine";
import "./models";

export const Default = {
  decorators: [
    (Story) => (
      <SyncProvider config={{
        workspaceId: "story",
        storageAdapter: new MemoryAdapter(),
        bootstrapFetcher: async () => ({
          lastSyncId: 0,
          subscribedSyncGroups: [],
          models: {
            Issue: [{ id: "i1", title: "Story issue", teamId: "t1" }],
            Team:  [{ id: "t1", name: "Story team" }],
          },
        }),
        // syncUrl omitted → no SSE connection.
      }} fallback={null}>
        <Story />
      </SyncProvider>
    ),
  ],
};
```

### Pattern B — imperative seed via `sm.seed`

Best for stories that mutate pool state mid-render or want to compose fixtures from other sources. `sm.seed(modelName, records)` and `sm.seedMany({Name: [...]})` accept the same shape as `bootstrapFetcher`'s `models` field — fixtures are portable between the two patterns.

```tsx
import { useEffect } from "react";
import { useSyncEngine, SyncProvider } from "sync-engine/react";
import { MemoryAdapter } from "sync-engine";

function Seed({ children }: { children: React.ReactNode }) {
  const { sm } = useSyncEngine();
  useEffect(() => {
    sm.seedMany({
      Issue: [{ id: "i1", title: "Updated mid-story", teamId: "t1" }],
      Team:  [{ id: "t1", name: "Engineering" }],
    });
  }, [sm]);
  return <>{children}</>;
}

export const Default = {
  decorators: [
    (Story) => (
      <SyncProvider config={{
        workspaceId: "story",
        storageAdapter: new MemoryAdapter(),
        bootstrapFetcher: async () => ({
          lastSyncId: 0, subscribedSyncGroups: [], models: {},
        }),
      }} fallback={null}>
        <Seed><Story /></Seed>
      </SyncProvider>
    ),
  ],
};
```

`seed` / `seedMany` are pool-only — no IDB write, no `partialIndexCoverage` mutation, no `loadedModels` change. Re-seeding the same id re-hydrates the existing instance in place (preserves identity, so observers don't tear).
