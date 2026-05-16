# RFC — Schema-First Authoring

**Status:** Draft. Not yet implemented. The current authoring path remains decorators on `BaseModel` subclasses (see [`01-models-and-decorators.md`](01-models-and-decorators.md)).

## Goal

Add a schema-first API alongside the existing decorator path. The schema is plain data; the typed SDK is derived from it; OpenAPI and Zod can ingest into it; runtime behavior is unchanged because the schema compiles into the same `ModelRegistry` shape decorators produce today.

This is additive. Decorator-defined models keep working unchanged.

## Why

Decorators force authoring through TypeScript classes. That's fine when humans write models by hand, but it forecloses a few useful things:

- **Codegen ingress.** Going from OpenAPI/Zod/JSON to runnable models means generating class source, which is awkward and brittle.
- **Introspection and devtools.** Decorators run at class-definition time; you can't easily diff schemas, render them in tools, or export them as JSON.
- **Duplicated relationship metadata.** Today a foreign key must be declared on both sides (`@Reference` + `@ReferenceCollection` + matching `inverseOf`). A single relation declaration with two sides is easier to reason about and harder to get wrong.
- **Less ceremony.** For most apps, `s.string()` + `s.refId("team")` is enough. Classes earn their keep when you need behavior; data declarations don't need to be classes.

The InstantDB experience (schema as data, typed SDK falls out) is the model.

## Decisions (committed)

These were left as open questions in earlier drafts. Pinning them here so the prototype has a fixed target.

1. **Canonical naming.** Schema entity key → PascalCase registry name (`issue` → `Issue`). `entity({ name: "..." })` overrides. The registry name is what `ModelMeta.name` becomes and what cross-references resolve against.
2. **Public record identity.** `store.<entity>.peek(id)` (sync) and `store.<entity>.get(id)` (async) return typed proxy facades. The implementation is backed by `BaseModel` instances internally for V1 — this avoids rewriting reactivity. The facade may diverge from `BaseModel` later.
3. **`extend(...)` is pure.** It returns an extension descriptor. It does not mutate the schema. Extensions are composed at `createStore({ schema, extensions: [...] })`. Schema-as-data only stays true if `extend` doesn't touch it.
4. **Compile timing.** `compileSchema` runs inside `createStore`, not at module load. Schema stays inert data until a runtime asks for it. Tests, codegen, and SSR depend on this.

## Authoring API

### Schema

```typescript
import {
  defineSchema,
  entity,
  link,
  fields as s,
  LoadStrategy,
} from "sync-engine/schema";

export const schema = defineSchema({
  entities: {
    team: entity({
      loadStrategy: LoadStrategy.Eager,
      fields: {
        id: s.id(),
        createdAt: s.date(),
        updatedAt: s.date(),
        name: s.string(),
        key: s.string(),
      },
    }),

    issue: entity({
      loadStrategy: LoadStrategy.Eager,
      usedForPartialIndexes: true,
      fields: {
        id: s.id(),
        createdAt: s.date(),
        updatedAt: s.date(),
        title: s.string(),
        description: s.string().default(""),
        priority: s.number().default(0),
        sortOrder: s.number().default(0),
        teamId: s.refId("team").nullable().indexed(),
        draftNote: s.string().ephemeral(),
      },
    }),

    liveMetric: entity({
      loadStrategy: LoadStrategy.Ephemeral,
      fields: {
        id: s.id(),
        value: s.number(),
        updatedAt: s.date(),
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
```

### Field builders

Core constructors:

- `s.id()` — primary key. Always required. String.
- `s.refId("entity")` — string foreign key. Carries FK semantics on the field itself; the `link()` block adds the reverse side and behavior.
- `s.string()`, `s.number()`, `s.boolean()`
- `s.date()` — bakes in ISO 8601 serialization. `Date` in memory, ISO string on the wire.
- `s.json<T>()` — opaque JSON blob, typed.

Modifiers (chainable):

- `.nullable()` — value can be `null`.
- `.indexed()` — IDB secondary index on this field. Same effect as `@Property({ indexed: true })`.
- `.default(value)` — default for `store.<entity>.create()` inputs and on hydration of legacy rows missing the field.
- `.ephemeral()` — observable, in-memory only, never persisted to IDB, never serialized to backend payloads. Same effect as `@EphemeralProperty`.
- `.serialize(fn)` / `.deserialize(fn)` — custom JSON conversion. `s.date()` sets these by default; user-supplied overrides win.

