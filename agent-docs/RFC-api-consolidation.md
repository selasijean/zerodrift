# RFC — Public API Consolidation (1.0)

**Status:** Draft. Not yet implemented. Pre-publish (package is `0.1.0`, never released), so this is a single clean-cut rename — no deprecation layer, no codemod, no compatibility shims. Decorator and schema authoring both keep working; only their spellings change.

## Goal

Collapse the public surface so one concept has one name across every layer, and so a write's commit behavior is readable from the method that performs it. Today the same operation is spelled four different ways (StoreManager / schema store / string hooks / typed hooks) and `create`/`update` silently auto-commit while field mutation stages — with nothing in the name to signal which. This RFC fixes both, plus a set of smaller surface inconsistencies, and curates what we promise to keep stable.

Net target: ~30 public read/write entry points → ~12; one vocabulary across imperative + React; one commit rule; a typed primary path for both authoring styles. Because nothing depends on the package yet, every change below is a direct replacement — old names are deleted, not deprecated.

## Why

- **Vocabulary fragmentation.** "Load records matching an indexed FK" is `getOrLoadCollection` / `getByIndex` / `useIndexedCollection` / `useEntitiesByIndex` depending on layer. "All of a type" is `getOrLoadAll` / `getAll` / `peekAll` / `useModels` / `useEntities`. "collection" names four unrelated things. A user re-learns the API on every layer.
- **Unpredictable commit boundary.** `store.issue.create(...)` and `store.issue.update(...)` enqueue a transaction immediately; `issue.title = x` stages; `issue.save()` commits; `BaseModel.update(data)` does assign-or-hydrate **+ save**. No naming signal distinguishes "staged" from "sent." This is the single most confusing thing in a sync engine.
- **Alias bloat.** `optimisticUpdate` is an exact alias of `assign` ([`BaseModel.ts:501`](../packages/sync-engine/src/core/BaseModel.ts#L501)). `update` means three different things across layers.
- **Surface leak.** The core barrel exports `TransactionQueue`, `*Transaction`, `SyncConnection`, `ObjectPool`, `RefCollection`, … — every internal refactor becomes a breaking change.
- **Doc drift.** README's `bootstrapFetcher` signature is wrong (`(type, sinceSyncId)` vs the real `(type, options)`), and its schema example calls a redundant `.save()` after `create()`.

## Decisions (committed)

1. **One read vocabulary.** The schema store's `get*` / `peek*` verbs are canonical. StoreManager's `getOrLoad*` is fine as an *internal* name and is hidden, not renamed. Hooks adopt the canonical vocabulary.
2. **Commit model: Named boundary (Option A).** `create` / `patch` / `delete` / `archive` commit at the current transaction boundary. `draft()` + `save()` is the only staged path. `update` (the triple-meaning verb) is removed. See Workstream 2.
3. **Public read noun is `Record`.** Neutral term already used by `RecordWithExtensions` / `RecordCommitInterface`; serves decorator and schema users with one hook family without picking Model-vs-Entity.
4. **`seed` stays.** It is the deliberately-fenced fixture path; renaming to `put` would flatten it into the real-write family. (Prior decision, unchanged.)
5. **Clean cut.** Pre-publish: old names are deleted in the same change that adds the new ones. No `@deprecated`, no console warnings, no codemod, no flat-config adapter. The only consumers are in-repo (`webapp/`, tests) and migrate in lockstep.

---

## Workstream 1 — One read vocabulary, one hook family

### 1a. Hooks: 10 → 4, keyed by a typed handle

| Remove | Replace with |
|---|---|
| `useModel`, `useEntity` | `useRecord(handle, id)` |
| `useModels`, `useEntities` | `useRecords(handle, ids?)` |
| `useIndexedCollection`, `useIndexedCollections`, `useEntitiesByIndex`, `useEntitiesByIndexValues` | `useRecordsByIndex(handle, key, value \| values[])` (overload) |
| `useCollection`, `useBackRef` | `useRelation(record.relationProp)` |

`handle` is a schema namespace (`store.issue`) **or** a decorator model token (see 1c). The string-keyed `("Issue", id)` form is removed — it is an unchecked `as T` cast today ([`react/index.tsx:268`](../packages/sync-engine/src/react/index.tsx#L268)) and fails silently on typos.

### 1b. Demote the engine surface

`StoreManager` and `getOrLoad*` move behind `sync-engine/internal` (Workstream 4). The public read surface becomes exactly: `store.<entity>.{get,getByIds,getByIndex,getByIndexValues,getAll,peek,peekAll,peekByIndex}` + the 4 hooks. No layer below that is part of the learned vocabulary.

### 1c. Decorator handle + the `ctor.name` footgun

`useRecord(Issue, id)` needs a typed token. `@ClientModel` keys the registry on `ctor.name` ([`decorators.ts:142`](../packages/sync-engine/src/core/decorators.ts#L142)), which minifiers mangle in production. Make the name **explicit and required**: `@ClientModel({ name: "Issue" })`. Warn loudly (dev) when falling back to `ctor.name`; document the `keep_classnames` requirement for anyone who skips migration. The class object itself becomes the typed handle: `useRecord(Issue, id)` resolves through the registered name, not `ctor.name`.

---

## Workstream 2 — Commit semantics: the named boundary (Option A)

### The rule

Two effects can follow a data change: it becomes locally visible (always, optimistic) and it becomes a **committed transaction** (queued → sent → undoable → reconciled by SSE). A **staged** change is locally visible but not yet a transaction; it can be `save()`d or `discardUnsavedChanges()`d.

> **Final-sounding verbs commit at the current boundary. `draft` is the only staged path. Nothing both stages and commits.**

| Intent | API | Commits when |
|---|---|---|
| Create, one-shot | `store.issue.create(input)` | at current boundary |
| Patch existing, one-shot | `store.issue.patch(id, fields)` | at current boundary |
| Delete / archive | `store.issue.delete(id)` / `.archive(id)` | at current boundary |
| Staged new (form / multi-step) | `const d = store.issue.draft(input)` → mutate `d` → `d.save()` | on `d.save()` |
| Staged edit | `const d = store.issue.draft(id)` → mutate `d` → `d.save()` | on `d.save()` |

`update` is **deleted from every layer** (`EntityNamespace.update`, `BaseModel.update`).

### "Commit at the current boundary"

`create`/`patch`/`delete`/`archive` do **not** unconditionally fire a standalone send. They commit against whatever transaction boundary is open:

```ts
store.issue.create({ title: "A" })            // no batch → standalone txn, sent now

store.batch(() => {
  const epic = store.issue.create({ title: "Epic" })
  store.issue.create({ title: "Child", parentId: epic.id })
  store.comment.create({ issueId: epic.id, body: "kickoff" })
})                                            // one POST, one undo entry
```

This single definition is why A composes where "always send now" (Option B) would need `create` to special-case batch suppression. `batch()` / `atomic()` open a boundary; absent one, each call is its own boundary.

### `draft` semantics

- `store.issue.draft(input)` → new, uncommitted record. `id` is minted up front (so relations can reference it) but no transaction exists until `save()`.
- `store.issue.draft(id)` → loads/peeks the live record and returns it in staging mode.
- The draft exposes exactly `RecordCommitInterface`: field setters, `assign(fields)`, `save()`, `discardUnsavedChanges()`, `hasUnsavedChanges`, `watch()`. Abandoning a `draft(input)` (no `save()`) leaves nothing behind; `discardUnsavedChanges()` on a `draft(id)` reverts to last-saved.
- After `create`/`patch` returns, the record is a normal live record. Mutating it further is a fresh staged edit committed via its own `save()` — no special lifecycle.

### What changes in code

- `EntityNamespace.create` ([`createStore.ts:489`](../packages/sync-engine/src/schema/createStore.ts#L489)) keeps committing, but via an explicit `commitCreate` at the active boundary rather than the implicit `instance.update(input)` → `hydrate` → `save` path ([`BaseModel.ts:486`](../packages/sync-engine/src/core/BaseModel.ts#L486)).
- `EntityNamespace.update` → renamed `patch`; commits immediately (was: relied on `BaseModel.update`).
- New `EntityNamespace.draft(idOrInput)`.
- `BaseModel.update` removed from the public surface; staging primitives (`assign`/`save`/`discardUnsavedChanges`) are what `draft` exposes.

---

## Workstream 3 — Collapse the mutation verbs

- **Delete `optimisticUpdate`** — exact alias of `assign`.
- **Delete `BaseModel.update`** from the public surface — the source of the triple meaning.
- Final public mutation vocabulary: `assign` (stage many), `save` (commit), `discardUnsavedChanges` (rollback) on a draft; `create` / `patch` / `delete` / `archive` / `draft` on the namespace. Each has exactly one meaning.

---

## Workstream 4 — Curate the export surface

- **`sync-engine`** (adopter surface — the surface we commit to keeping stable once published): `StoreManager` *constructor*, `BaseModel`, decorators, `MemoryAdapter`, `LoadStrategy`, `BootstrapPhase`, `RestrictDeleteError`, `StoreManagerConfig` + `EngineErrorContext` + related types, `dateSerializer`/`dateDeserializer`.
- **`sync-engine/internal`** (no stability promise): `ObjectPool`, `Database`, `TransactionQueue`, `BaseTransaction`/`UpdateTransaction`/`CreateTransaction`/`DeleteTransaction`/`ArchiveTransaction`, `SyncConnection`, `ModelStream`, `RefCollection`, `BackRef`, `OwnedRefs`, `Store`/`FullStore`/`PartialStore`/`ModelStore`.
- Tag internal-only types `@internal`; build `.d.ts` with `--stripInternal` so they leave autocomplete.

---

## Workstream 5 — Smaller fixes (bundled)

- **Config grouping.** `StoreManagerConfig` → `{ workspaceId, transport, loading, persistence, hooks, advanced }`. `loading.onDemand` becomes a discriminated union (`{ mode: "perKey", fetch, batchFetch? } | { mode: "indexBatch", fetch, compound?: { threshold? } }`) so `serverSupportsCompoundIndexKeys`-without-a-batch-fetcher is unrepresentable. Flat shape is replaced outright (no adapter — in-repo callers migrate with it).
- **Uniform hook result.** One `AsyncResource<T>` for all four hooks: `{ data, isLoading, isLoaded, error, reload: () => Promise<void> }`. Today `useModel` omits `isLoaded` and `useCollection` downgrades `reload` to sync ([`react/index.tsx:497`](../packages/sync-engine/src/react/index.tsx#L497)).
- **`useBatch` returns the batch id** (`Promise<string> | string`) — silently dropped today ([`react/index.tsx:411`](../packages/sync-engine/src/react/index.tsx#L411)).
- **`peek` returns `undefined`** for not-hydrated (matching `objectPool.getById`); add sync `store.x.has(id)` for pool membership. Removes the null-means-two-things hazard.
- **One subscription verb: `watch`.** `RelationCollection.subscribe` → `watch`; namespace keeps `watchAll`/`watchByIndex`; `pool.subscribe` is internal.
- **`LoadStrategy` 6 → 5.** Drop `ExplicitlyRequested` (= `Lazy`). Rename `Instant`→`Eager`, `Local`→`LocalOnly`. Final: `Eager`, `Lazy`, `Partial`, `LocalOnly`, `Ephemeral`, each with one-line "choose when…". Coordinate with the schema-first RFC and demo/README, which currently say `LoadStrategy.Instant`.
- **Docs.** Fix README `bootstrapFetcher` to `(type, options)`; remove the redundant post-`create` `.save()`; update agent-docs per the CLAUDE.md surface table in the same commits.

---

## Rollout (clean cut)

No published consumers, so there is no migration window. Each workstream is a single change that deletes the old surface and adds the new one, with in-repo callers (`webapp/`, `__tests__/`) updated in the same commit. Verification is the existing test suite + a typecheck of `webapp/` against the new surface — a green build *is* the migration proof. `--stripInternal` d.ts and required `@ClientModel({ name })` land immediately, not behind a major. Every commit crossing a surface updates the matching doc per CLAUDE.md and runs `/simplify` before commit.

## V1 scope / non-goals

- **In:** Workstreams 1–5 as direct replacements, in-repo caller updates.
- **Out:** the typed-proxy facade from the schema-first RFC (records stay `BaseModel`-backed); any change to reconciliation, SSE, or transaction wire format. This RFC is surface-only.

## Implementation order

1. Workstream 2 (commit model) — everything else assumes its verbs.
2. Workstream 3 (verb collapse) — falls out of 2.
3. Workstream 1 (hooks + handle) — depends on the settled verbs.
4. Workstream 5 (smaller fixes).
5. Workstream 4 (export split) — last; mechanical.
6. In-repo caller updates (`webapp/`, `__tests__/`) + doc updates land in the same commit as each workstream.

## Docs to update when this lands

Per the CLAUDE.md surface table: `agent-docs/01-models-and-decorators.md` (`@ClientModel({ name })`), `agent-docs/08-react-integration.md` + README React section (hook rename), `agent-docs/09-headless-and-agents.md` (StoreManager demotion), `agent-docs/06-transactions-and-undo.md` (commit model), `README.md` (config grouping, `bootstrapFetcher` fix, `LoadStrategy` rename), `agent-docs/RFC-schema-first-authoring.md` (coordinate `LoadStrategy` + `update`→`patch`/`draft`).

## Resolved questions

1. **`draft(id)` on a not-pooled record: fetch-then-stage.** `draft(id)` is `async` and resolves whatever `get(id)` would (pool → IDB → on-demand), then returns it in staging mode. Parity with `get`; no "call `get` first" ceremony. `draft(input)` (new record) stays synchronous. Throws only if the id genuinely doesn't exist after a resolve.
2. ~~Keep `useEntity`/`useEntities` aliases?~~ Clean-cut: hard-cut to `useRecord`, no alias.
3. **Immediate-update verb is `patch`.** Chosen over `set`/`merge` for HTTP-PATCH familiarity and partial-update connotation. Reads cleanly next to `draft`.
