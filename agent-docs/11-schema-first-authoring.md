# Schema-First Authoring

An alternative to the decorator path in [`01-models-and-decorators.md`](01-models-and-decorators.md). The schema is plain data; the typed SDK falls out of it.

```typescript
import {
  defineSchema, entity, link, fields as s, LoadStrategy,
} from "zerodrift/schema";
import { createStore } from "zerodrift/schema";

export const schema = defineSchema({
  entities: {
    team: entity({
      loadStrategy: LoadStrategy.Eager,
      fields: {
        id:   s.id(),
        name: s.string(),
      },
    }),
    issue: entity({
      loadStrategy: LoadStrategy.Eager,
      fields: {
        id:        s.id(),
        title:     s.string().default(""),
        priority:  s.number().default(0),
        teamId:    s.refId("team").nullable().indexed(),
      },
    }),
  },
  links: {
    issueTeam: link({
      from: { entity: "issue", field: "teamId", as: "team" },
      to:   { entity: "team",  many: "issues", lazy: true },
      onDelete: "cascade",
    }),
  },
});

const store = createStore({ schema, storeManager });

const issue = await store.issue.get("issue-1");
issue?.team;            // typed Team | null, resolved through the pool
issue!.title = "Fix";
issue!.save();
```

Both authoring paths compile to the same `ModelRegistry` shape — schema-first models are runtime-indistinguishable from decorator-defined ones. You can mix them in the same app.

## Why a second authoring path

Decorators are great when humans write models by hand, but they foreclose:

- **Codegen ingress** — going from OpenAPI / Zod / JSON to runnable models means generating class source.
- **Introspection and devtools** — decorator metadata is opaque at runtime; schema-as-data isn't.
- **Duplicated relationship metadata** — decorators require declaring an FK on both sides (`@Property` + `@Reference` + `@ReferenceCollection` + matching `inverseOf`). `link(...)` declares it once.

If your app authors models manually and doesn't need the above, decorators are simpler. If you want any of those, schema-first earns its keep.

## Schema authoring

### `defineSchema(...)`

Returns a plain `SchemaDef`. Pure data; no side effects until you pass it to `createStore` or `compileSchema`.

### `entity(...)`

```typescript
entity({
  loadStrategy: LoadStrategy.Eager,
  eviction: { maxResident: 500 },    // optional — per-model eviction policy
  usedForPartialIndexes: true,    // optional
  name: "Issue",                   // optional — defaults to PascalCase of the schema key
  version: 2,                      // optional — overrides the auto-computed schemaVersion hash
  external: true,                  // optional — coexistence with decorator-defined classes
  idStrategy: (meta, ctx) => `issue_${nanoid()}`,  // optional — per-entity id minting
  fields: { ... },
});
```

`name` defaults to the PascalCase of the entity's key (`issue` → `Issue`). Override only when you need a registry name that doesn't match the key.

`version` is normally auto-computed by hashing the entity's compiled metadata — if the field set changes, the hash changes, and IDB runs a migration. Set it manually only to force migration without a metadata change.

`idStrategy` mints ids for records of this entity created client-side (`create`, `draft`, `new Model()`); server/IDB-hydrated records keep their existing ids. It has the same `IdentifierFn` signature as the global `advanced.identifierFn` — `(meta, ctx) => string`, with `ctx` the live `StoreManager` context (`setContext` / `<SyncProvider context>`) — and wins over it. Use it to localize per-entity id schemes (Stripe-style prefixes, layer-scoped ids) instead of branching on `meta.name` in one global function; a strategy function can move between the two scopes unchanged. `@ClientModel({ idStrategy })` is the decorator-path equivalent.

### Field builders

```typescript
s.id()                                 // primary key (required, string)
s.string()
s.number()
s.boolean()
s.date()                               // ISO-string serializer wired in
s.json<MyType>()                       // opaque JSON blob, typed
s.refId("team")                        // string foreign key with FK semantics
```

Modifiers chain off any field:

```typescript
s.string().nullable()                  // value can be null
s.string().indexed()                   // IDB secondary index
s.string().default("")                 // default for create() input + legacy hydrate
s.string().ephemeral()                 // observable in-memory only, never persisted
s.string().serialize(fn).deserialize(fn)  // custom JSON conversion (s.date() sets these by default)
```

### `link(...)`

A single declaration produces both sides of a relation.

```typescript
link({
  from: { entity: "issue", field: "teamId", as: "team" },
  to:   { entity: "team",  many: "issues", lazy: true },
  onDelete: "cascade",
})
```

