# sync-engine

A TypeScript local-first sync engine. Reads are synchronous from an in-memory pool, writes are optimistic, state stays current across tabs and clients via SSE, and everything persists locally so the app survives reload and works offline. The same engine runs in Node so agents and background workers can hold a live model just like a browser tab.

You bring the backend. The client speaks a small three-endpoint protocol — implement it in any language. A reference Go backend is included in this repo so you can see a working end-to-end system, but it isn't the product.

## What you get

- **Local-first** — every read is sync against an in-memory `ObjectPool`; writes apply optimistically and reconcile with server deltas.
- **Realtime** — multi-tab and multi-client sync via SSE. Other clients' edits show up without polling.
- **Offline** — IndexedDB-backed; transactions queue while disconnected and replay on reconnect.
- **Two authoring paths** — decorator classes for hand-written models, or `defineSchema(...)` for schema-as-data with a fully-typed `db.<entity>.*` API. Both compile to the same registry shape and coexist in one app.
- **Batched undo/redo** — group writes into a single undoable action; `runUndoable(fn)` puts non-model server calls on the same stack.
- **Headless** — no React or DOM dependency in the core. Run it in Node for agents, CLIs, or service-side workers.
- **Bring your own backend** — three endpoints, no specific language or storage required.

## Three subpaths

| Import | What's in it |
|---|---|
| `sync-engine` | `StoreManager`, `BaseModel`, decorators, `ObjectPool`, types. Vanilla TS — no React, no DOM. |
| `sync-engine/schema` | `defineSchema`, `entity`, `link`, `s` (field builders), `extend`, `createDb`, Zod adapter (`fromZod` / `entityFromZod`). Schema-as-data authoring; produces a typed `db.<entity>.*` API. |
| `sync-engine/react` | `<SyncProvider>` and hooks: `useModel`, `useModels`, `useIndexedCollection`, `useIndexedCollections`, `useCollection`, `useBackRef`, `useUndoRedo`, `useBatch`, `useBootstrapStatus`. Schema-typed siblings: `useDbModel`, `useDbModels`, `useDbIndexedCollection`, `useDbIndexedCollections`. |

## Define your models

Models extend `BaseModel` and use decorators to declare fields and relationships.

```ts
import {
  BaseModel,
  ClientModel,
  Property,
  Reference,
  LazyReferenceCollection,
  LoadStrategy,
} from "sync-engine";
import type { RefCollection } from "sync-engine";

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class Team extends BaseModel {
  @Property() public name = "";

  @LazyReferenceCollection("Issue", { inverseOf: "teamId" })
  public issues: RefCollection<Issue>;
}

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class Issue extends BaseModel {
  @Property() public title = "";
  @Property() public priority = 0;

  @Property({ indexed: true })
  public teamId: string | null = null;

  @Reference("Team", { onDelete: "cascade" })
  public team: Team;
}
```

- `@Property` — persisted, observable field. `indexed: true` builds a secondary IndexedDB index on it.
- `@Reference` / `@LazyReference` — foreign-key to another model. `issue.team` resolves the Team from the pool. `@Reference` eagerly pulls the target into the pool during hydration; `@LazyReference` is a sync getter that returns whatever is in the pool right now.
- `@ReferenceCollection` / `@LazyReferenceCollection` — one-to-many where the foreign key lives on the child. Eager variant loads alongside the parent (recursively for nested eager collections); lazy variant stays Idle until `.load()` or `useCollection` subscribes.
- `@OwnedCollection` / `@LazyOwnedCollection` — one-to-many where the parent stores the child IDs as an array. Same eager/lazy split.
- `@BackReference` — single inverse relationship; deleting the owner cascades.
- `loadStrategy` — `Instant` loads at bootstrap; `Lazy` / `Partial` / `ExplicitlyRequested` load on demand; `Ephemeral` stays in the pool only (never persisted).