### Links

A single `link(...)` declaration produces both sides of a relation.

```typescript
issueTeam: link({
  from: { entity: "issue", field: "teamId", as: "team" },
  to:   { entity: "team",  many: "issues", lazy: true },
  onDelete: "cascade",
})
```

- `from.entity` / `from.field` — the entity and FK field that owns the reference. Must reference an existing `s.refId(...)` field.
- `from.as` — the singular relation property name on the `from` entity (`issue.team`).
- `to.entity` — the target. Must equal the `s.refId(...)` target on `from.field`.
- `to.many` — the reverse collection property name on the `to` entity (`team.issues`).
- `to.lazy` — collection load mode. Same semantic as today's lazy ref collections.
- `onDelete: "cascade" | "nullify" | "restrict"` — passes through to existing delete-cascade machinery unchanged.

**Multiple links between the same pair** are supported and disambiguate by `as` / `many`:

```typescript
issueAssignee: link({
  from: { entity: "issue", field: "assigneeId", as: "assignee" },
  to:   { entity: "user",  many: "assignedIssues", lazy: true },
}),
issueCreator: link({
  from: { entity: "issue", field: "creatorId", as: "creator" },
  to:   { entity: "user",  many: "createdIssues", lazy: true },
}),
```

**Self-referential links** are supported:

```typescript
issueParent: link({
  from: { entity: "issue", field: "parentId", as: "parent" },
  to:   { entity: "issue", many: "subtasks", lazy: true },
  onDelete: "nullify",
}),
```

### Extensions (computed + actions)

Behavior is declared separately from schema so the schema stays serializable.

```typescript
import { extend } from "sync-engine/schema";

export const issueBehavior = extend(schema, "issue", {
  computed: {
    identifier: (issue) =>
      `${(issue.teamId ?? "").slice(0, 4)}-${issue.sortOrder}`,
  },
  actions: {
    moveToTeam(issue, newTeamId: string) {
      issue.teamId = newTeamId;
    },
  },
});
```

Or whole-schema for small apps:

```typescript
export const behavior = extend(schema, {
  issue: { computed: { ... }, actions: { ... } },
  team:  { computed: { ... } },
});
```

Both forms return an extension descriptor. They are composed at `createStore` time:

```typescript
const store = createStore({ schema, extensions: [issueBehavior, teamBehavior], ... });
```

**Reactivity contract:**

- `computed` functions receive the reactive proxy. Property reads track dependencies the same way `@Computed` getters do today. The runtime wraps them in MobX `computed` for memoization.
- `actions` are auto-wrapped in MobX `action` for write batching, identical to `@Action` methods.

A `computed` that returns the same value across reactive reads with no dependency changes will be cached; calling an `action` produces a single transaction frame.

**How the `(issue) => ...` parameter gets typed.** `extend` is generic over the schema and the entity key, so the callback parameter type is computed from those generics:

```typescript
type EntityKey<S extends Schema> = keyof S["entities"] & string;

function extend<S extends Schema, K extends EntityKey<S>>(
  schema: S,
  key: K,
  defs: {
    computed?: Record<string, (record: InferEntity<S, K>) => unknown>;
    actions?: Record<
      string,
      (record: InferEntity<S, K>, ...args: any[]) => unknown
    >;
  },
): ExtensionDescriptor<S, K>;
```

When you write `extend(schema, "issue", { computed: { identifier: (issue) => ... } })`, TS:

1. Binds `S = typeof schema`, `K = "issue"` from the first two arguments.
2. Computes `InferEntity<typeof schema, "issue">` — walks `S["entities"]["issue"]["fields"]`, maps each field builder to its TS type, and adds singular relation properties from `S["links"]` where `from.entity === "issue"`.
3. Contextually types `(issue) => ...` so `issue` is exactly that record type.

The whole-schema form uses a mapped type so each entity gets its own `K` binding:

```typescript
function extend<S extends Schema>(
  schema: S,
  defs: {
    [K in EntityKey<S>]?: {
      computed?: Record<string, (record: InferEntity<S, K>) => unknown>;
      actions?: Record<
        string,
        (record: InferEntity<S, K>, ...args: any[]) => unknown
      >;
    };
  },
): ExtensionDescriptor<S>;
```