- `from.field` must reference an existing `s.refId(...)` field on `from.entity`.
- `to.entity` must equal the target of that `refId(...)`.
- `from.as` becomes a singular relation property (`issue.team`).
- `to.many` becomes a reverse-collection property (`team.issues.items`).
- `onDelete: "cascade" | "nullify" | "restrict"` — passes through to the existing delete-cascade machinery.

Multiple links between the same pair are supported (`as` / `many` disambiguate). Self-referential links work too:

```typescript
issueParent: link({
  from: { entity: "issue", field: "parentId", as: "parent" },
  to:   { entity: "issue", many: "subtasks", lazy: true },
  onDelete: "nullify",
}),
```

The compiler enforces these invariants and rejects the schema otherwise:
- `from.field` exists on `from.entity` and is a `refId(...)`.
- `s.refId("X")` target equals `link.to.entity`.
- Each `s.refId(...)` field is referenced by at most one link.
- `from.as` and `to.many` don't collide with declared field names.
- Two entities don't compile to the same registry name.
- Schema entity keys don't collide with reserved `store.*` top-level methods (`batch`, `atomic`, `optimistic`, `undo`, `redo`, `undoDepth`, `redoDepth`, `runUndoable`).

## The typed `store` surface

`createStore({ schema, storeManager, extensions? })` returns a typed namespace per entity, plus top-level transaction primitives.

### Reads

The default flavor is async (`get*`). The `peek*` family is the sync escape hatch for code that genuinely cannot await (render-time reads, synchronous assertions).

| | id | by-index | by-index-values | all |
|---|---|---|---|---|
| **Sync, pool snapshot** | `peek` | `peekByIndex` | — | `peekAll` |
| **Async, pool-or-fetch** | `get` | `getByIndex` | `getByIndexValues` | `getAll` |
| **Async, force network** | `refresh` | `refreshByIndex` | — | `refreshAll` |

`getByIndexValues(key, values[])` is the multi-value form — fans out one `getByIndex` call per value in parallel, dedupes, returns the union in input-`values` order. Useful for "issues for any of these teams" patterns. With `serverSupportsCompoundIndexKeys: true` + `onDemandIndexBatchFetcher` configured, the fan-out can collapse into one server round-trip when the values share a parent FK.

```typescript
const issue = await store.issue.get(id);                  // pool-first; falls back to IDB / fetcher
const team = store.team.peek(teamId);                     // sync; undefined = "not in pool"
const isHere = store.team.has(teamId);                    // sync boolean membership check
const teamIssues = await store.issue.getByIndex("teamId", teamId);
//                                          ^^^^^^^^ key is constrained to .indexed() fields
const allTeams = await store.team.getAll();
await store.issue.refreshByIndex("teamId", teamId);       // evict + reload, server-truth
```

`peek(id)` returns `undefined` when the record isn't hydrated — `undefined` means "not in this microtask's pool," **not** "doesn't exist" (it mirrors `objectPool.getById`; only a `get*` fetch can confirm true absence). Use `get*` to fetch, or `has(id)` for a boolean presence check. `peekAll` / `peekByIndex` return arrays (empty when nothing matches).

### Mutations

Commit model: `create` / `patch` / `delete` / `archive` commit at the current
transaction boundary (standalone, or folded into an open `store.batch` /
`store.atomic`). `draft(...)` is the only staged path — mutate the returned
record, then `save()` to commit or `discardUnsavedChanges()` to roll back.
**Nothing both stages and commits.**

```typescript
store.issue.create({ id?, title, teamId })             // commit now → typed record
store.issue.patch(id, { title?, priority? })           // partial; commit now → record
store.issue.delete(id)                                 // cascade / restrict via onDelete
store.issue.archive(id)                                // soft-delete, same semantics
store.issue.draft(input?)                              // staged NEW record (sync); id minted
store.issue.draft(id)                                  // staged existing record (async)
store.issue.seed([{ id: "i1", ... }])                  // hydrate-into-pool, no transaction
                                                       //   (for tests / stories)
```

`patch` requires the record to be in the pool (throws otherwise). To edit a
lazy-loaded record, use `await store.issue.draft(id)` — it resolves the record
the same way `get` does (pool → IDB → on-demand) and hands it back staged.
`draft(input)` returns an uncommitted new record (id minted up front so
relations can point at it); abandoning it without `save()` leaves nothing
behind.