See [`agent-docs/01-models-and-decorators.md`](agent-docs/01-models-and-decorators.md) for the full decorator reference.

## Schema-first authoring (alternative)

The same models authored as plain data, with a typed `db.<entity>.*` API falling out of the schema:

```ts
import {
  defineSchema, entity, link, fields as s, LoadStrategy,
  createDb, extend,
} from "sync-engine/schema";

export const schema = defineSchema({
  entities: {
    team: entity({
      loadStrategy: LoadStrategy.Instant,
      fields: { id: s.id(), name: s.string() },
    }),
    issue: entity({
      loadStrategy: LoadStrategy.Instant,
      fields: {
        id:       s.id(),
        title:    s.string().default(""),
        priority: s.number().default(0),
        teamId:   s.refId("team").nullable().indexed(),
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

const db = createDb({ schema, storeManager: sm });

// Reads — sync (peek) vs async (get) vs force-network (refresh):
const team = db.team.peek(teamId);                              // pool snapshot, sync
const issue = await db.issue.get(issueId);                      // pool-first, falls back to IDB / fetcher
const allTeams = await db.team.getAll();
const teamIssues = await db.issue.getByIndex("teamId", teamId); // key constrained to .indexed() fields

// Writes — typed records with create/update/delete + per-record save:
const issueA = db.issue.create({ title: "Fix bug", teamId: team!.id });
db.issue.update(issueA.id, { priority: 1 });
issueA.title = "Fix hydration bug"; issueA.save();

// Subscriptions — payload-less, re-read inside the handler:
db.issue.watchByIndex("teamId", teamId, () => {
  const items = db.issue.peekByIndex("teamId", teamId);
});
```

Behavior (computed + actions) lives outside the schema via `extend(...)` so the schema descriptor stays serializable:

```ts
const issueBehavior = extend(schema, "issue", {
  computed: { identifier: (i) => `${i.priority}-${i.title.slice(0, 8)}` },
  actions:  { moveToTeam(i, teamId: string) { i.teamId = teamId; } },
});
const db = createDb({ schema, storeManager: sm, extensions: [issueBehavior] });
```

Both authoring paths compile to the same `ModelRegistry`, so a schema entity can reference a decorator class via `entity({ external: true, name: "User" })` (and vice versa).

### Drive entities from a Zod schema

If your record shapes already live as Zod schemas (for example, schemas you also validate server responses with elsewhere), `entityFromZod(...)` reuses them as the field source. Zod doesn't carry FK or index metadata — layer those on per-field via `opts.fields`:

```ts
import { z } from "zod";
import {
  defineSchema, entityFromZod, link, fields as s, LoadStrategy,
} from "sync-engine/schema";

const ZodTeam = z.object({
  id:   z.string(),
  name: z.string(),
});

const ZodIssue = z.object({
  id:       z.string(),
  title:    z.string().default(""),
  priority: z.number().default(0),
  teamId:   z.string().nullable(), // Zod owns nullability; override adds FK metadata
  email:    z.string().nullable(),
});

const schema = defineSchema({
  entities: {
    team:  entityFromZod(ZodTeam, {
      loadStrategy: LoadStrategy.Instant,
      name: "Team",
    }),
    issue: entityFromZod(ZodIssue, {
      loadStrategy: LoadStrategy.Instant,
      name: "Issue",
      fields: {
        // Replacement form — substitute the Zod-derived FieldBuilder entirely.
        teamId: s.refId("team").nullable().indexed(),
        // Chain form — modify the auto-derived builder.
        email:  (b) => b.indexed(),
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

Override keys are constrained to `keyof z.infer<Z>` so typos fail to compile. Zod stays the source of field shape and TypeScript types here; `link(...)` stays the source of truth for the relationship graph, and you can still reuse the same Zod schemas for validation at your API boundaries.

See [`agent-docs/11-schema-first-authoring.md`](agent-docs/11-schema-first-authoring.md) for the full reference.

## React quick start

Wrap your app in `<SyncProvider>` once. Import your model file as a side-effect so the decorators run before bootstrap.

```tsx
import "reflect-metadata";
import { SyncProvider } from "sync-engine/react";
import "./models"; // side-effect import — registers model classes