That mapped type rebinds `K` per entity key, so `(issue) =>` is typed correctly inside the `issue:` block and `(team) =>` is typed correctly inside the `team:` block.

**Self-reference limitation (V1).** The callback parameter is `InferEntity<S, K>` — the entity's fields plus its singular relations. It does **not** include sibling computeds and actions defined in the same `extend` call. Concretely:

```typescript
extend(schema, "issue", {
  computed: {
    identifier: (issue) => `${issue.teamId?.slice(0, 4)}-${issue.sortOrder}`,
    displayName: (issue) => issue.identifier,  // ← TS error in V1
  },
});
```

The reason, in plain terms: for `issue.identifier` to be typed inside `displayName`, the type of `issue` would need to already include `identifier`. But `identifier` is one of the entries in `defs.computed` — the very object whose type we are still in the middle of inferring. So TS would have to know the type of `defs.computed` before finishing inferring `defs.computed`. That's a self-reference, and TS doesn't resolve it without help.

It is solvable — typically with a `this`-style trick (declaring callbacks as methods on an object whose type is referenced via `this`) or a deferred fixed-point — but the ergonomics get worse and the error messages get harder to read. V1 takes the simpler rule: within a single `extend` call you only see fields and relations.

If you need a computed that reads another computed, you have two paths:

- Inline: just compute the value directly inside the second function. (`displayName: (issue) => \`${issue.teamId?.slice(0, 4)}-${issue.sortOrder}\``.)
- Across calls: split into two `extend` calls and rely on the merged record type that `createStore` materializes — at that point all extensions are visible to one another via the proxy returned from `store.<entity>.peek(...)`.

### Typed client

V1 is namespaced.

```typescript
const store = createStore({ schema, extensions, adapter, sync });

const issue = db.issue.peek("issue-1");
issue?.moveToTeam("team-design");

await db.issue.create({
  title: "Fix bug",
  sortOrder: 12,
  teamId: "team-eng",
});

await db.issue.patch("issue-1", { title: "Fix hydration bug" });
await db.issue.delete("issue-1");

const issues = await db.issue.query({
  where: { teamId: "team-eng" },
  limit: 50,
  include: { team: true },
});
```

The InstaQL-style multi-entity document (`db.query({ issue: { team: {} } })`) is **deferred**. It can desugar onto the namespaced surface later.

### Inferred types

```typescript
type Issue        = InferEntity<typeof schema, "issue">;
type IssueCreate  = InferCreateInput<typeof schema, "issue">;
type IssueUpdate  = InferUpdateInput<typeof schema, "issue">;
type IssueRecord  = InferRecord<typeof schema, typeof extensions, "issue">;
```

`Issue` carries field types plus the singular relation property:

```typescript
type Issue = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  title: string;
  description: string;
  priority: number;
  sortOrder: number;
  teamId: string | null;
  team: Team | null;
};
```

`IssueRecord` adds extension members and collection wrappers:

```typescript
type IssueRecord = Issue & {
  readonly identifier: string;
  moveToTeam(newTeamId: string): void;
};
```