### Per-record commit interface

The records returned from `create` / `peek` / `get` carry a curated subset of `BaseModel`:

```typescript
const issue = store.issue.peek(id)!;
issue.title = "x";
issue.priority = 2;
issue.hasUnsavedChanges;        // true
issue.save();                   // single transaction with both fields
issue.discardUnsavedChanges();  // revert to last-saved values
```

This is how you batch imperative writes inside an event handler without going through `store.issue.patch(id, ...)` per field (use `await store.issue.draft(id)` to get a staged record by id).

### Subscriptions

Four `watch*` primitives, one verb, all payload-less — the callback fires, you re-read. Returns an unsubscribe function.

```typescript
store.issue.watchAll(() => { /* any pool change for Issue */ });
store.issue.watchByIndex("teamId", teamId, () => { /* matching record added/removed */ });
issue.watch(r => r.title, (next, prev) => { /* this record's title changed */ });
record.issues.watch(() => { /* relation collection's items changed */ });
```

`watchByIndex` runs its predicate at the pool's write-time, so listeners only fire on matching mutations. **Caveat:** this catches set-membership changes (insert / remove / re-put), not field reassignments — a record moving between FK buckets via `record.teamId = "..."` goes through MobX boxes, not pool notify. Pair with `record.watch` if you need that case too.

