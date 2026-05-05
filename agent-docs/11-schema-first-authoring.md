# Schema-First Authoring

An alternative to the decorator path in [`01-models-and-decorators.md`](01-models-and-decorators.md). The schema is plain data; the typed SDK falls out of it.

```typescript
import {
  defineSchema, entity, link, fields as s, LoadStrategy,
} from "sync-engine/schema";
import { createDb } from "sync-engine/schema";

export const schema = defineSchema({
  entities: {
    team: entity({
      loadStrategy: LoadStrategy.Instant,
      fields: {
        id:   s.id(),
        name: s.string(),
      },
    }),
    issue: entity({
      loadStrategy: LoadStrategy.Instant,
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

const db = createDb({ schema, storeManager });

const issue = await db.issue.get("issue-1");
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

Returns a plain `SchemaDef`. Pure data; no side effects until you pass it to `createDb` or `compileSchema`.

### `entity(...)`

```typescript
entity({
  loadStrategy: LoadStrategy.Instant,
  usedForPartialIndexes: true,    // optional
  name: "Issue",                   // optional — defaults to PascalCase of the schema key
  version: 2,                      // optional — overrides the auto-computed schemaVersion hash
  external: true,                  // optional — coexistence with decorator-defined classes
  fields: { ... },
});
```

`name` defaults to the PascalCase of the entity's key (`issue` → `Issue`). Override only when you need a registry name that doesn't match the key.

`version` is normally auto-computed by hashing the entity's compiled metadata — if the field set changes, the hash changes, and IDB runs a migration. Set it manually only to force migration without a metadata change.

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
- Schema entity keys don't collide with reserved `db.*` top-level methods (`batch`, `undo`, `redo`, `undoDepth`, `redoDepth`, `runUndoable`).

## The typed `db` surface

`createDb({ schema, storeManager, extensions? })` returns a typed namespace per entity, plus top-level transaction primitives.

### Reads

The default flavor is async (`get*`). The `peek*` family is the sync escape hatch for code that genuinely cannot await (render-time reads, synchronous assertions).

| | id | by-index | all |
|---|---|---|---|
| **Sync, pool snapshot** | `peek` | `peekByIndex` | `peekAll` |
| **Async, pool-or-fetch** | `get` | `getByIndex` | `getAll` |
| **Async, force network** | `refresh` | `refreshByIndex` | `refreshAll` |

```typescript
const issue = await db.issue.get(id);                  // pool-first; falls back to IDB / fetcher
const team = db.team.peek(teamId);                     // sync; null means "not in pool"
const teamIssues = await db.issue.getByIndex("teamId", teamId);
//                                          ^^^^^^^^ key is constrained to .indexed() fields
const allTeams = await db.team.getAll();
await db.issue.refreshByIndex("teamId", teamId);       // evict + reload, server-truth
```

`peek*` reads return whatever's in the pool right now — `null` doesn't mean "doesn't exist," it means "not currently hydrated." Use `get*` if you want the engine to fetch.

### Mutations

```typescript
db.issue.create({ id?, title, teamId })                // returns the typed record
db.issue.update(id, { title?, priority? })             // partial; throws if id not in pool
db.issue.delete(id)                                    // cascade / restrict via onDelete
db.issue.archive(id)                                   // soft-delete, same semantics
db.issue.seed([{ id: "i1", ... }])                     // hydrate-into-pool, no transaction
                                                       //   (for tests / stories)
```

`update` requires the record to be in the pool. To update a lazy-loaded record, `await db.issue.get(id)` first.

### Per-record commit interface

The records returned from `create` / `peek` / `get` carry a curated subset of `BaseModel`:

```typescript
const issue = db.issue.peek(id)!;
issue.title = "x";
issue.priority = 2;
issue.hasUnsavedChanges;        // true
issue.save();                   // single transaction with both fields
issue.discardUnsavedChanges();  // revert to last-saved values
```

This is how you batch imperative writes inside an event handler without going through `db.issue.update(id, ...)` per field.

### Subscriptions

Three primitives, all payload-less — the callback fires, you re-read. Returns an unsubscribe function.

```typescript
db.issue.watchAll(() => { /* any pool change for Issue */ });
db.issue.watchByIndex("teamId", teamId, () => { /* matching record added/removed */ });
issue.watch(r => r.title, (next, prev) => { /* this record's title changed */ });
record.issues.subscribe(() => { /* relation collection's items changed */ });
```

`watchByIndex` runs its predicate at the pool's write-time, so listeners only fire on matching mutations. **Caveat:** this catches set-membership changes (insert / remove / re-put), not field reassignments — a record moving between FK buckets via `record.teamId = "..."` goes through MobX boxes, not pool notify. Pair with `record.watch` if you need that case too.

Inside React, prefer the hooks ([typed React hooks](#typed-react-hooks) below). They wire the same primitives through `useSyncExternalStore`.

### Top-level `db` methods

```typescript
db.batch(fn): string                       // sync — fn() runs in one batchId
db.batch(async fn): Promise<string>        // async — finally-fires endBatch even on throw

