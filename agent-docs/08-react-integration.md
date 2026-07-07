# React Integration

The sync engine exposes a React API in `react/index.tsx`. The design goal is: components should be able to read models and collections declaratively, re-render automatically when data changes, and never have to think about when or how to refetch.

## SyncProvider

Wrap your app in `SyncProvider`. It creates the `StoreManager`, runs bootstrap, and provides the engine instance to all children via context.

```typescript
<SyncProvider
  config={{
    workspaceId: "workspace-123",
    transport: { bootstrapFetcher, syncUrl: "/api/events" },
  }}
  fallback={<LoadingScreen />}
>
  <App />
</SyncProvider>
```

- `fallback` renders while bootstrap is in progress (before `Ready` phase)
- Once `Ready`, children render and have full access to the engine
- On unmount, `sm.teardown()` closes the SSE connection and cleans up

### `schema` prop — schema-first wiring

Pass `schema={schema}` (and optionally `extensions={...}`) so the provider runs `createStore({schema, storeManager, extensions})` between `new StoreManager(...)` and `sm.bootstrap()`. That registration order is load-bearing — without it the first bootstrap fetch finds no schema entities. Children read the typed store with `useStore<typeof schema>()`:

```typescript
<SyncProvider schema={schema} config={{ workspaceId, transport: { bootstrapFetcher } }}>
  <App />
</SyncProvider>

// in any child:
const store = useStore<typeof schema>();
const { data: issue } = useRecord(store.issue, issueId);
```

If you also pass `extensions={exts}` to the provider, pass them as the second generic so the typed store includes the extended members: `useStore<typeof schema, typeof exts>()`. Decorator-only setups omit `schema`; `useStore()` throws there. The two paths can also coexist — pass `schema` and side-effect-import decorator models in the same setup; both end up in the shared `ModelRegistry`.

### `context` prop — runtime input for `identifierFn`

`SyncProvider` is generic in `TContext`. When the consumer config supplies an `identifierFn`, the `context` prop is the live value forwarded into it.

```typescript
type AppContext = { userId: string; tenantId: string };

<SyncProvider<AppContext>
  config={{
    workspaceId: "ws-1",
    transport: { bootstrapFetcher },
    advanced: {
      identifierFn: (meta, ctx) =>
        ctx == null
          ? crypto.randomUUID()
          : `${ctx.tenantId}:${meta.name}:${crypto.randomUUID()}`,
    },
  }}
  context={{ userId, tenantId }}
>
  <App />
</SyncProvider>
```

Mechanics:

- The provider seeds the `StoreManager` with the initial `context` during construction (before `bootstrap()` resolves), then pushes updates through `sm.setContext` in a `useLayoutEffect` so handlers fired in the same commit as a context change see the fresh value when minting ids.
- Context is sampled at id-mint time, not captured — hot updates are picked up on the next `new Model()` call.
- `identifierFn` only runs for client-side construction; server- and IDB-hydrated records carry their own ids.

## useSyncEngine

```typescript
const { sm, status } = useSyncEngine();
```

Gives you the raw `StoreManager` and current `status`. You won't need `sm` often — the higher-level hooks cover most cases. `status.phase` is useful if you want to show different UI during different bootstrap phases.

## The hook surface