export default function Providers({ children }) {
  return (
    <SyncProvider
      config={{
        workspaceId: "workspace-123",
        bootstrapFetcher: async (type, sinceSyncId) => {
          const res = await fetch(`/api/bootstrap?type=${type}&since=${sinceSyncId ?? 0}`);
          return res.json();
        },
        transactionSender: async (batch) => {
          const res = await fetch("/api/transactions", {
            method: "POST",
            body: JSON.stringify(batch),
          });
          return res.json();
        },
        syncUrl: "/api/events",
      }}
      fallback={<div>Loading…</div>}
    >
      {children}
    </SyncProvider>
  );
}
```

### Reading data

```tsx
const { items: issues } = useModels<Issue>("Issue");        // all instances; re-renders on add/remove
const { item: issue } = useModel<Issue>("Issue", issueId);  // single by ID; auto-loads on pool miss
const { phase } = useBootstrapStatus();                      // engine lifecycle state
```

Pool-keyed hooks (`useModel`, `useModels`, `useIndexedCollection`) return `{ item | items, isLoading, error, reload }`. The collection-wrapper hooks (`useCollection`, `useBackRef`) wrap a runtime collection you already hold and additionally expose `isLoaded` (and return `value` for `useBackRef`).

If you author models via `defineSchema(...)`, prefer the typed siblings — they take the `db.<entity>` namespace directly and infer the record type from the schema:

```tsx
import { useDbModel, useDbModels, useDbIndexedCollection } from "sync-engine/react";

const { item: issue } = useDbModel(db.issue, issueId);
const { items: teams } = useDbModels(db.team);
const { items: teamIssues } = useDbIndexedCollection(db.issue, "teamId", teamId);
//                                                            ^^^^^^^^ autocompletes to indexed fields only

// Multi-value form — issues for any of these teams.
const { items: myIssues } = useDbIndexedCollections(db.issue, "teamId", myTeamIds);
```

Same return shape, same reactivity contract — the typed hooks are thin wrappers that resolve the registry name from the namespace and delegate to the string-keyed primitives.

### Writing data

```tsx
// Optimistic update — the UI updates immediately; the engine sends to the server in the background.
issue.title = "New title";
issue.save();

// Bulk-assign + send. Works for both new and existing models.
const issue = new Issue();
issue.update({ title: "Hello", priority: 1, teamId: "abc" });

// Pass IDs for related models, not the object itself.
const team = new Team();
team.update({ name: "Engineering" });
const issue2 = new Issue();
issue2.update({ title: "Hello", teamId: team.id });

// Preview / discard — edit locally without committing.
issue.assign({ title: "Draft", priority: 3 });
issue.hasUnsavedChanges;       // true
issue.discardUnsavedChanges(); // reverts to last-saved values
// or: issue.save() to commit

// Batched, single-undo writes.
const batch = useBatch();
batch(() => {
  issue.title = "x"; issue.save();
  issue.priority = 1; issue.save();
});

const { undo, redo, canUndo, canRedo } = useUndoRedo();

// Non-model server calls — wrap to put on the undo stack alongside model edits.
const { archivedCount } = await sm.runUndoable(
  () => api.bulkArchive({ teamId }),    // returns { changeLogId, ... }
  { actionType: "bulkArchive" },
);
```

### Lazy collections

```tsx
const { items: issues, isLoading } = useCollection(team?.issues);    // @ReferenceCollection
const { items: members } = useCollection(team?.members);              // @OwnedCollection
const { value: favorite } = useBackRef(issue?.favorite);              // @BackReference