await db.undo();                           // returns UndoResult | null
await db.redo();
db.undoDepth;                              // live getter
db.redoDepth;

await db.runUndoable(
  async () => { const { changeLogId } = await api.publish(); return { changeLogId }; },
  { actionType: "publish" },
);
```

Inside React, prefer `useUndoRedo()` and `useBatch()` — they subscribe to the queue so `canUndo`/`canRedo` are reactive. The `db.*` methods are the imperative path for headless code.

## Behavior extensions: `extend(...)`

Computed and actions live outside the schema (which stays serializable):

```typescript
import { extend } from "sync-engine/schema";

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

const db = createDb({ schema, storeManager, extensions: [issueBehavior] });

db.issue.peek(id)?.identifier;          // typed string
db.issue.peek(id)?.moveToTeam("team-2");
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
@ClientModel({ loadStrategy: LoadStrategy.Instant })
class User extends BaseModel {
  @Property() declare email: string;
  @Property() declare name: string;
}

const schema = defineSchema({
  entities: {
    user: entity({
      external: true,
      name: "User",                 // required when external — registry-name match
      loadStrategy: LoadStrategy.Instant,
      fields: { id: s.id() },        // declarative only — schema doesn't own the class
    }),
    comment: entity({
      loadStrategy: LoadStrategy.Instant,
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
import { fromZod, entityFromZod } from "sync-engine/schema";

const ZodIssue = z.object({
  id: z.string(),
  title: z.string().default(""),
  priority: z.number().default(0),
});

const schema = defineSchema({
  entities: {
    issue: entityFromZod(ZodIssue, {
      loadStrategy: LoadStrategy.Instant,
      name: "Issue",
    }),
  },
  links: { /* link() still owns the graph; Zod authors record shape only */ },
});
```

`fromZod(zSchema)` returns a `FieldBuilder` for a single Zod schema; `entityFromZod(zObject, opts)` walks `zObject.shape` and produces an `EntityDef`. The adapter handles primitives (`string` / `number` / `boolean` / `date`) plus the `nullable` / `optional` / `default` modifiers; structured Zod types (objects, arrays, enums, unions) collapse to `s.json<T>()` so the runtime stores the raw value while TS types still flow from `z.infer`.

## Typed React hooks

In `sync-engine/react`:

```typescript
import {
  useDbModel,
  useDbModels,
  useDbIndexedCollection,
} from "sync-engine/react";

const { item: issue } = useDbModel(db.issue, issueId);
const { items: teams } = useDbModels(db.team);
const { items: teamIssues } = useDbIndexedCollection(db.issue, "teamId", teamId);
//                                                            ^^^^^^^^ autocompletes to indexed fields only
```

Same return shape as the existing `useModel` / `useModels` / `useIndexedCollection` (`{ item | items, isLoading, error, reload }`); the schema-typed hooks just infer the record type and indexed-key constraint from the namespace. Internally they extract the registry name and delegate to the same `useSyncExternalStore` machinery, so reactivity is identical.

## What to expect at runtime

A schema entity becomes a synthetic `BaseModel` subclass at compile time. The typed records returned from `db.<entity>.*` are real `BaseModel` instances; `RecordWithExtensions<S, K, Exts>` is a type-level projection of the same instance. That means:

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
  - Typed `db.<entity>.*` API surface end-to-end.

Both paths compile to the same `ModelRegistry`, so you can mix them in one app — a decorator-defined `User` and a schema-defined `Comment` link cleanly via `entity({ external: true })`.