Four read hooks, plus `useWatch` for field-level reads (see
[§ Field reads and the React Compiler](#field-reads-and-the-react-compiler--usewatch))
and `useUndoRedo` for the transaction stack. Every read hook takes a
**handle** and returns the same `AsyncResource` shape —
`{ data, isLoading, isLoaded, error, reload }` — so consumer code is uniform
regardless of whether the source is the pool, IDB, or the server.

A **handle** is one of:

- a decorator **model class** — `useRecord(Issue, id)`
- a schema **namespace** — `useRecord(store.issue, id)`

Both resolve to the same registry name; the record type is inferred from
whichever form you pass. For a namespace handle the index key is constrained
to the schema's `.indexed()` fields; for a class handle it's `string`.

| Hook | `data` | When the loader fires |
|---|---|---|
| `useRecord(handle, id)` | `T \| null` | `getOrLoadById` only when the pool is missing the entry. In-pool models render with `isLoading: false` from frame zero. |
| `useRecords(handle, ids?)` | `T[]` | No `ids` → reactive snapshot of every instance, no loader. With `ids` → `getOrLoadByIds` only when one is missing. Order follows input `ids`. |
| `useRecordsByIndex(handle, key, value)` | `T[]` | `value` is a string **or** a `string[]`. `getOrLoadCollection` once per `(name, key, value)`, gated by `sm.isCollectionLoaded(...)`; a `string[]` fans out one load per value in parallel. |
| `useRelation(relation)` | `T[]` (collection) or `T \| null` (back-ref) | Wraps a `RefCollection` / `OwnedRefs` / `BackRef` you already hold (e.g. `issue.comments`, `issue.favorite`). Calls `.load()` on mount if not loaded. |

`isLoaded` is true once the first resolve settled without error (a pool hit
counts from frame zero). `reload()` always re-fires regardless of cache
state; auto-fire on mount is gated so cached data doesn't re-scan IDB.

Every read hook takes an optional trailing `opts: { pause?: boolean; gate?: FetchGate }`
(`useRecord(handle, id, opts)`, `useRecords(handle, ids, opts)`,
`useRecordsByIndex(handle, key, value, opts)`, `useRelation(relation, opts)`).
While `pause` is true the hook still reads the pool synchronously — anything
already resident renders — but holds all fetching: auto-fire *and* `reload()`
are suppressed until it flips false, at which point a missing entry backfills
as usual. Use it to defer a fetch until a prerequisite is ready (auth resolved,
a parent record loaded, a panel actually opened).

```typescript
// Don't fetch the comments until the panel is open and the issue has loaded.
const { data: comments } = useRecordsByIndex(store.comment, "issueId", issueId, {
  pause: !panelOpen || issue == null,
});
```

### `gate` — a shared, re-enableable fetch signal

`pause` is a per-call boolean you recompute each render. `gate` is a **`FetchGate`** — a small reactive signal you construct once and hand to as many hooks (and `useRelation` links) as you like; flip it imperatively and every hook holding it resumes or holds in lockstep. Fetching proceeds only when `!pause` **and** the gate is enabled, so the two compose. A gate toggles on and off as often as you want, and only suppresses *new* fetches — anything already in flight runs to completion.

`FetchGate` is just the primitive — `new FetchGate(enabled?)`, `.enable()` / `.disable()` / `.set(bool)`, `.enabled`. You drive it from whatever signal you want; the engine doesn't bake in any particular source. The headline use is **not fetching for off-screen components**, which you wire with your own `IntersectionObserver`.

This stays out of the library on purpose — the source of the signal is yours — but it's a handful of lines to wrap into a hook in your own codebase. A `useVisibilityGate` recipe:

```typescript
import { useCallback, useEffect, useRef } from "react";
import { FetchGate } from "zerodrift/react";

// Userland — copy into your app. Returns a ref to spread on an element and a
// gate that's enabled while that element is on screen.
export function useVisibilityGate(options?: IntersectionObserverInit) {
  const gate = useRef<FetchGate>(null!);
  if (gate.current == null) gate.current = new FetchGate(false); // off until seen
  const optsRef = useRef(options);
  optsRef.current = options;
  const observer = useRef<IntersectionObserver | null>(null);

  // Don't return a cleanup from the callback ref — React 18 ignores it. Instead
  // disconnect the previous observer before (re)observing, and again on unmount.
  const ref = useCallback((el: Element | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (el == null || typeof IntersectionObserver === "undefined") return;
    observer.current = new IntersectionObserver(
      (entries) => gate.current.set(entries.some((e) => e.isIntersecting)),
      optsRef.current,
    );
    observer.current.observe(el);
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  return { ref, gate: gate.current };
}
```

```typescript
function IssueCard({ id }: { id: string }) {
  const { ref, gate } = useVisibilityGate({ rootMargin: "200px" });
  const { data: issue } = useRecord(store.issue, id, { gate });
  const { data: comments } = useRelation(issue?.comments, { gate });
  return <div ref={ref}>{issue?.title} · {comments.length} comments</div>;
}
```

The same gate works for any source — window focus, route changes, a feature flag — and sharing one avoids threading a `pause` boolean through every call and lifting that state up.

> Scope note: a gate gates the **hook-driven** fetches (`useRecord`/`useRecords`/`useRecordsByIndex`/`useRelation`). The *automatic* eager loads the store fires outside React — `@Reference` / `@ReferenceCollection` calling `.load()` inside `makeModelObservable` — are not gated, because those are per-model, not per-component.

```typescript
// Decorator-class handle:
const { data: issue } = useRecord(Issue, issueId);          // Issue | null
const { data: issues } = useRecords(Issue);                 // Issue[]
const { data: some } = useRecords(Issue, ["i1", "i2"]);     // subset, input order
const { data: teamIssues } = useRecordsByIndex(Issue, "teamId", teamId);
const { data: forTeams } = useRecordsByIndex(Issue, "teamId", [t1, t2]); // any-of

// Schema-namespace handle — same hooks, record type + indexed key inferred:
const { data: issue2 } = useRecord(store.issue, issueId);
//        ^? Issue inferred from the schema, incl. singular relations
//           (issue.team) and reverse collections (team.issues.items).
const { data: teams } = useRecords(store.team);
const { data: ti } = useRecordsByIndex(store.issue, "teamId", teamId);
//                                                   ^^^^^^^^ autocompletes to
//                                                   fields marked .indexed().
```

`useRecords` compares `ids` (and `useRecordsByIndex` its values) by content
so inline literals don't re-trigger.

### useRelation — wrapping a runtime collection / back-ref

```typescript
const { data: issue } = useRecord(store.issue, issueId);
const { data: comments, isLoading } = useRelation(issue?.comments); // → Comment[]
const { data: favorite } = useRelation(issue?.favorite);            // → Favorite | null
```

When you already hold the parent record, `useRelation` wraps its
`RefCollection` / `OwnedRefs` (→ `data: T[]`) or `BackRef` (→ `data: T | null`)
directly — passed by reference, so TS narrows the element type from the model
definition. The runtime collection objects own their loading state, and the
inverse-link machinery (see [10-inverse-links-and-reactivity.md](./10-inverse-links-and-reactivity.md)) keeps `data` in sync with the pool — no invalidate / reload on delta.

> A decorator class and a `store.<entity>` namespace are interchangeable
> handles for the same four hooks — both resolve to a registry name and
> share one `useSyncExternalStore + pool.subscribe` path, so there's no
> runtime difference between them.

## useUndoRedo

```typescript
const { undo, redo, canUndo, canRedo, remoteUndoDepth } = useUndoRedo();
```

Exposes the undo/redo stack. `canUndo` and `canRedo` are reactive — they update when the stack changes. Useful for toolbar buttons.

```typescript
<button onClick={undo} disabled={!canUndo}>Undo</button>
<button onClick={redo} disabled={!canRedo}>Redo</button>
```

`remoteUndoDepth` (also reactive) counts tracked remote deltas — server-pushed edits captured via `advanced.remoteUndo`, see [06-transactions-and-undo.md](./06-transactions-and-undo.md#undoable-remote-deltas-advancedremoteundo) — currently on the undo stack. Use it to badge a dedicated "undo agent edit" affordance; `undo()` itself pops the combined stack in order.

## Observation Tracking for Eviction Safety

The read hooks maintain per-instance observation refcounts on the pool, protecting rendered records from being evicted by the declarative eviction policy.

- **`useRecord(handle, id)`** — calls `pool.observeInstance(modelName, id)` in its `useSyncExternalStore` subscribe callback. On cleanup (unmount or id change), calls `pool.unobserveInstance`. The `id != null` guard ensures null/undefined ids don't observe anything.
- **`useRecords(handle, ids?)` and `useRecordsByIndex(handle, key, value)`** — use `useObserveItems`, which diffs the current snapshot IDs against the previous render's IDs in a `useEffect`. New IDs are observed, removed IDs are unobserved. On unmount, all current IDs are unobserved.

Multiple components observing the same record increment the refcount — the record only becomes evictable when all observers unmount. `canEvict` checks `pool.isObserved(modelName, id)` before allowing eviction.

**Self-heal.** `useRecordByName` has a `useEffect` that detects "prevItem was non-null, item is now null, id is non-null." It checks `pool.wasEvicted(modelName, id)` — if true (eviction, not server-side deletion), it calls `pool.clearEvicted` and fires `reload()` to restore the record from IDB or the server.

## Reactivity Model

The reactivity chain for a component using `useRecords(Issue)`:

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

The `getSnapshot()` for `useRecords` returns `pool.getAll("Issue")` — the same array reference if nothing changed, or a new array if anything was added/removed/updated. React uses referential equality on the snapshot to decide whether to re-render. Components reading `team.issues.items` inside a MobX `observer` are woken by the inverse-link layer above instead.

## Field reads and the React Compiler — useWatch

The chain above covers **membership** (records and relation items added /
removed / replaced) — the hooks hand back new array identities and
`useSyncExternalStore` re-renders, no `observer()` needed. **Field-level**
reads are different: pooled records are stable references whose fields update
in place (MobX boxes), so `issue.title` read during render is only reactive
inside a MobX `observer()` wrapper.

The React Compiler breaks `observer()` **silently**. Auto-memoization keys the
dereference on the unchanging `issue` reference, so the memoized block never
re-executes — and since observer works by tracking reads made during render,
the subscription is dropped and the component just stops updating. No error,
no warning.

`useWatch(record, selector)` is the compiler-safe read boundary — the React
counterpart of the imperative `record.watch(selector, cb)`:

```tsx
const { data: issue } = useRecord(store.issue, issueId);
const title = useWatch(issue, (i) => i.title);
const badge = useWatch(issue, (i) => ({ title: i.title, done: i.done }));
```

- The selector runs **inside the library** (`node_modules` is excluded from
  React Compiler transforms); a MobX reaction tracks whatever it reads.
- The result crosses into the component as a **value snapshot**: identity
  changes exactly when the selected contents change (shallow compare by
  default; pass `{ equals: comparer.structural }` for deeply-nested
  selections), stays stable otherwise. Downstream compiler memo cells keyed
  on it recompute at the right times, and unrelated field changes don't
  re-render.
- Components using `useWatch` need no `observer()` wrapper at all, with or
  without the compiler.

**Lists**: membership is already covered by `useRecords` / `useRelation`; put
the field reads in a per-row component (hooks can't run in loops, and this is
the idiomatic list shape anyway — each row re-renders independently):

```tsx
function CommentRow({ comment }: { comment: Comment }) {
  const view = useWatch(comment, (c) => ({ text: c.text, author: c.authorName }));
  return <li>{view.text} — {view.author}</li>;
}

function Comments({ issueId }: { issueId: string }) {
  const { data: issue } = useRecord(store.issue, issueId);
  const { data: comments } = useRelation(issue?.comments);
  return (
    <ul>
      {comments.map((c) => <CommentRow key={c.id} comment={c} />)}
    </ul>
  );
}
```

**Deriving order / filtering from field values** in a parent needs its own
subscription too (the parent only re-renders on membership changes). The
record argument can be the array — the selector's reads are tracked across
every item:

```tsx
const sorted = useWatch(comments, (list) =>
  [...list].sort((a, b) => a.priority - b.priority),
);
```

A `priority` change on any comment re-fires the sort; a result with the same
order shallow-compares equal and keeps its identity, so nothing re-renders.

Teams that keep `observer()` components instead must exclude them from the
compiler (`"use no memo"` directive) — but `useWatch` makes the component
correct under both regimes and is the recommended path.

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

All hooks return empty/null `data` before `status.phase === Ready`. This prevents rendering stale or empty states during bootstrap. `useRecords` returns `{ data: [], … }`, `useRecord` returns `{ data: null, … }`, and so on — the `AsyncResource` shape is always present.

The `SyncProvider`'s `fallback` prop handles showing a loading state during bootstrap. Once `Ready`, the fallback is replaced with the app tree, and all hooks return live data.

## Storybook / testing

Two patterns for rendering components that depend on `<SyncProvider>` without hitting a real backend.

### Pattern A — declarative fixtures via `bootstrapFetcher`

Best when each story has a stable fixture set. The mock data flows through the normal bootstrap path, so coverage state, loaded-models tracking, and IDB are all consistent with a real session.

```tsx
import { SyncProvider } from "zerodrift/react";
import { MemoryAdapter } from "zerodrift";
import "./models";

export const Default = {
  decorators: [
    (Story) => (
      <SyncProvider config={{
        workspaceId: "story",
        persistence: { storageAdapter: new MemoryAdapter() },
        transport: {
          // syncUrl omitted → no SSE connection.
          bootstrapFetcher: async () => ({
            lastSyncId: 0,
            subscribedSyncGroups: [],
            models: {
              Issue: [{ id: "i1", title: "Story issue", teamId: "t1" }],
              Team:  [{ id: "t1", name: "Story team" }],
            },
          }),
        },
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
import { useSyncEngine, SyncProvider } from "zerodrift/react";
import { MemoryAdapter } from "zerodrift";

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
        persistence: { storageAdapter: new MemoryAdapter() },
        transport: {
          bootstrapFetcher: async () => ({
            lastSyncId: 0, subscribedSyncGroups: [], models: {},
          }),
        },
      }} fallback={null}>
        <Seed><Story /></Seed>
      </SyncProvider>
    ),
  ],
};
```

`seed` / `seedMany` are pool-only — no IDB write, no `partialIndexCoverage` mutation, no `loadedModels` change. Re-seeding the same id re-hydrates the existing instance in place (preserves identity, so observers don't tear).
