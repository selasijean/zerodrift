# sync-engine

A TypeScript local-first sync engine. Reads are synchronous from an in-memory pool, writes are optimistic, state stays current across tabs and clients via SSE, and everything persists locally so the app survives reloads and works offline. The same engine runs in Node so agents and background workers can hold a live model just like a browser tab.

You bring the backend. The client speaks a small three-endpoint protocol that can be implemented in any language. A reference Go backend and Next.js demo live in this repo so you can run the whole loop locally.

## What you get

- **Local-first reads**: every read hits an in-memory `ObjectPool` first.
- **Optimistic writes**: model changes update the UI immediately, then reconcile with server deltas.
- **Realtime sync**: tabs and clients stay current over SSE, without polling.
- **Offline persistence**: IndexedDB stores models and queued transactions in the browser.
- **Two authoring paths**: decorator classes or schema-as-data via `defineSchema(...)`.
- **React and headless runtimes**: use hooks in React, or run `StoreManager` directly in Node, CLIs, and agents.
- **Bring your own backend**: implement bootstrap, transaction, and SSE endpoints in the stack you already use.

## Install

```bash
npm install sync-engine
```

Optional packages depend on the surface you use:

```bash
npm install zod         # for entityFromZod(...) schema authoring
npm install eventsource # for Node/headless SSE clients
```

If you use decorators, import `reflect-metadata` once before model classes are loaded.

## Import paths

| Import | Use it for |
|---|---|
| `sync-engine` | `StoreManager`, `BaseModel`, decorators, `ObjectPool`, storage adapters, and core types. |
| `sync-engine/schema` | `defineSchema`, `entityFromZod`, field builders, links, extensions, and typed `store.<entity>.*` APIs. |
| `sync-engine/react` | `<SyncProvider>` and React hooks: `useRecord`, `useRecords`, `useRecordsByIndex`, `useRelation`, `useBatch`, `useUndoRedo`. |

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
} from "sync-engine";
import type { RefCollection } from "sync-engine";

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

`@Property` fields are persisted and observable. `@Reference`, `@ReferenceCollection`, `@OwnedCollection`, and `@BackReference` describe relationships; `Lazy*` variants load on demand. `loadStrategy` controls whether a model loads during bootstrap or only when requested. Pass an explicit `@ClientModel({ name })` — it's the registry key and the `useRecord(Model, …)` handle; without it the class name is used, which minifiers mangle in production.

See [agent-docs/01-models-and-decorators.md](agent-docs/01-models-and-decorators.md) for the full decorator reference.

## Schema-first with Zod

If your record shapes already live in Zod, use `entityFromZod(...)` as the schema authoring path. Zod owns the field types; `fields` overrides add sync-engine metadata such as foreign keys and indexes.

```ts
import { z } from "zod";
import {
  createStore,
  defineSchema,
  entityFromZod,
  fields as s,
  link,
  LoadStrategy,
} from "sync-engine/schema";

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

Wrap your app in `<SyncProvider>` once. Import your model file as a side effect so decorators run before bootstrap.

```tsx
import "reflect-metadata";
import { SyncProvider } from "sync-engine/react";
import "./models";

export default function Providers({ children }) {
  return (
    <SyncProvider
      config={{
        workspaceId: "workspace-123",
        transport: {
          bootstrapFetcher: async (type, options) => {
            const since = options?.sinceSyncId ?? 0;
            const res = await fetch(`/api/bootstrap?type=${type}&since=${since}`);
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

issue.title = "New title";
issue.save();

const batch = useBatch();
batch(() => {
  issue.priority = 1;
  issue.save();
});

const { undo, redo, canUndo, canRedo } = useUndoRedo();
```

Schema-authored stores pass the namespace as the handle — same hooks, typed
record + `.indexed()`-constrained index keys:

```tsx
const { data: issue } = useRecord(store.issue, issueId);
const { data: teams } = useRecords(store.team);
const { data: teamIssues } = useRecordsByIndex(store.issue, "teamId", teamId);
```

See [agent-docs/08-react-integration.md](agent-docs/08-react-integration.md) for hook return shapes, context-driven id generation, Storybook seeding, and testing patterns.

## Headless usage

The same `StoreManager` runs without React or a browser. Use `MemoryAdapter` for in-process agents and tests, or implement `StorageAdapter` for durable storage.

```ts
import "reflect-metadata";
import EventSource from "eventsource";
import { MemoryAdapter, StoreManager } from "sync-engine";
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

| Endpoint | Purpose |
|---|---|
| `GET /api/bootstrap` | Fetch initial or partial model data. |
| `POST /api/transactions` | Accept queued client mutations. |
| `GET /api/events` | Stream delta packets over SSE. |

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
  "syncActions": [
    {
      "id": 5206,
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

The client reconnects with `?since=<lastSyncId>` so the server can replay missed events. See [agent-docs/07-realtime-sync.md](agent-docs/07-realtime-sync.md) for SSE details and [agent-docs/05-sync-groups.md](agent-docs/05-sync-groups.md) for scoped event delivery.

## Run the demo

This repo includes a Go backend (`go/`) and a Next.js demo app (`webapp/`).

Prerequisites: Docker, Go 1.22+, Node 18+, and Make.

```bash
make go-tidy
make start-backend
make install-webapp
make run-webapp
```

Open [http://localhost:3000](http://localhost:3000) in two tabs to see sync in action.

Useful commands:

```bash
make ps
make logs
make stop-backend
make clean
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
.
|-- packages/sync-engine/  # publishable TypeScript library
|-- webapp/                # Next.js demo app
|-- go/                    # reference Go backend
|-- agent-docs/            # architecture and API notes
|-- docker-compose.yml
`-- Makefile
```

## Tech stack

- **Client**: TypeScript, MobX, IndexedDB, EventSource (SSE)
- **Reference server**: Go, Gin, Bun ORM, Postgres (LISTEN/NOTIFY), pgx
- **Protocol**: append-only changelog, monotonic sync id, sync group filtering
