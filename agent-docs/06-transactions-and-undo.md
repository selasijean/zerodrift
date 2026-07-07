# Transactions and Undo/Redo

Every user edit goes through the `TransactionQueue` (`core/TransactionQueue.ts`). It's responsible for batching changes, sending them to the server, caching them for offline resilience, and powering undo/redo.

## Transaction Types

Defined in `core/Transaction.ts`. There are four, matching the four write operations:

| Type | Server action | Description |
|---|---|---|
| `CreateTransaction` | `"I"` (Insert) | New model instance created |
| `UpdateTransaction` | `"U"` (Update) | Existing model properties changed |
| `DeleteTransaction` | `"D"` (Delete) | Model permanently deleted |
| `ArchiveTransaction` | `"A"` (Archive) | Model soft-deleted (hidden but retrievable) |

Every transaction records:
- `modelId` and `modelName` — which instance
- `batchId` — groups related transactions for atomic undo
- `state` — current lifecycle stage
- `idbKey` — handle to the cached record in IDB (for crash recovery)
- `syncIdNeededForCompletion` — the server sync ID this transaction is waiting for

`UpdateTransaction` additionally stores a `changes` map:
```typescript
changes: Map<string, { oldValue: unknown; newValue: unknown }>
// "title" → { oldValue: "Old Title", newValue: "New Title" }
// "priority" → { oldValue: 0, newValue: 2 }
```

This is what makes undo possible — each field change has its inverse.

`DeleteTransaction` stores a full `snapshot` of the model at deletion time. Undo restores from this snapshot.

## Transaction Lifecycle

```
User calls issue.save()
        │
        ▼
TransactionQueue.enqueueUpdate()
        │
        ▼
state: Pending
  │ (cached in IDB for crash recovery)
  │ (added to undoStack)
  │ (debounce 50ms)
        │
        ▼
state: Executing  ← HTTP POST batch to server
        │
  ┌─────┴──────────────────┐
  │ server ACK             │ network error / server reject
  ▼                        ▼
state: CompletedButUnsynced    state: Failed (or back to Pending for retry)
  │ (moves to awaitingSync)
  │ (waits for SSE delta with matching syncId)
        │
        ▼
state: Completed  ← SSE delta received, syncId matched
  │ (removed from IDB __transactions)
```

**CompletedButUnsynced** is a deliberate intermediate state. The server has acknowledged the write, but the SSE delta confirming it hasn't arrived yet. The transaction stays in the `awaitingSync` set until the delta comes in, at which point it's fully done.

This two-step completion ensures the client never gets ahead of its own confirmation — if the SSE delta for your edit also triggers collection invalidations or cascade operations, those all run before your transaction is truly complete.

## Routing commits: `routeCommit`

Wire `advanced.routeCommit` to inspect, suppress, or redirect user-initiated commits before they hit the pool or transaction queue. The hook fires from `commitCreate` (before pool insert + enqueue) and `commitUpdate` (before enqueue), with a discriminated `CommitIntent`:

```ts
new StoreManager({
  workspaceId,
  transport: { bootstrapFetcher },
  advanced: {
    routeCommit: (op) => {
      // op: { kind: "create" | "update", model, modelName, [changes, previousData] }
      if (op.kind === "update" && shouldFork(op.model)) {
        const before = op.previousData(); // lazy — only serializes if called
        const [clone] = store.materializePoolOnly("Object", [{
          ...before,
          id: draftId(op.model.id),
          layerId: "draft",
        }]);
        return {
          action: "redirect",
          modelId: clone.id,
          restoreOriginal: true,
        };
      }
      // returning void lets the engine continue normally
    },
  },
});
```

The return contract is intentionally narrow: return nothing (`void`) to let the original op proceed, `"skip"` to suppress it completely (for `create`, the pool insert is skipped too), or a `{ action: "redirect", modelId, modelName?, restoreOriginal? }` object to enqueue the intent against a different pool model. There is deliberately no `"proceed"` token — absence of a return *is* proceed.

`op.previousData()` (update intents only) is a memoized accessor for the model's serialized state *before* the edit's setters ran — the live instance is already mutated by the time the hook fires. It's a function, not a field, so an adopter that only inspects `changes` pays no serialization cost.