To-many relations on the reverse side appear as collection wrappers with `.load()` / `.items` (matching today's `RefCollection` API).

## Compile to ModelRegistry

The schema compiler is the bridge. Every input shape lands in the same `ModelRegistry` entries decorators produce.

### Entity → `ModelMeta`

| Schema | `ModelMeta` field |
|---|---|
| entity key (or `name` override, PascalCase) | `name` |
| `entity({ loadStrategy })` | `loadStrategy` |
| `entity({ usedForPartialIndexes })` | `usedForPartialIndexes` |
| computed schema hash (see below) | `schemaVersion` |
| generated synthetic class | `ctor` |
| compiled fields | `properties` |
| extension actions (after composition) | `actions` |
| extension computed (after composition) | `computedProps` |

`ctor` is the awkward one. Decorators register the user's class; schema entities have no class to register. The compiler synthesizes a per-entity runtime class that extends `BaseModel` and is keyed by registry name. This keeps the rest of the engine unchanged — the ObjectPool, hydration, change tracking, and collection wrappers all behave exactly as they do for decorator models.

### Field → `PropertyMeta`

| Builder | `PropertyType` | Other meta |
|---|---|---|
| `s.string()` / `s.number()` / `s.boolean()` / `s.json()` | `Property` | — |
| `s.date()` | `Property` | built-in ISO `serializer` / `deserializer` |
| `s.id()` | `Property` | `isId: true` |
| `s.refId("X")` | `Reference` | `referenceTo: "X"`, `nullable`, `indexed`, `onDelete` from link |
| `.indexed()` | — | `indexed: true` |
| `.nullable()` | — | `nullable: true` |
| `.default(v)` | — | `defaultValue: v` |
| `.ephemeral()` | `EphemeralProperty` | — |
| `.serialize(fn)` / `.deserialize(fn)` | — | overrides defaults |

### Link → relationship metadata

For:

```typescript
teamId: s.refId("team").nullable().indexed(),
issueTeam: link({
  from: { entity: "issue", field: "teamId", as: "team" },
  to:   { entity: "team",  many: "issues", lazy: true },
  onDelete: "cascade",
}),
```

The compiler produces:

- `Issue.teamId` → `PropertyType.Reference`, `referenceTo: "Team"`, `nullable: true`, `indexed: true`, `onDelete: "cascade"`.
- `Issue.team` → synthetic `PropertyType.ReferenceModel` resolving via `teamId`.
- `Team.issues` → `PropertyType.ReferenceCollection`, `inverseOf: "teamId"`, `lazy: true`.

Identical to what `@Reference` + `@ReferenceCollection` + `@BackReference` produce today.

### Cross-validation invariants

The compiler enforces these at compile time and rejects the schema on violation:

1. Every `link.from.field` exists on `link.from.entity` and is an `s.refId(...)` field.
2. The `s.refId("X")` target equals `link.to.entity`.
3. Every `s.refId(...)` field is referenced by exactly one link's `from.field`. (Exception: a refId without a link is allowed but logs a dev warning — it means a string FK with no relation traversal.)
4. `link.to.many` and `link.from.as` do not collide with declared field names on their respective entities.
5. Two entities cannot compile to the same registry name.
6. Schema and decorator paths cannot define the same registry name unless explicitly aliased (see Coexistence).

Where possible, these are enforced at the type level inside `link(...)` so violations surface as TS errors before runtime.

### Schema hash

`ModelMeta.schemaVersion` is a stable hash of the entity's compiled metadata: field names, types, modifiers, and relation shape. The IDB layer (see [`03-indexeddb-and-persistence.md`](03-indexeddb-and-persistence.md)) compares this hash against the persisted one and runs migration when it changes. `entity({ version: N })` overrides if a deployment needs to force migration without metadata change.

## Decorator coexistence

The principle: both authoring paths produce the same `ModelRegistry` shape, so the runtime can't tell them apart.

**Mixed graphs are allowed.** A schema entity can link to a decorator-defined model and vice versa, as long as registry names match.

```typescript
// existing decorator model
@ClientModel({ loadStrategy: LoadStrategy.Eager })
export class User extends BaseModel { ... }

// new schema entity referencing it
export const schema = defineSchema({
  entities: {
    issue: entity({
      fields: {
        // ...
        assigneeId: s.refId("user").nullable(),  // resolves to "User" registry name
      },
    }),
  },
  links: {
    issueAssignee: link({
      from: { entity: "issue", field: "assigneeId", as: "assignee" },
      to:   { entity: "user",  many: "assignedIssues", lazy: true },
    }),
  },
});
```

**Collision rules:**

- Hard error if two definitions claim the same registry name with incompatible field/relation metadata.
- Allowed if a definition is marked as external — `entity({ name: "Issue", external: true, ... })` tells the compiler to skip class generation, property registration, and reverse-collection installs for that entity. The decorator-registered class stays canonical; the schema entity exists only so cross-references and types can resolve against the registry name. This is the V1 coexistence story.

**Migration recipe:**

1. Existing app keeps decorator models.
2. Add `defineSchema(...)` for one or two entities.
3. Compile schema into the registry under the same canonical names; resolve any collisions.
4. Add `createStore({ schema })` alongside existing model usage.
5. Gradually replace decorator authoring entity-by-entity.

The runtime, IDB layout, sync protocol, and React/headless APIs do not change during migration.

## Reactivity surface

Public `store.<entity>.peek(id)` returns a typed proxy. The proxy must behave equivalently to a decorator-defined `BaseModel` instance for reactive consumers:

- Property reads track observable state (works inside `observer()`, `useRecord()`, agent `watch()`).
- Singular relation reads (`issue.team`) track pool identity atoms.
- Reverse collections (`team.issues.load()` / `.items`) remain reactive lazy wrappers.
- Writes go through the same transaction queue and undo stack.

V1 implementation: the proxy wraps a `BaseModel` instance from the synthesized constructor. The proxy adds extension members (computed / actions) on top. The instance itself is what lives in the ObjectPool.

## V1 scope

Build:

- `defineSchema`, `entity`, `link`, `fields` (`id`, `refId`, `string`, `number`, `boolean`, `date`, `json`)
- Modifiers: `.nullable`, `.indexed`, `.default`, `.ephemeral`, `.serialize`, `.deserialize`
- `compileSchema` → `ModelRegistry`, with the cross-validation invariants enforced
- `InferEntity`, `InferCreateInput`, `InferUpdateInput`, `InferRecord`
- `createStore({ schema, extensions, adapter, sync })`
- `store.<entity>` namespace:
  - **sync pool snapshot**: `peek` / `peekAll` / `peekByIndex`
  - **async pool-or-fetch**: `get` / `getByIds` / `getByIndex` / `getAll`
  - **mutations**: `create` / `update` / `delete` / `archive` / `seed`
  - **force network re-fetch**: `refresh` / `refreshAll` / `refreshByIndex`
  - **per-record commit**: `save` / `hasUnsavedChanges` / `discardUnsavedChanges`
- `db` top-level: `batch` / `undo` / `redo` / `undoDepth` / `redoDepth` / `runUndoable`
- `extend(...)` in both per-entity and whole-schema forms
- `entity({ external: true, name: "..." })` for coexistence with decorator-registered models
- `fromZod(zodSchema)` and `entityFromZod(zodObject, opts)` — Zod is an optional peer dependency; the adapter walks Zod's `_zod.def` introspection and maps primitives + `nullable` / `optional` / `default` modifiers, falling through to `s.json<T>()` for structured types
- One worked example: `Team` + `Issue` schemas exercised through `__tests__/Schema*.test.ts`

Defer:

- `store.<entity>.query(...)` — design the where/include/orderBy surface in a follow-up, it's independent
- Top-level multi-entity InstaQL document
- OpenAPI → schema importer
- Many-to-many through-table sugar
- Generated devtools schema viewer
- Decorator → schema reverse direction (a decorator class linking to a schema-owned entity)

Each deferred item is independent of the others and of V1. None block the prototype.

## Implementation order

1. Type-only spike: write `defineSchema` / `entity` / `link` / `fields` / `InferEntity` with no runtime, validate that cross-entity inference works (especially `s.refId("team")` constraining against `entities` keys).
2. Compiler: schema → `ModelRegistry` entries. Generate synthetic constructors. Hash schemaVersion. Run cross-validation.
3. `createStore` facade over `StoreManager`. Implement `peek` / `create` / `update` / `delete` only.
4. Extension composition. `extend(...)` returns descriptors; `createStore` merges them into per-entity action/computed sets and wires MobX wrapping.
5. Worked example + tests against `Team` / `Issue`.
6. Decorator coexistence test: one schema entity linking to one decorator model.

## Docs to update when this lands

Per the table in [`CLAUDE.md`](../CLAUDE.md):

- [`agent-docs/01-models-and-decorators.md`](01-models-and-decorators.md) — add a "Schema-first authoring" section pointing here, note that both paths produce equivalent `ModelMeta`.
- [`README.md`](../README.md) "Define your models" — show the schema variant alongside the decorator variant.
- [`agent-docs/04-lazy-loading.md`](04-lazy-loading.md) — note that `LoadStrategy.Ephemeral` is settable via `entity({ loadStrategy: ... })`.
- [`agent-docs/10-inverse-links-and-reactivity.md`](10-inverse-links-and-reactivity.md) — explain that `link(...)` produces both sides of an inverse relation from one declaration.

## Open questions

These are non-blocking but worth resolving before V1 ships.

1. **`s.json<T>()` and structured updates.** Today JSON blobs are opaque. Should `update()` accept a partial deep-merge, or replace-only? Decorators don't take a stance; we should.
2. **Extension type inference across files.** `extend(schema, "issue", { ... })` returning a descriptor is straightforward, but composing multiple descriptors into `createStore` and having TS infer the merged record type may need a helper like `composeExtensions(...)`.
3. **Synthetic constructor identity.** If user code does `instanceof` checks on records, the synthesized class is opaque. Probably fine — public API is the proxy — but worth a note.