// When you have a model name + index key + value but not the parent instance:
const { items: activities } = useIndexedCollection<Activity>("Activity", "taskId", taskId);
```

`team.issues.items` stays in sync with the pool automatically — when a delta inserts a new Issue with `teamId === team.id`, the engine attaches it to the parent's collection inline, so observers re-render without a re-fetch. See [`agent-docs/10-inverse-links-and-reactivity.md`](agent-docs/10-inverse-links-and-reactivity.md).

Decorator names match Linear's convention: `@Reference` / `@ReferenceCollection` / `@OwnedCollection` are eager (loaded alongside the parent, recursively for nested eager collections), and the `@Lazy*` prefixed variants are loaded on demand. See [`agent-docs/04-lazy-loading.md`](agent-docs/04-lazy-loading.md).

## Headless quick start (Node, agents, workers)

The same `StoreManager` runs without React or a browser. Useful for agents that need a live model rather than a snapshot.

```ts
import "reflect-metadata";
import { StoreManager, MemoryAdapter } from "sync-engine";
import EventSource from "eventsource";
import "./models";

const sm = new StoreManager({
  workspaceId: "agent-1",
  bootstrapFetcher: async (type, since) => {
    const res = await fetch(`http://localhost:8080/api/bootstrap?type=${type}&since=${since ?? 0}`);
    return res.json();
  },
  transactionSender: async (batch) => {
    const res = await fetch("http://localhost:8080/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    return res.json();
  },
  syncUrl: "http://localhost:8081/api/events",
  sseClientFactory: (url) => new EventSource(url),
  storageAdapter: new MemoryAdapter(),
});

await sm.bootstrap();
```

| Environment | `sseClientFactory` | `storageAdapter` |
|---|---|---|
| Browser | default (`EventSource`) | default (IndexedDB) |
| Node.js | `eventsource` package | `MemoryAdapter` or custom |
| Serverless / edge | fetch-based SSE reader | `MemoryAdapter` |

For durable agents, implement `StorageAdapter` (12 methods) against SQLite, Redis, or any KV store.

### Reactivity outside React

```ts
// Pool-level: fires when models of a type are added or removed.
const off = sm.objectPool.subscribe("Issue", () => {
  const issues = sm.objectPool.getAll("Issue");
});

// Collection-level: fires when items are attached, detached, replaced, or load() runs.
team.issues.subscribe(() => { /* team.issues.items is current */ });

// Field-level: fires when a specific field (or derived value) changes.
issue.watch((m) => m.priority, (next, prev) => { /* ... */ });
issue.watch((m) => m.status === "done", (isDone) => { /* ... */ });
```

### Pool-first reads — the get-or-load family

Four symmetric APIs, all generic over `T extends BaseModel`. Each checks the pool first, then IDB, then the configured fetcher:

```ts
const driver = await sm.getOrLoadById<DriverModel>("DriverModel", id);
//    ^? DriverModel | null

// Bulk-by-ids — coalesces missing ids into a single onDemandBatchFetcher
// call (one server request instead of N).
const drivers = await sm.getOrLoadByIds<DriverModel>("DriverModel", ids);
//    ^? DriverModel[]

const comments = await sm.getOrLoadCollection<Comment>("Comment", "issueId", issueId);
//    ^? Comment[]

// Load every instance of a model — Lazy / Partial models trigger a Full
// bootstrap fetch on first call; coverage is cached so subsequent calls
// hit the pool directly.
const allDrivers = await sm.getOrLoadAll<DriverModel>("DriverModel");

// Optional sync-group scoping — fetches only the drivers in those groups.
const teamADrivers = await sm.getOrLoadAll<DriverModel>("DriverModel", {
  syncGroups: ["team-A"],
});
```

`getOrLoadById` / `getOrLoadByIds` / `getOrLoadCollection` are the pool-first lookup APIs. `getOrLoadAll` completes the set by loading every instance of a model; per-strategy: Instant + Ephemeral return the pool snapshot directly (already fully resident); Lazy / Partial / ExplicitlyRequested fetch from the server; Local reads from IDB. Coverage is tracked under a reserved `"*"` sentinel key in the partial-index store, scoped per `syncGroups` set so different scopes are cached independently.

For Storybook / test fixtures, two pool-only seed helpers (`sm.seed(modelName, records)` / `sm.seedMany({...})`) accept the same shape as `bootstrapFetcher`'s `models` response — see [`agent-docs/08-react-integration.md`](agent-docs/08-react-integration.md#storybook--testing) for the full pattern.

### Refreshing stale data

When a long-lived agent reconnects after a stream gap, three APIs re-fetch from the server while preserving object identity (existing references see updated values, not new objects):

```ts
await sm.refreshCollection("Activity", "taskId", "t1");
await sm.refreshModels("Activity", ["a1", "a2"]);
await sm.refreshAllOfModel("Activity");
```

### Observability

Wire `onError` once and every async failure the engine catches internally — eager loads, SSE parse errors, transaction send retries, deferred bootstrap fetches, sync-group eviction callback throws — routes through it with a tagged-union context describing the failure site:

```ts
import { StoreManager, type EngineErrorContext } from "sync-engine";

new StoreManager({
  // ...
  onError: (err, ctx: EngineErrorContext) => {
    Sentry.captureException(err, { tags: { kind: ctx.kind, ...ctx } });
  },
});
```

`ctx.kind` is one of: `eagerReferenceLoad`, `eagerCollectionLoad`, `lazyCollectionLoad`, `lazyOwnedCollectionLoad`, `lazyBackRefLoad`, `deferredBootstrap`, `newModelsBootstrap`, `transactionDiscarded`, `syncGroupFetch`, `ssePacketParse`, `sseConstruction`, `transactionSend`, `onSyncGroupDelete`, `undoableAction`. Each carries fields specific to its site (model name, parent id, raw SSE message, etc.). Without `onError`, internal failures are silently dropped (existing behavior preserved).

Other lifecycle hooks on the same config:

- `onPhaseChange(phase, detail)` — bootstrap state machine (`Idle` → `Fetching` → `Hydrating` → `Ready` | `Error`).
- `onDeltaPacket(packet)` — fires on every SSE delta after it processes.
- `onReady()` — fires when bootstrap completes.
- `undoableActions: { undo, redo? }` — handlers for `runUndoable(fn)` entries on the undo stack. Each receives the recorded `UndoableAction` and returns the compensating action (or void to reuse the original). See [`agent-docs/06-transactions-and-undo.md`](agent-docs/06-transactions-and-undo.md).

### Isolated vs shared agent state

- **Isolated** — each agent has its own `StoreManager`. Convergence happens via SSE. Undo is local; agent writes arrive in the browser as deltas and never touch the browser's undo stack.
- **Shared** — multiple agents share one `StoreManager` in the same process (web worker, VS Code extension, etc.). No round-trip; all writes hit the same undo stack.

## Backend protocol

The client needs three endpoints. Implement them in any language. The reference Go backend in this repo is one example; replace it with whatever fits your stack.

### `GET /api/bootstrap`

Query params: `type` (model name), `since` (syncId, optional). Returns all records of that type, or only those updated since `since`.

```json
{
  "lastSyncId": 5205,
  "subscribedSyncGroups": ["workspace-abc"],
  "models": {
    "Issue": [ { "id": "...", "title": "...", "teamId": "..." } ],
    "Team":  [ { "id": "...", "name": "..." } ]
  },
  "backendDatabaseVersion": 1
}
```

The client calls bootstrap on startup, then subscribes to the SSE stream from `lastSyncId` forward.

### `POST /api/transactions`

```json
{
  "transactions": [
    { "id": "uuid", "action": "I", "modelName": "Issue", "modelId": "uuid",
      "data": { "id": "...", "title": "...", "teamId": "..." } },
    { "id": "uuid", "action": "U", "modelName": "Issue", "modelId": "uuid",
      "changes": { "title": { "oldValue": "Old", "newValue": "New" } } },
    { "id": "uuid", "action": "D", "modelName": "Issue", "modelId": "uuid" }
  ]
}
```

Actions: `I` (insert), `U` (update), `D` (delete), `A` (archive). Updates include old + new per field so the client can rebase optimistic changes against authoritative deltas.

```json
{ "success": true, "lastSyncId": 5206 }
```

### `GET /api/events` (SSE)

Each message is a delta packet:

```json
{
  "syncActions": [
    { "id": 5206, "modelName": "Issue", "modelId": "uuid",
      "action": "U", "data": { "title": "New title", "priority": 1 } }
  ],
  "addedSyncGroups": [],
  "removedSyncGroups": []
}
```

`id` is a monotonic syncId. The client passes `?since=<lastSyncId>` on connect so the server can replay missed events.

### Sync groups

Sync groups control which clients receive which events. Every write is tagged with one or more group labels; the server only delivers an event to SSE connections subscribed to at least one of the same labels. The labels are arbitrary strings — workspace IDs are typical.

The client declares its groups at connect time via the `syncGroups` query param on both `/api/bootstrap` and `/api/events`. If a user is added to a new group mid-session, the server sends a delta with `addedSyncGroups`; the client bootstraps the new data and starts receiving events for it without reconnecting. Wire this up with `syncGroupFetcher`:

```ts
const sm = new StoreManager({
  // ...
  syncGroupFetcher: async (addedGroups) => {
    const res = await fetch(`/api/bootstrap?syncGroups=${addedGroups.join(",")}`);
    return res.json();
  },
});
```

If your app has a single fixed scope per session, you can omit it.

### Compound index-key fetches

Two layers of compound parity, both opt-in:

1. **Client-side auto-derived covering indexes** — `RefCollection`s walk the parent's FK graph (`transientIndexDepth`, default 3) and emit additional partial-index queries when the child denormalizes a parent FK. Adopters need only set `@Property({ indexed: true })` on the denormalized field. No protocol change. See [`agent-docs/04-lazy-loading.md`](agent-docs/04-lazy-loading.md).

2. **Server-side compound queries** — when ≥ `compoundIndexFetchThreshold` (default 5) concurrent `getOrLoadCollection` requests share a parent FK value, the engine collapses them into one dotted-path query (e.g. 50 `Comment[taskId=Tx]` → one `Comment[taskId.projectId=P1]`). The server resolves the dotted path via a JOIN and returns the union; per-waiter filtering narrows each caller's slice. Opt in with `serverSupportsCompoundIndexKeys: true`; backends without JOIN support keep per-parent fan-out.

   **Coverage caching.** After the compound fetch lands, the full response bag is written to IDB and the compound key is recorded in the partial-index store. A future direct `getOrLoadCollection("Comment", "taskId", T_new)` short-circuits when `T_new`'s parent FK matches the recorded compound's value — no redundant network call.

```ts
new StoreManager({
  // ...
  onDemandIndexBatchFetcher: async (queries) => fetch(...).then(r => r.json()),
  serverSupportsCompoundIndexKeys: true,
  // compoundIndexFetchThreshold: 5,  // optional, defaults to 5
});
```

The server contract: `indexKey` may be a dotted path. Each segment is an FK on the previous model. The engine only currently emits one-hop dotted paths (e.g. `taskId.projectId`); deeper paths are a future revision.

## Documentation

Deeper material lives in [`agent-docs/`](agent-docs/):

- [00 — Architecture overview](agent-docs/00-overview.md)
- [01 — Models and decorators](agent-docs/01-models-and-decorators.md)
- [02 — ObjectPool](agent-docs/02-object-pool.md)
- [03 — IndexedDB and persistence](agent-docs/03-indexeddb-and-persistence.md)
- [04 — Lazy loading](agent-docs/04-lazy-loading.md)
- [05 — Sync groups](agent-docs/05-sync-groups.md)
- [06 — Transactions and undo](agent-docs/06-transactions-and-undo.md)
- [07 — Realtime sync](agent-docs/07-realtime-sync.md)
- [08 — React integration](agent-docs/08-react-integration.md)
- [09 — Headless and agents](agent-docs/09-headless-and-agents.md)
- [10 — Inverse links and reactivity](agent-docs/10-inverse-links-and-reactivity.md)
- [11 — Schema-first authoring](agent-docs/11-schema-first-authoring.md)

## Reference backend and demo

This repo includes a Go backend (`go/`) and a Next.js demo app (`webapp/`) so you can run a working end-to-end system locally. Treat it as a reference implementation — your real backend can be anything that speaks the protocol above.

**Prerequisites:** Docker, Go 1.22+, Node 18+, Make.

```bash
make go-tidy        # generate go.sum (once after cloning)
make start-backend  # Postgres + Go services (API :8080, SSE :8081)
make install-webapp # install webapp deps (once)
make run-webapp     # Next.js dev server
```

Open [http://localhost:3000](http://localhost:3000) in two tabs to see sync in action.

```bash
make ps           # show running containers
make logs         # tail API + SSE logs
make stop-backend # stop containers, keep Postgres data
make clean        # stop containers + wipe Postgres volume
```

### How the reference backend is wired

One Go binary, two service modes controlled by `SERVICE_MODE`:

- **api** (stateless, `:8080`) — `GET /api/bootstrap` and `POST /api/transactions`. Scales horizontally.
- **sse** (stateful, `:8081`) — `GET /api/events`. Holds SSE connections and runs a Postgres `LISTEN/NOTIFY` goroutine.

Write flow:

1. Client: `issue.title = "x"; issue.save()`.
2. `TransactionQueue` batches and POSTs to the API.
3. Go: `BEGIN` → model write → changelog append → `COMMIT`.
4. Postgres trigger fires `pg_notify`.
5. SSE listener queries the row; broadcaster fans out to subscribed clients.
6. `EventSource` receives the delta; `ObjectPool` updates; React re-renders.

| Endpoint | Service | Purpose |
|---|---|---|
| `GET /api/bootstrap` | api | Full or partial bootstrap |
| `POST /api/transactions` | api | Client mutations |
| `GET /api/events` | sse | SSE stream |
| `GET /api/health` | both | Status check |
| `GET /api/stats` | sse | Connected client count |

### Single-process dev mode

```bash
cd go
go mod tidy
SERVICE_MODE=all DATABASE_URL=postgres://postgres:password@localhost:5432/syncdb?sslmode=disable go run cmd/server/main.go
```

Set both `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SSE_URL` to `http://localhost:8080`.

## Project structure

```
.
├── packages/
│   └── sync-engine/                 Publishable library (npm: sync-engine)
│       ├── src/
│       │   ├── core/                Engine internals
│       │   └── react/               SyncProvider + hooks
│       └── __tests__/
├── webapp/                          Next.js demo app (reference UI)
│   ├── app/
│   └── lib/models/                  Domain models
├── go/                              Reference backend (Go + Gin + Bun ORM)
│   ├── cmd/server/main.go
│   ├── internal/
│   │   ├── config/                  SERVICE_MODE: all | stateless | stateful
│   │   ├── database/                Bun models, changelog queries
│   │   ├── sync/                    Broadcaster + Listener (LISTEN/NOTIFY)
│   │   ├── handler/                 Bootstrap, transactions, SSE
│   │   └── types/
│   └── migrations/
├── agent-docs/                      Architecture and design docs
├── docker-compose.yml
└── Makefile
```

## Tech stack

- **Client**: TypeScript, MobX, IndexedDB, EventSource (SSE)
- **Reference server**: Go, Gin, Bun ORM, Postgres (LISTEN/NOTIFY), pgx
- **Protocol**: Append-only changelog, monotonic syncId, sync group filtering