For redirected updates, `restoreOriginal: true` restores the originally edited model's boxes to `oldValue` via `setQuiet`, then the engine replays the `newValue`s onto the target with commit routing temporarily suppressed (so the replay's own `save()` doesn't re-enter `routeCommit` — adopters never need a recursion guard).

A throwing router is caught and routed to `onError` with `kind: "beforeCommit"`; the engine then proceeds as if the hook returned `void`. A redirect whose target model is missing is treated as a failed divert, not a fall-through: it emits `onError`, honors `restoreOriginal` if requested, and **drops the write** rather than silently committing it back onto the source the adopter explicitly diverted away from. An SSE/refresh reconciles the pool.

Delta-driven hydrates and SSE inserts do NOT fire this hook — it's scoped to writes that flow through `BaseModel.save()` / `commitCreate`. Field-value canonicalization belongs in `applyFieldTransforms`; commit redirection (which model gets the transaction) belongs here.

### Materializing earlier: `onModelTouched`

`routeCommit` fires at `save()` — the only point with a complete, clean change set. But sometimes you need a side-effect *before* the commit: e.g. the UI should flip to a draft layer the instant the user starts editing, not after a debounced/explicit save. `advanced.onModelTouched` fires synchronously inside the property setter, on the **clean→dirty transition** (a model's first pending change since its last save/discard):

```ts
new StoreManager({
  workspaceId,
  transport: { bootstrapFetcher },
  advanced: {
    onModelTouched: (model, modelName) => {
      if (onDefaultLayer(model)) {
        store.clonePoolOnly(defaultLayerObjects(), (d) => ({
          ...d, id: draftId(d.id), layerId: "draft",
        }));                       // build the scaffold up front
      }
    },
    routeCommit: (op) => {
      if (op.kind === "update" && onDefaultLayer(op.model)) {
        return { action: "redirect", modelId: draftId(op.model.id), restoreOriginal: true };
      }
    },
  },
});
```

Keep the two split: `onModelTouched` **builds** the redirect target eagerly; `routeCommit` **diverts** the write onto it at save. Don't try to redirect from `onModelTouched` itself — at first-change you have only one property and the user keeps mutating the original instance, so a setter-time redirect would need write-forwarding/identity-swap, which breaks the pool's one-instance-per-id invariant.

Semantics: fires once per dirty cycle (not per property — a second edit while still dirty is silent), and again after a `save()`/`discard` resets `pendingChanges`. It is **suppressed during the engine's own redirect replay** (the `restoreOriginal`+replay path's `assign()` onto the draft target must not surface as a user-facing first edit), and never fires for delta/SSE hydrates (those bypass the setter). A throwing handler is caught and routed to `onError` with `kind: "onModelTouched"`; the setter still completes.

It runs on the setter hot path. The no-config path is a single boolean read (`hasModelTouchedHandler`). If your handler does heavy work (cloning a large layer), note that deferring it with `queueMicrotask` risks a synchronous `save()` in the same tick outrunning it — and `routeCommit`'s missing-target path then *drops* that first write. For autosave/synchronous-save flows, keep the materialization synchronous.

## Batching

`TransactionQueue` debounces flushes by 50ms. This means if you do:

```typescript
issue.title = "A";
issue.priority = 2;
issue.save();
```

...and `save()` creates two `UpdateTransaction`s (one per changed field), they both sit in the `pending` array for 50ms before being sent together as one HTTP request. This reduces network round-trips significantly for operations that change multiple fields rapidly.

## The Batch API for Undo

Individual transactions undo individually. For multi-model operations that should undo atomically, use `batch`:

```typescript
storeManager.batch(() => {
  issue.title = "New Title";
  issue.priority = 2;
  issue.save();

  team.name = "New Team Name";
  team.save();
});

// One undo() call reverts all three changes atomically
```

Internally:

```typescript
beginBatch(): string  // assigns a batchId, starts collecting
endBatch(batchId)    // closes collection, pushes group onto undoStack
```

Every transaction enqueued while a batch is open gets the same `batchId`. They're pushed onto the undo stack as a single `{ kind: "batch", txs: [...] }` entry.

