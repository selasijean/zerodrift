# zerodrift

[![npm](https://img.shields.io/npm/v/zerodrift.svg)](https://www.npmjs.com/package/zerodrift)

**A TypeScript sync engine with an intuitive model API that hides the hard parts of local reads, optimistic writes, offline recovery, and realtime convergence.**

zerodrift lets you work with synced data like normal application state. Components and headless workers read records synchronously, mutate model fields directly, call `save()`, and subscribe with typed React hooks or store APIs. Under that simple surface, the engine does the synchronization work that would otherwise spread across your codebase.

The backend stays yours. Implement bootstrap, transaction, and event-stream endpoints in any stack, or start from the included Go backend and Next.js demo. In the browser, zerodrift persists models and queued writes to IndexedDB; in Node, it can run against memory or a custom storage adapter.

The result is less sync code in every feature. Define models with decorators or schema-as-data, wire the three transport functions, and build against a small, predictable API while browser tabs, clients, and Node processes converge in the background.

The design is inspired by Linear's sync engine; see [Acknowledgments](#acknowledgments) for prior art and attribution.

## What you get

- **A small API for synced data**: read records synchronously, mutate model fields directly, call `save()`, or use typed store namespaces generated from a schema.
- **App logic without cache choreography**: fetching, invalidation, optimistic updates, reconnects, offline replay, and conflict rebasing live in the engine instead of every screen.
- **Optimistic writes with real recovery**: local changes update immediately, batch into transaction POSTs, persist through reloads, and reconcile when matching server deltas arrive. `store.optimistic(mutate, persist)` pairs a mutation with its own network call — the touched fields commit when it resolves and revert when it rejects, and any number of operations can be in flight at once.
- **Relationships that stay live**: references, inverse collections, owned collections, and indexed lookups update as records hydrate, load lazily, or arrive over SSE.
- **Schema or class models**: use decorators (`@ClientModel`, `@Property`, `@Reference`) or schema-as-data (`defineSchema(...)`, `entityFromZod(...)`) without `reflect-metadata`.
- **Memory you can shape**: choose per-model `LoadStrategy` values for eager data, lazy tables, partial index-backed loading, local-only records, or ephemeral SSE-fed state. Declarative eviction policies cap pool size and auto-evict when sync groups change.
- **Undo/redo built into the transaction layer**: track field-level changes, group atomic multi-model edits, and include custom remote actions in the same undo stack. Server-pushed deltas (e.g. an agent's streamed edits) can opt into the stack too via `advanced.remoteUndo` — undo reverts locally first, then submits the server-side revert by syncId.
- **React, browser, or headless Node**: use `<SyncProvider>` and typed hooks in React, or run `StoreManager` directly in agents, workers, CLIs, and tests.
- **Your backend, your stack**: implement three HTTP endpoints in any language, with a reference Go backend and Next.js demo included.

## Install

```bash
npm install zerodrift
```

Optional packages depend on the surface you use:

```bash
npm install zod         # for entityFromZod(...) schema authoring
npm install eventsource # for Node/headless SSE clients
```

Decorator path: enable `experimentalDecorators` in your `tsconfig.json` (or the SWC/Babel equivalent). Unlike most decorator libraries, `reflect-metadata` is **not** needed.

## Import paths

| Import               | Use it for                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zerodrift`          | `StoreManager`, `BaseModel`, decorators, `MemoryAdapter`, relation field types (`RefCollection`/`BackRef`/`OwnedRefs`), and the config / error / sync types. The curated, stable surface. |
| `zerodrift/schema`   | `defineSchema`, `entityFromZod`, field builders, links, extensions, and typed `store.<entity>.*` APIs.                                                                                    |
| `zerodrift/react`    | `<SyncProvider>` and React hooks: `useRecord`, `useRecords`, `useRecordsByIndex`, `useRelation`, `useWatch`, `useBatch`, `useUndoRedo`, `useBootstrapStatus`.                             |
| `zerodrift/internal` | Engine machinery (`ObjectPool`, `TransactionQueue`, `SyncConnection`, `ModelRegistry`, …) for tooling/tests. **No stability promise** — may change between releases.                      |

## Define your models

Decorator models extend `BaseModel` and use decorators to declare fields and relationships.

```ts
import {
  BaseModel,
  ClientModel,
  Property,
  Reference,
  LazyReferenceCollection,
  LoadStrategy,
} from "zerodrift";
import type { RefCollection } from "zerodrift";

@ClientModel({ name: "Team", loadStrategy: LoadStrategy.Eager })
export class Team extends BaseModel {
  @Property() public name = "";

  @LazyReferenceCollection("Issue", { inverseOf: "teamId" })
  public issues: RefCollection<Issue>;
}

@ClientModel({ name: "Issue", loadStrategy: LoadStrategy.Eager })
export class Issue extends BaseModel {
  @Property() public title = "";
  @Property() public priority = 0;

  @Property({ indexed: true })
  public teamId: string | null = null;

  @Reference("Team", { onDelete: "cascade" })
  public team: Team;
}
```

`@Property` fields are persisted and observable. `@Reference`, `@ReferenceCollection`, `@OwnedCollection`, and `@BackReference` describe relationships; `Lazy*` variants load on demand. `loadStrategy` controls whether a model loads during bootstrap or only when requested. Pass an explicit `@ClientModel({ name })` — it's the registry key and the `useRecord(Model, …)` handle; without it the class name is used, which minifiers mangle in production. An optional `idStrategy` (on `@ClientModel` or schema `entity(...)`) mints ids for client-created records of that model, taking precedence over the global `advanced.identifierFn`.

See [agent-docs/01-models-and-decorators.md](agent-docs/01-models-and-decorators.md) for the full decorator reference.

## Eviction

By default, records stay in memory for the session. Eviction lets you bound the pool and clean up stale data.

### Watermark (automatic)

Cap a model's pool size with FIFO eviction:

```ts
@ClientModel({
  name: "Comment",
  loadStrategy: LoadStrategy.Partial,
  eviction: { maxResident: 500 },
})
export class Comment extends BaseModel {
  @Property({ indexed: true }) public teamId = "";
  @Property() public body = "";
}
```

When the pool exceeds `maxResident` after a new insert, the oldest records are evicted down to `lowWaterRatio` (default 0.75). For persisted models (`Lazy` / `Partial`, plus `Eager` models that explicitly opt into eviction) the evicted rows stay in IDB for fast reload. `Ephemeral` models are pool-only with no IDB backing, so eviction drops the only copy and a reload has to come from the server via your on-demand fetcher (their collection coverage is session-scoped and never persisted). Set `eviction: false` to exempt a model entirely.

Global defaults in `StoreManagerConfig.eviction`:

```ts
new StoreManager({
  // ...
  eviction: {
    maxResident: 1000,        // cap for eviction-eligible models
    lowWaterRatio: 0.75,      // evict down to 75% of maxResident
  },
});
```

The global cap applies to **eviction-eligible** models — `Lazy`, `Partial`, and `Ephemeral`. `Eager` and `LocalOnly` models are exempt by default (`Eager` means "always resident"). To subject an `Eager` model to eviction, give it an explicit config: `eviction: {}` accepts the global cap, `eviction: { maxResident: N }` sets a per-model one. A per-model `maxResident` always wins over the global value.

### Sync-group cleanup (explicit)

When a sync group is deactivated, the `onSyncGroupDelete` callback fires. Use `evictByIndex` to drop the group's records:

```ts
new StoreManager({
  // ...
  hooks: {
    onSyncGroupDelete: async (groupId, sm) => {
      await sm.evictByIndex("Comment", "teamId", groupId, { keepInDb: true });
      await sm.evictByIndex("Issue", "teamId", groupId, { keepInDb: true });
    },
  },
});
```

Pass `{ safe: true }` to skip records that are observed, dirty, or in-flight. Pass `{ keepInDb: true }` to keep IDB rows for fast rehydration on re-subscribe.

**Safety guarantees.** The watermark eviction loop never evicts a record that:
- has **unsaved changes** (dirty fields not yet committed)
- has an **in-flight transaction** (sent to server, awaiting confirmation)
- is **observed by a mounted React hook** (`useRecord`, `useRecords`, `useRecordsByIndex`)
- belongs to a model with `LoadStrategy.LocalOnly` or `eviction: false`
- **just triggered the check** — inserting a record never evicts that same record, so a fresh optimistic create can't be dropped before its transaction lands

**Self-heal (watermark only).** Watermark eviction is involuntary, so it's reversible: evicted records are marked, and if a `@Reference` getter or a mounted React hook still needs one, the engine reloads it in the background and it reappears on the next render. The reload comes from IDB for persisted models; for `Ephemeral` models (no IDB) it goes to the server through your on-demand fetcher, so an `Ephemeral` record only self-heals when on-demand fetching is configured. Explicit `evictByIndex` / `evictWhere` are deliberate removals — they do **not** self-heal, which is what makes sync-group cleanup actually clear the data instead of reloading it.

## Schema-first with Zod

If your record shapes already live in Zod, use `entityFromZod(...)` as the schema authoring path. Zod owns the field types; `fields` overrides add zerodrift metadata such as foreign keys and indexes. `z.lazy(() => Shape)` wrappers (what codegen emits for recursive / forward-referenced schemas) are accepted and resolved, at runtime and in the inferred types.

```ts
import { z } from "zod";
import {
  createStore,
  defineSchema,
  entityFromZod,
  fields as s,
  link,
  LoadStrategy,
} from "zerodrift/schema";

const TeamRecord = z.object({
  id: z.string(),
  name: z.string(),
});

const IssueRecord = z.object({
  id: z.string(),
  title: z.string().default(""),
  priority: z.number().default(0),
  teamId: z.string().nullable(),
});

export const schema = defineSchema({
  entities: {
    team: entityFromZod(TeamRecord, {
      name: "Team",
      loadStrategy: LoadStrategy.Eager,
    }),
    issue: entityFromZod(IssueRecord, {
      name: "Issue",
      loadStrategy: LoadStrategy.Eager,
      eviction: { maxResident: 5000 },
      fields: {
        teamId: s.refId("team").nullable().indexed(),
      },
    }),
  },
  links: {
    issueTeam: link({
      from: { entity: "issue", field: "teamId", as: "team" },
      to: { entity: "team", many: "issues", lazy: true },
      onDelete: "cascade",
    }),
  },
});

const store = createStore({ schema, storeManager: sm });

const issue = await store.issue.get(issueId);
const teamIssues = await store.issue.getByIndex("teamId", teamId);

// create / patch commit at the current boundary — no separate save():
const newIssue = store.issue.create({ title: "Fix hydration", teamId });
store.issue.patch(issue.id, { priority: 1 });

// draft() is the staged path — mutate, then save() or discardUnsavedChanges():
const d = store.issue.draft({ title: "" });
d.title = "Write tests";
d.save();
```

Both authoring paths compile to the same registry, so schema entities and decorator classes can coexist. See [agent-docs/11-schema-first-authoring.md](agent-docs/11-schema-first-authoring.md) for extensions, typed subscriptions, Zod override forms, and coexistence details.

## React quick start

Wrap your app in `<SyncProvider>` once. For the decorator path, import your model file as a side effect so decorators run before bootstrap; for the schema-first path, pass `schema={schema}` and the provider registers entities before fetching.

```tsx
import { SyncProvider } from "zerodrift/react";
import { schema } from "./schema";   // schema-first
// import "./models";                  // or: decorator path — side-effect import

export default function Providers({ children }) {
  return (
    <SyncProvider
      schema={schema}
      config={{
        workspaceId: "workspace-123",
        transport: {
          bootstrapFetcher: async (type, options) => {
            const res = await fetch(
              `/api/bootstrap?type=${type}&lastSyncId=${options?.sinceSyncId ?? 0}`,
            );
            return res.json();
          },
          transactionSender: async (batch) => {
            const res = await fetch("/api/transactions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(batch),
            });
            return res.json();
          },
          syncUrl: "/api/events",
        },
      }}
      fallback={<div>Loading...</div>}
    >
      {children}
    </SyncProvider>
  );
}
```

In schema-first children, pull the typed store with `useStore<typeof schema>()` (add `typeof extensions` as the second generic if you also passed extensions):

```tsx
import { useStore } from "zerodrift/react";
import { schema } from "./schema";

const store = useStore<typeof schema>();
const { data: issue } = useRecord(store.issue, issueId);
```

Common reads and writes. The read hooks take a **handle** — a model class
(decorator path) or a `store.<entity>` namespace (schema path) — and infer
the record type from it. Every result has the same shape:
`{ data, isLoading, isLoaded, error, reload }`.

```tsx
const { data: issues } = useRecords(Issue);                 // T[]
const { data: issue } = useRecord(Issue, issueId);          // T | null
const { data: teamIssues } = useRecordsByIndex(Issue, "teamId", teamId);
const { data: comments } = useRelation(issue?.comments);    // a relation
const { phase } = useBootstrapStatus();

// Every read hook takes an optional trailing `{ pause }` — while true it reads
// the pool but holds all fetching (auto-fire and reload) until flipped false:
const { data: c } = useRecordsByIndex(store.comment, "issueId", issueId, {
  pause: !panelOpen,
});

issue.title = "New title";
issue.save();

const batch = useBatch();
batch(() => {
  issue.priority = 1;
  issue.save();
});

// Tie a mutation to its own persisting call: the staged fields commit when it
// resolves, revert when it rejects. Overlapping calls settle independently.
await store.optimistic(
  () => issue.assign({ priority: 1 }),
  () => api.setPriority(issue.id, 1),
);

// remoteUndoDepth counts tracked remote deltas (advanced.remoteUndo) on the stack
const { undo, redo, canUndo, canRedo, remoteUndoDepth } = useUndoRedo();
```

Field reads during render (`issue.title`) are reactive via MobX `observer()` —
which the React Compiler's auto-memoization silently breaks. `useWatch` is the
compiler-safe read boundary: the selection runs inside the library and comes
back as a value snapshot, so no `observer()` wrapper is needed at all:

```tsx
const { data: issue } = useRecord(store.issue, issueId);
const title = useWatch(issue, (i) => i.title);
const badge = useWatch(issue, (i) => ({ title: i.title, done: i.done }));
```

Re-renders fire when (and only when) the selected values change. See
[agent-docs/08-react-integration.md](agent-docs/08-react-integration.md#field-reads-and-the-react-compiler--usewatch)
for list and derived-sort patterns.

Schema-authored stores pass the namespace as the handle — same hooks, typed
record + `.indexed()`-constrained index keys:

```tsx
const { data: issue } = useRecord(store.issue, issueId);
const { data: teams } = useRecords(store.team);
const { data: teamIssues } = useRecordsByIndex(store.issue, "teamId", teamId);
```

See [agent-docs/08-react-integration.md](agent-docs/08-react-integration.md) for hook return shapes, context-driven id generation, Storybook seeding, and testing patterns. For the full `transport` field list (`bootstrapSyncGroups`, `modelStreams`, `sseClientFactory`, `syncTransform`, …) see [TransportConfig reference](agent-docs/07-realtime-sync.md#transportconfig-reference).

## Headless usage

The same `StoreManager` runs without React or a browser. Use `MemoryAdapter` for in-process agents and tests, or implement `StorageAdapter` for durable storage.

```ts
import EventSource from "eventsource";
import { MemoryAdapter, StoreManager } from "zerodrift";
import "./models";

const sm = new StoreManager({
  workspaceId: "agent-1",
  transport: {
    bootstrapFetcher,
    transactionSender,
    syncUrl: "http://localhost:8081/api/events",
    sseClientFactory: (url) => new EventSource(url),
  },
  persistence: { storageAdapter: new MemoryAdapter() },
});

await sm.bootstrap();
```

See [agent-docs/09-headless-and-agents.md](agent-docs/09-headless-and-agents.md) for reactivity outside React, shared vs isolated agent state, refresh APIs, and observability.

## Backend protocol

The client needs three endpoints:

| Endpoint                 | Purpose                              |
| ------------------------ | ------------------------------------ |
| `GET /api/bootstrap`     | Fetch initial or partial model data. |
| `POST /api/transactions` | Accept queued client mutations.      |
| `GET /api/events`        | Stream delta packets over SSE.       |

Bootstrap returns records grouped by model name:

```json
{
  "lastSyncId": 5205,
  "subscribedSyncGroups": ["workspace-abc"],
  "models": {
    "Issue": [{ "id": "...", "title": "...", "teamId": "..." }],
    "Team": [{ "id": "...", "name": "..." }]
  },
  "backendDatabaseVersion": 1
}
```

Transactions send inserts, updates, deletes, and archives:

```json
{
  "transactions": [
    {
      "id": "uuid",
      "action": "U",
      "modelName": "Issue",
      "modelId": "uuid",
      "changes": {
        "title": { "oldValue": "Old", "newValue": "New" }
      }
    }
  ]
}
```

The response should include the latest committed sync id:

```json
{ "success": true, "lastSyncId": 5206 }
```

SSE messages are delta packets:

```json
{
  "syncId": 5206,
  "syncActions": [
    {
      "modelName": "Issue",
      "modelId": "uuid",
      "action": "U",
      "data": { "title": "New title", "priority": 1 }
    }
  ],
  "addedSyncGroups": [],
  "removedSyncGroups": []
}
```

The client reconnects with `?lastSyncId=<id>` so the server can replay missed events. See [agent-docs/07-realtime-sync.md](agent-docs/07-realtime-sync.md) for SSE details and [agent-docs/05-sync-groups.md](agent-docs/05-sync-groups.md) for scoped event delivery.

## Run the demo

A reference Go backend + Next.js app that exercises the full sync loop
locally live in [examples/](examples/). See [examples/README.md](examples/README.md)
for the one-command-each setup:

```bash
cd examples && make start-backend && make run-webapp
```

## Documentation

Deeper material lives in [agent-docs/](agent-docs/):

- [00 - Architecture overview](agent-docs/00-overview.md)
- [01 - Models and decorators](agent-docs/01-models-and-decorators.md)
- [02 - ObjectPool](agent-docs/02-object-pool.md)
- [03 - IndexedDB and persistence](agent-docs/03-indexeddb-and-persistence.md)
- [04 - Lazy loading](agent-docs/04-lazy-loading.md)
- [05 - Sync groups](agent-docs/05-sync-groups.md)
- [06 - Transactions and undo](agent-docs/06-transactions-and-undo.md)
- [07 - Realtime sync](agent-docs/07-realtime-sync.md)
- [08 - React integration](agent-docs/08-react-integration.md)
- [09 - Headless and agents](agent-docs/09-headless-and-agents.md)
- [10 - Inverse links and reactivity](agent-docs/10-inverse-links-and-reactivity.md)
- [11 - Schema-first authoring](agent-docs/11-schema-first-authoring.md)

## Project structure

```text
.                      # the publishable zerodrift package
|-- src/
|-- agent-docs/         # architecture and API notes
`-- examples/           # self-contained runnable demo (own Makefile + compose)
    |-- webapp/         # Next.js demo app
    |-- go/             # reference Go backend
    |-- docker-compose.yml
    `-- Makefile
```

## Tech stack

- **Client**: TypeScript, MobX, IndexedDB, EventSource (SSE)
- **Reference server**: Go, Gin, Bun ORM, Postgres (LISTEN/NOTIFY), pgx
- **Protocol**: append-only changelog, monotonic sync id, sync group filtering

## Acknowledgments

zerodrift was informed by public writing and talks on local-first sync
engines. Two especially helpful references were Wenzhao Hu's "Reverse
Engineering Linear's Sync Engine: A Detailed Study"
([wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine))
and Tuomas Artman's React Helsinki talk on
[Linear's realtime sync](https://www.youtube.com/watch?v=WxK11RsLqp4).

This project is an independent TypeScript implementation and is not affiliated
with Linear.

## License

MIT — see [LICENSE](LICENSE). The MIT grant covers zerodrift's own code.
See [NOTICE](NOTICE) for inspiration and attribution notes.