Inside React, prefer the hooks ([typed React hooks](#typed-react-hooks) below). They wire the same primitives through `useSyncExternalStore`.

### Top-level `store` methods

```typescript
store.batch(fn): string                    // sync — fn() runs in one batchId
store.batch(async fn): Promise<string>     // async — finally-fires endBatch even on throw

// Stage edits with all-or-nothing local commit semantics — keep fn synchronous.
// On resolve, every touched model's save() runs in one batch (one undo entry).
// On throw, every touched model's discardUnsavedChanges() runs and the error rethrows.
store.atomic(() => {
  book.assign({ title: "X" });
  issue.assign({ status: "done" });
});

// Pair an optimistic mutation with its persisting network call. mutate stages
// synchronously (visible immediately); persist runs with no scope held, so
// overlapping operations never collide. On resolve, only the fields mutate
// touched commit (one undo entry); on reject, they revert (field-level
// last-writer-wins on overlap). Don't await I/O inside atomic() — use this.
// mutate MUST be sync: resolve lazy records with `await store.issue.draft(id)`
// FIRST, then mutate the pooled reference. See 06-transactions-and-undo.md
// (#editing-lazy-loaded-records-inside-mutate-no-await-allowed).
const issue = await store.issue.draft(id);   // pool → IDB → on-demand, once
await store.optimistic(
  () => issue.assign({ status: "done" }),
  () => api.call(),
);

await store.undo();                        // returns UndoResult | null
await store.redo();
store.undoDepth;                           // live getter
store.redoDepth;

await store.runUndoable(
  async () => { const { changeLogId } = await api.publish(); return { changeLogId }; },
  { actionType: "publish" },
);
```

Choosing between `batch` / `atomic` / `optimistic`: `batch` groups explicit commits (no rollback), `atomic` commits-or-discards staged edits as one unit, `optimistic` ties staged fields to a persist call — see [06-transactions-and-undo.md](06-transactions-and-undo.md#choosing-between-batch-atomic-and-optimistic).

Inside React, prefer `useUndoRedo()` and `useBatch()` — they subscribe to the queue so `canUndo`/`canRedo` are reactive. The `store.*` methods are the imperative path for headless code.

## Behavior extensions: `extend(...)`

Computed and actions live outside the schema (which stays serializable):

```typescript
import { extend } from "zerodrift/schema";

const issueBehavior = extend(schema, "issue", {
  computed: {
    identifier: (issue) =>
      `${(issue.teamId ?? "").slice(0, 4)}-${issue.priority}`,
  },
  actions: {
    moveToTeam(issue, newTeamId: string) {
      issue.teamId = newTeamId;
    },
  },
});

const store = createStore({ schema, storeManager, extensions: [issueBehavior] });

store.issue.peek(id)?.identifier;          // typed string
store.issue.peek(id)?.moveToTeam("team-2");
```

Whole-schema form is also accepted:

```typescript
extend(schema, {
  issue: { computed: { ... }, actions: { ... } },
  team:  { computed: { ... } },
});
```

**Reactivity contract**:
- `computed` callbacks receive the reactive proxy. Property reads track dependencies; the runtime wraps them in MobX `computed()` for memoization.
- `actions` are auto-wrapped in MobX `action()` for write batching.

**Self-reference limitation**: a `computed` can read fields and singular relations, but **not** other computeds/actions on the same entity within the same `extend(...)` call. Modeling that requires the param type to include sibling extensions, which is a TS self-reference problem (the type of `defs.computed.identifier` depends on `defs.computed`). Workarounds: inline the value, or split across two `extend` calls.

## Coexisting with decorator-defined models

Mark a schema entity `external: true` to reference a decorator-registered class without redeclaring it:

```typescript
@ClientModel({ name: "User", loadStrategy: LoadStrategy.Eager })
class User extends BaseModel {
  @Property() declare email: string;
  @Property() declare name: string;
}

const schema = defineSchema({
  entities: {
    user: entity({
      external: true,
      name: "User",                 // required when external — registry-name match
      loadStrategy: LoadStrategy.Eager,
      fields: { id: s.id() },        // declarative only — schema doesn't own the class
    }),
    comment: entity({
      loadStrategy: LoadStrategy.Eager,
      fields: {
        id: s.id(),
        body: s.string(),
        authorId: s.refId("user").indexed(),
      },
    }),
  },
  links: {
    commentAuthor: link({
      from: { entity: "comment", field: "authorId", as: "author" },
      to:   { entity: "user",    many: "comments", lazy: true },
      onDelete: "cascade",
    }),
  },
});
```

The compiler skips synthetic-class generation, property registration, and the reverse-collection install for external entities — the decorator-defined class stays the canonical source. Schema-owned entities can still link to it; cross-references resolve against the registry name.

## Zod adapter

Zod is an optional peer dependency. When installed:

```typescript
import { z } from "zod";
import { fromZod, entityFromZod } from "zerodrift/schema";

const ZodIssue = z.object({
  id: z.string(),
  title: z.string().default(""),
  priority: z.number().default(0),
});

const schema = defineSchema({
  entities: {
    issue: entityFromZod(ZodIssue, {
      loadStrategy: LoadStrategy.Eager,
      name: "Issue",
    }),
  },
  links: { /* link() still owns the graph; Zod authors record shape only */ },
});
```

`fromZod(zSchema)` returns a `FieldBuilder` for a single Zod schema; `entityFromZod(zObject, opts)` walks `zObject.shape` and produces an `EntityDef`. The adapter handles primitives (`string` / `number` / `boolean` / `date`) plus the `nullable` / `optional` / `default` modifiers; structured Zod types (objects, arrays, enums, unions) collapse to `s.json<T>()` so the runtime stores the raw value while TS types still flow from `z.infer`.

`z.lazy(...)` wrappers — what codegen emits for recursive or forward-referenced schemas — are resolved eagerly, both at entity level (`entityFromZod(z.lazy(() => Shape), …)`) and per field, at runtime and in the inferred types. Field overrides, `autoIndex`, and `IndexedFieldKeys` all see the resolved object, so a lazy-wrapped schema behaves identically to a bare `z.object(...)`.

Zod doesn't carry FK or index metadata, so use `opts.fields` to layer that on per-field — either as a chaining function (modifies the auto-derived builder) or a full replacement (typically for FKs):

```typescript
entityFromZod(ZodIssue, {
  loadStrategy: LoadStrategy.Eager,
  name: "Issue",
  fields: {
    teamId:    s.refId("team").nullable().indexed(),  // full replacement
    email:     (b) => b.indexed(),                     // chain on auto-derived
    draftNote: (b) => b.ephemeral(),
  },
});
```

Override keys are constrained to fields actually declared on the Zod object, so typos surface at compile time — and unknown keys also throw at runtime (for JS callers and casts), since a silently-dropped override means a field you believe is indexed isn't.

Two conveniences cut repetition when the Zod source is generated (OpenAPI, gRPC, …):

```typescript
entityFromZod(ZodIssue, {
  loadStrategy: LoadStrategy.Eager,
  autoIndex: "ID",                    // `*ID` fields get `.indexed()` automatically
  omit: ["createdAt", "updatedAt"],   // drop transport-only fields the DTO carries
});
```

`autoIndex` is a suffix match (string, not regex) so the matched keys propagate to the entity's TS type — `IndexedFieldKeys`, `getByIndex`, and `useRecordsByIndex` see them the same as an explicit `.indexed()`. An explicit `fields.<key>` builder override suppresses the auto-index for that key; a chained function override (`(b) => …`) runs after the auto-index so its `.indexed()` is idempotent.

For a whole generated module, `entitiesFromZod` calls `entityFromZod` per key with shared opts:

```typescript
import { entitiesFromZod } from "zerodrift/schema";
import * as ZodModule from "./generated/zod-schemas";   // { team: ZodTeam, issue: ZodIssue, … }

const schema = defineSchema({
  entities: entitiesFromZod(ZodModule, {
    loadStrategy: LoadStrategy.Eager,
    autoIndex: "ID",
    omit: ["createdAt", "updatedAt"],
  }),
  links: { /* link() still owns the graph */ },
});
```

The registry name for each entity is the PascalCased input key (auto-derived by `compileSchema`), so no per-entity `name` is needed. Drop down to `entityFromZod` for the handful that need their own `fields` map or a distinct `loadStrategy`.

## Naming record / input types

Three helpers, all parameterized by the schema and an entity key, give first-class names for the shapes the store works in. Prefer them over re-deriving from `ReturnType<…peek>` at call sites:

```typescript
import type {
  InferRecord,        // alias of InferEntity
  InferCreateInput,
  InferUpdateInput,
} from "zerodrift/schema";

type Issue       = InferRecord<typeof schema, "issue">;       // store.issue.peek(...) / .get(...) return shape
type IssueCreate = InferCreateInput<typeof schema, "issue">;  // store.issue.create(input) argument
type IssueUpdate = InferUpdateInput<typeof schema, "issue">;  // store.issue.patch(id, fields) argument
```

`InferCreateInput` already drops PK / defaulted / `.optional()` fields to optional, so an entity built with `entityFromZod(z.object({ id, title: z.string().default(""), … }))` accepts `{ teamId }` without `id` or `title`.

## Typed React hooks

In `zerodrift/react`:

Wrap the app in `<SyncProvider schema={schema} config={…}>` once — that runs `createStore` synchronously between StoreManager construction and `bootstrap()`, registering schema entities before the first fetch (see [08-react-integration.md § `schema` prop](08-react-integration.md#schema-prop--schema-first-wiring)). Inside children, pull the typed store with `useStore<typeof schema>()` and pass `store.<entity>` namespaces as the **handle** to the read hooks (a decorator class is the other handle form):

```typescript
import {
  useRecord,
  useRecords,
  useRecordsByIndex,
  useStore,
} from "zerodrift/react";

const store = useStore<typeof schema>();
const { data: issue } = useRecord(store.issue, issueId);
const { data: teams } = useRecords(store.team);
const { data: teamIssues } = useRecordsByIndex(store.issue, "teamId", teamId);
//                                                          ^^^^^^^^ autocompletes to indexed fields only

// Single value OR a values array — issues for any of these teams.
const { data: myIssues } = useRecordsByIndex(store.issue, "teamId", myTeamIds);
```

Uniform `AsyncResource` shape (`{ data, isLoading, isLoaded, error, reload }`); a namespace handle infers the record type and constrains the index key to the schema's `.indexed()` fields. See [08-react-integration.md](08-react-integration.md) for the full hook surface.

## What to expect at runtime

A schema entity becomes a synthetic `BaseModel` subclass at compile time. The typed records returned from `store.<entity>.*` are real `BaseModel` instances; `RecordWithExtensions<S, K, Exts>` is a type-level projection of the same instance. That means:

- **Field reads** (e.g. `issue.title`) are MobX-tracked. Inside `observer()` they trigger re-renders.
- **Relation collections** (e.g. `team.issues.items`) wire their own MobX boxes — reactive.
- **Computed extensions** are MobX-memoized via `computed()`.
- **The pool itself** (`peekAll` / `peek` snapshots) is **not** MobX-tracked — that's the `pool.subscribe` channel. Use `watchAll` / typed React hooks for pool-level reactivity. See [`02-object-pool.md`](02-object-pool.md) for the full reactivity boundary.

## When to choose which authoring path

- **Decorators** when you author models manually and want the simplest possible mental model.
- **Schema-first** when you want any of:
  - Codegen from Zod / OpenAPI / database schemas.
  - Schema introspection for devtools.
  - Single-declaration relationships (`link(...)`) instead of dual `@Reference` + `@ReferenceCollection`.
  - Typed `store.<entity>.*` API surface end-to-end.

Both paths compile to the same `ModelRegistry`, so you can mix them in one app — a decorator-defined `User` and a schema-defined `Comment` link cleanly via `entity({ external: true })`.