`StoreManager.batch(fn)` wraps any synchronous function in begin/endBatch automatically.

## `optimistic()` — persist-coupled writes

`storeManager.optimistic(mutate, persist)` is the primitive for "optimistic mutation + awaited network persist + automatic rollback". `mutate` runs synchronously and its field writes are captured per `(model, field)` with their pre-write values; `persist` then runs with **no transaction scope held**, so any number of operations can be in flight at once. On resolve, exactly the captured fields are committed inside one `batch` (→ one undo entry); on reject, they're compare-and-reverted.

Conflict policy on overlap is field-level last-writer-wins, mirroring SSE rebasing: a commit or rollback touches a field only if it still holds the value that operation wrote. A field re-written by a later operation is left to that operation to settle; a field that was already dirty before `mutate` rolls back to its pre-operation staged value and stays dirty for its original staker — so stacked in-flight edits unwind like savepoints.

Use `optimistic()` instead of awaiting I/O inside `atomic()`: the atomic scope is process-global, and holding it across a round-trip both throws on a second `atomic()` and sweeps unrelated concurrent writes into the scope.

## Choosing between `batch`, `atomic`, and `optimistic`

The three primitives operate at different layers of the write pipeline: `batch` groups **commits**, `atomic` manages **staging**, `optimistic` ties staging to a **persist call**.

- **`batch(fn)`** doesn't stage, track, or revert anything. You make every commit yourself (`save()`, `store.<entity>.create/delete`, `runUndoable`), and everything committed inside shares one `batchId` — one HTTP POST, one undo entry. A throw inside `fn` does **not** roll anything back; `endBatch` just closes the group.
- **`atomic(fn)`** owns the save/discard decision. You only stage inside it (setters, `assign` — no `save()` calls); at the boundary it `save()`s every touched model or discards every touched model. Its commit path runs inside a `batch()` internally — that's where its one-undo-entry property comes from. `atomic` is built on top of `batch`, not beside it.
- **`optimistic(mutate, persist)`** scopes the commit-or-revert decision to a network call, at field granularity (see above).

| you're writing… | use |
|---|---|
| explicit `save()` / `create()` / `delete()` calls that should undo as one step and POST together | `batch` |
| staged edits that should all commit or all revert together | `atomic` |
| a staged edit whose fate depends on your own network call | `optimistic` |

Two asymmetries worth knowing:

- **Async:** `batch`'s async overload is safe in a way `atomic`'s isn't. A batch held across an `await` can't corrupt state — worst case, an unrelated `save()` lands in the same undo entry and they undo together. An atomic held across an `await` decides *commit vs. revert* for any tracked write that lands during the window — keep `atomic` callbacks synchronous and reach for `optimistic` when there's I/O. (Both throw on a second concurrent open: `TransactionQueue` allows one active batch at a time.)
- **Rollback scope:** `atomic`'s rollback discards a touched model's *entire* pending state, including edits staged before the block started. `optimistic`'s rollback is surgical — it reverts exactly the fields its mutate wrote and leaves pre-existing staged edits (and later writers' values) alone.

## Undo/Redo

The undo stack is an array of entries, each either `{ kind: "single", item }` or `{ kind: "batch", batchId, entries }`. `item` and `entries` hold `BaseTransaction | UndoableAction` — model transactions and remote actions sit on the same stack so a single user action that mixes both undoes atomically. See "Undoable remote actions" below for the `UndoableAction` side.

### Undo

```typescript
const entry = undoStack.pop();
redoStack.push(entry);

// For each item in the entry (reversed order):
//   UpdateTransaction: revert model to oldValue, enqueue inverse update
//   DeleteTransaction: re-create model from snapshot, enqueue create
//   CreateTransaction: delete model, enqueue delete
//   UndoableAction:    invoke undoableActions.undo(action) — consumer
//                      makes the compensating server call
```

Crucially, `undo()` doesn't just revert the in-memory model — it **enqueues inverse transactions to the server**. The undo is persistent and synced. If you undo a title change, every other client sees the revert via SSE.

The inverse transactions are enqueued with `suppressUndoStack = true` so they don't push onto the undo stack themselves (otherwise undoing would create undoable undos, which breaks the stack invariant).

### Redo

```typescript
const entry = redoStack.pop();
undoStack.push(entry);

// For each transaction in the entry:
//   Re-apply the original change (revert the revert)
//   Enqueue the original transaction values to the server
```

Any new user edit after an undo clears the redo stack — standard undo/redo behavior.

### The `useUndoRedo` Hook

```typescript
const { undo, redo, canUndo, canRedo } = useUndoRedo();
```

`canUndo` and `canRedo` are reactive — components re-render when the stacks change. This is how the Undo/Redo buttons in the demo app enable/disable themselves. The hook is unchanged when undoable actions are mixed in — depths cover both `BaseTransaction` and `UndoableAction` entries.

## Undoable remote actions

Some user actions are committed by a non-model server endpoint that returns a `changeLogId` rather than by editing a model and letting the engine flush a transaction (e.g. bulk-mutation endpoints, server-side workflows, archive/restore APIs that span hundreds of rows). To put these on the same undo stack as model edits:

```typescript
const { archivedCount } = await sm.runUndoable(
  () => api.bulkArchive({ teamId }),    // returns { changeLogId, archivedCount }
  { actionType: "bulkArchive" },
);
```

`runUndoable(fn, opts?)` awaits `fn`, extracts a `changeLogId` (either the string returned directly or the `changeLogId` field of the returned object), records an `UndoableAction` on the stack, and returns whatever `fn` returned. If `fn` throws, nothing is recorded — failed API calls never leave dangling stack entries.

Inside an open `batch()`, the action joins the active batch and undoes alongside the model transactions in reverse insertion order.

### Configuring the handlers

The engine itself doesn't know how to undo a `changeLogId` — the consumer does. Wire handlers on `advanced.undoableActions`:

```typescript
new StoreManager({
  workspaceId,
  transport: { bootstrapFetcher },
  advanced: {
    undoableActions: {
      undo: async (action) => {
        const r = await api.changeLog.undo(action.changeLogId);
        return { ...action, changeLogId: r.compensatingChangeLogId };
      },
      redo: async (action) => {
        const r = await api.changeLog.redo(action.changeLogId);
        return { ...action, changeLogId: r.compensatingChangeLogId };
      },
    },
  },
});
```

Each handler returns the compensating `UndoableAction` so the engine can place it on the opposite stack. Returning `void` is fine when the same `changeLogId` is replayable in either direction — the original entry is reused.

### Failure routing

When the consumer's handler throws, the engine routes through `onError` with `kind: "undoableAction"`:

```typescript
onError: (err, ctx) => {
  if (ctx.kind === "undoableAction") {
    // ctx.phase: "undo" | "redo"
    // ctx.changeLogId, ctx.actionType
    toast.error(`Couldn't ${ctx.phase}: ${err.message}`);
  }
},
```

The entry still moves to the opposite stack so the user can retry. Mid-batch handler failures are logged and the rest of the batch continues — already-applied items stay applied. If `redo` is omitted from `undoableActions` and a redo of an action entry is attempted, the same context fires with a "no handler configured" error.

### Persistence

`UndoableAction`s are **not** cached in IDB. The cached-transaction store exists to resend mutations the server hasn't confirmed; an action's API call has already returned a `changeLogId`, so there's nothing to resend. Like the rest of the undo stack, action entries live in memory only and are lost on reload.

## Undoable remote deltas (`advanced.remoteUndo`)

`runUndoable` covers side-effects *this client* initiated. `remoteUndo` covers the inverse direction: **server-pushed deltas** — e.g. an agent streaming edits into the workspace — that the local user should be able to undo with one keystroke.

```typescript
new StoreManager({
  workspaceId,
  transport: { bootstrapFetcher, syncUrl },
  advanced: {
    remoteUndo: {
      // Which incoming delta actions are user-undoable?
      evaluate: (ctx) => ctx.data?.actorId === agentId,
      // Server-side revert, keyed by the packet's syncId. The engine has
      // already applied the local revert optimistically before this runs.
      undo: async (action) => {
        const r = await api.revertSync(action.syncId);
        return { compensatingSyncId: r.syncId };
      },
      redo: async (action) => {
        const r = await api.reapplySync(action.syncId);
        return { compensatingSyncId: r.syncId };
      },
    },
  },
});
```

### Capture

`SyncConnection` offers every action of an incoming packet to `evaluate` **before** the delta touches IDB or the pool — that's the only moment the pre-delta state (the undo baseline) is still readable. The context carries `{ syncId, action, modelName, modelId, data, previousData }`; `previousData()` lazily serializes the pooled instance (`null` when not pooled) and is only meaningful while `evaluate` runs.

A `true` return captures the inverse as a `RemoteChange`:

| Delta action | Captured inverse |
|---|---|
| Update onto an existing record (any data-bearing action, including `"I"` applied as a merge) | Per-field `before`/`after` maps, restricted to fields the delta actually moves — no-op deltas aren't tracked |
| `"I"` (fresh insert) | The inserted record; undo = delete |
| `"D"` / `"A"` | Full pre-delete snapshot; undo = restore |

All captures from one packet form a **single atomic entry** (a `RemoteUndoAction`, `source: "remote"`) on the same undo stack as model transactions, keyed by the packet's `syncId`.

The engine pre-filters only packets it **provably owns**:
- Packets whose `syncId` matches an `awaitingSync` transaction — echoes of this client's own writes, already undoable as local transactions.
- Packets whose `syncId` was returned as `compensatingSyncId` by a previous `undo`/`redo` handler call — consumed one-shot so the engine's own reverts aren't re-tracked.

Everything else reaches `evaluate`. The engine deliberately reads nothing more into the packet — action codes can't establish ownership (one client's write confirmation is every other client's remote edit), so distinguishing echoes from remote edits is the evaluator's job, via metadata the server puts in the delta (e.g. an `actorId`/`userId` field). This also covers the race where an echo outruns its HTTP ACK: the engine's syncId gate can't catch it, but an actor check does.

### Undo / redo semantics

`undo()` of a remote entry is **optimistic-local-first**: revert pool + IDB from the captured inverses (reverse order, full-record write via the pooled instance, read-modify-write when not pooled, IDB skipped for Ephemeral models), *then* call `remoteUndo.undo(action)`. No transaction is enqueued — the server-side revert is entirely the handler's job.

Failure semantics differ deliberately from `undoableActions`: if the handler throws (or `redo` is attempted with no handler configured), the local revert is **rolled forward again** — the server still holds the remote edit and stays the source of truth — the entry **stays on its original stack** for retry, `undo()` returns `null`, and `onError` fires with `kind: "remoteUndo"` (`phase: "evaluate" | "undo" | "redo"`). A permanently failing revert endpoint therefore blocks that entry; there is no skip API yet.

Other behavioral notes:
- Remote entries never join an open `batch()` (deltas arrive outside any user action) and — unlike user edits — do **not** clear the redo stack.
- On successful undo the entry moves to the redo stack; `redo` re-applies the delta locally and calls `remoteUndo.redo`.
- Local reverts don't run cascade deletes; the server's compensating deltas reconcile any children.
- `TransactionQueue.remoteUndoDepth` (surfaced through `useUndoRedo().remoteUndoDepth` and `StoreManager.status()`) counts remote entries currently on the undo stack, so a UI can badge "N agent edits" independently of `canUndo`.
- Like `UndoableAction`s, remote entries are memory-only — not cached in IDB, lost on reload.
- Rebase interplay: if the user has a pending local change on a field the tracked delta also touches, `previousData()` (and the captured `before`) reflect the user's optimistic value — undoing the remote entry won't clobber the user's edit, and the server-side revert rebase-reapplies it as usual.

### Supersession rebasing

Just as `rebaseAll` keeps in-flight transactions' undo baselines current, incoming deltas keep remote entries truthful — but with different arithmetic, because a remote entry's local revert is a *prediction* of the server's revert-by-syncId, not a last-writer-wins re-assertion.

When a **foreign, untracked** data-bearing action arrives (one that neither got captured into its own entry nor belongs to this client — own echoes and undo compensations are exempt), every remote entry on either stack is rebased for that `(modelName, modelId)`:

| Tracked change | Effect of the foreign edit |
|---|---|
| `"U"` | Any field the foreign edit moved to a value matching *neither* the entry's `after` *nor* its `before` is **pruned** from the entry — the tracked edit no longer owns it, so undo won't clobber the newer value and a failed undo's rollback can't resurrect the stale one. A change whose fields all prune is removed; the entry itself stays (the server-side revert by syncId is still meaningful). |
| `"I"` | The foreign fields merge into the stored record so a later redo re-inserts fresh data. Undo (= delete) is unaffected. |
| `"D"` / `"A"` (undo stack only) | The delete's snapshot-restore is dropped — a data-bearing delta for that id means the record exists again server-side, and restoring the stale snapshot would clobber it. On the redo stack the restore already ran, so redo's re-delete stays valid. |

**Tracked** deltas are deliberately exempt: two tracked agent edits on the same field unwind correctly in LIFO order (undo the newer entry first, then the older), so pruning the older entry would break the chain. Likewise the compensation echo of your own undo must not prune the redo entry, or redo would lose its optimistic local replay.

## Offline Resilience

Every `enqueue()` call writes the serialized transaction to IDB's `__transactions` store:

```typescript
tx.idbKey = await db.cacheTransaction(tx.serialize());
```

If the app closes before flushing (tab crash, network drop), the transaction is durable. On next startup, `TransactionQueue.resendCached` re-reads `__transactions` from IDB and decides what to do with each entry — see "Crash recovery" below.

The cache record is **kept** through the `CompletedButUnsynced` window: when the server ACKs, instead of deleting the record, the queue updates it to set `syncIdNeededForCompletion`. The record is only removed once the matching SSE delta arrives and `resolveBySync` resolves the transaction. This way a crash between server-ACK and SSE-delta is recoverable.

## Crash recovery: the SyncAction store

The engine persists every server-confirmed sync action header into a separate IDB store (`__syncActions`) — one row per `(syncId, modelName, modelId, action)` tuple. This is a **change log**, not a snapshot, and it's what makes `resendCached` correct across crashes:

| Cached record's state | Recovery action |
|---|---|
| Has `syncIdNeededForCompletion` AND `__syncActions` contains that syncId | Drop. The server ack'd and the matching delta already landed. |
| Has `syncIdNeededForCompletion` but no matching syncId yet | Restore to `awaitingSync` in memory; do NOT resend. Wait for the next catchup delta. |
| No `syncIdNeededForCompletion`; target's `__syncActions` history shows a `D` or `A` while we were away | Drop. Emit a `transactionDiscarded` error (`reason: "target-deleted"`) so adopters can surface "your edit was discarded because the model was deleted". |
| No `syncIdNeededForCompletion`; target alive | Re-enqueue as `Pending` and flush. |

The store is pruned periodically: every ~1000 syncIds of advancement, anything older than `lastSyncId − 10000` is dropped (`SYNC_ACTION_PRUNE_MARGIN`). The 10k margin covers short offline gaps where a persisted-but-unsent tx checks the log for a delete of its target.

Adapter contract: `recordSyncActions`, `hasSyncAction`, `findSyncActionsForModel`, `pruneSyncActionsBelow`, plus `updateCachedTransaction` (to flag a cached record as awaiting-sync without removing it). All on the public `StorageAdapter` interface so any backend (SQLite, Redis, etc.) supports the same recovery semantics.

## Conflict Handling (Rebase)

If a delta packet arrives from the server for a model you have a pending `UpdateTransaction` for, there's a conflict: the server has a newer baseline than you assumed.

The engine does **last-writer-wins** rebase:

```
Your pending update: title = "My Title" (based on old title "Original")
Server delta arrives: title = "Server Title", priority = 2

Before rebase:
  tx.changes.title = { oldValue: "Original", newValue: "My Title" }

After rebase:
  tx.changes.title = { oldValue: "Server Title", newValue: "My Title" }
  (old value updated to match server's current state)
  
Apply server delta: title → "Server Title", priority → 2
Re-apply your pending: title → "My Title"

Final state: title = "My Title", priority = 2
```

Your title wins. The server's priority change is kept. The undo for your title change now correctly reverts to "Server Title" (not "Original" — that no longer exists).

This rebase happens in `UpdateTransaction.rebase()` and is called by `TransactionQueue.rebaseAll()` whenever a delta packet touches a model with pending changes.
