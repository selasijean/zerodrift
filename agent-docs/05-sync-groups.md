# Sync Groups

Sync groups are the mechanism by which the server controls what data a client receives. Instead of every client receiving every change in the entire database, the server organizes changes into named groups and each client subscribes to only the groups it needs.

## The Mental Model

Think of sync groups as **channels** on a pub/sub system, but for bulk data, not just events.

A sync group is just a string identifier — `"team-eng"`, `"team-product"`, `"workspace-123"`. The server decides which models belong to which sync groups. The client tells the server which groups it's subscribed to. The server only sends data for those groups.

```
Server
  ├── "team-eng"     → Issues, Comments, Members for the Eng team
  ├── "team-product" → Issues, Comments, Members for the Product team
  ├── "team-design"  → Issues, Comments, Members for the Design team
  └── "workspace-123"→ Top-level workspace data (Teams, Users, Settings)

Client subscribed to: ["workspace-123", "team-eng", "team-product"]
  → Receives data for those three groups only
  → Never receives Team Design's issues
```

## Where They're Stored

The client's current set of subscribed sync groups is stored in IndexedDB in the `__meta` record (`DatabaseMeta.subscribedSyncGroups: string[]`). This is persisted so that on partial bootstrap, the SSE connection can reconnect with the right groups without a server round-trip.

## How They're Established

When the client does a **full bootstrap** (first visit or cleared cache), the server's response includes:

```typescript
interface BootstrapResponse {
  lastSyncId: number;
  subscribedSyncGroups: string[];  // ["workspace-123", "team-eng", "team-product"]
  models: { ... };
}
```

The server is authoritative. It decides what groups the client should be in based on the user's permissions. The client stores this list and uses it as the SSE subscription parameter.

### Pre-bootstrap seeding via `bootstrapSyncGroups`

If the client already knows the user's groups before the first fetch (auth provider, session API), pass `bootstrapSyncGroups: () => Promise<string[]>` in `StoreManagerConfig`. It fires after `ConnectingDatabase` but before `DeterminingBootstrapType`. The returned set is append-only unioned with `dbMeta.subscribedSyncGroups` (so a stale persisted set never shrinks the live one) and surfaces as the `syncGroups` parameter on every bootstrap-style fetch:

- Phase 1 / single-phase `fullBootstrap`
- Phase 2 `fetchDeferredModels`
- `fetchNewlyAddedModels` (registry-grew-after-last-connect path)
- `partialBootstrap`
- `getOrLoadAll(name, { syncGroups: ... })` — explicit scope still wins; falls back to the canonical set when the caller passes none

This makes the client self-describing: the server doesn't have to infer scope from auth/session and can be stateless. Hook failure is fatal — bootstrap cannot safely proceed without scope. Return `[]` (or omit the hook) if the server is the source of truth.

The hook does **not** call `saveMeta` directly — that would coerce a fresh bootstrap into the `Local` path by giving the adapter a meta with `lastSyncId: 0`. Instead, the seeded set is held in memory and folded into the `subscribedSyncGroups` written by Phase 1's existing `saveMeta`.

## How the SSE Connection Uses Them

The `SyncConnection` builds the EventSource URL with the current sync groups:

```
GET /sync/stream?lastSyncId=42&syncGroups=workspace-123,team-eng,team-product
```

The server streams only delta packets for those groups. Two clients subscribed to different groups see different streams, even from the same server.

On **reconnect** (tab backgrounded and restored, network interruption), the engine re-reads `lastSyncId` and `subscribedSyncGroups` from `__meta` and opens a new EventSource with the current values. The server catch-up (all deltas since `lastSyncId`) respects the subscription too — you don't get catch-up data for groups you're not subscribed to.

## Adding and Removing Sync Groups

The server can **push** sync group changes to the client via the delta packet:

```typescript
interface DeltaPacket {
  syncId: number;
  syncActions: SyncAction[];
  addedSyncGroups?: string[];    // ["team-design"] — user just joined this team
  removedSyncGroups?: string[];  // ["team-eng"] — user left or was removed
}
```

### When groups are added

`SyncConnection` handles this in `processDeltaPacket`:

1. Add the new groups to `meta.subscribedSyncGroups` in `__meta`
2. Call `onSyncGroupsChanged(added, removed)` → routes to `StoreManager`
3. `StoreManager.handleSyncGroupsAdded` fetches all models for those new groups from the server
4. Hydrates them into the pool and IDB

After this, the client has a complete local copy of the new group's data, and future deltas for it will be received (because `__meta` now includes the group, and reconnects use the updated list).

### When groups are removed

1. Remove from `meta.subscribedSyncGroups`
2. `fireOnSyncGroupDelete` runs auto-eviction for models with a `syncGroupKey` matching the removed group. The eviction loop respects the safety predicate — records with unsaved changes, in-flight transactions, or active observation refcounts (rendered by React hooks) are skipped.
3. The adopter's `onSyncGroupDelete` callback (if configured) fires after auto-eviction, receiving the group ID and StoreManager.
4. Components displaying evicted data will see their models disappear. The React hook self-heal path detects eviction (vs server-side deletion) and calls `reload()` to restore records from IDB if `keepInDb` was true.

**`keepInDb` defaults depend on the source.** User-initiated `deactivateSyncGroup` defaults to `keepInDb: true` (IDB rows stay for fast rehydration if the user re-subscribes). Server-pushed `removedSyncGroups` defaults to `keepInDb: false` (the user lost access, so the data should be purged). Both defaults can be overridden via `EvictionConfig.keepInDb` and `EvictionConfig.keepInDbOnServerRemoval`.

This is the client-side equivalent of a permission revocation. If a user is removed from a team, the server pushes a `removedSyncGroups: ["team-eng"]` packet and the client cleanly purges that team's data.

## Why This Design

### Scales with team/workspace size

Without sync groups, a user would receive SSE deltas for the entire database — every issue, every comment, every reaction from every team. For large organizations, this is untenable. Sync groups let the server send a client only what's relevant to them.

### Permission enforcement at the data layer

The server controls group membership. A user can't subscribe to `"team-design"` by modifying their local request — the server won't include it in the bootstrap response, and won't stream deltas for it. Permissions are enforced where they belong: on the server.

### Enables incremental onboarding

When a user joins a new team mid-session, the server sends `addedSyncGroups: ["team-design"]` in the next delta packet. The client fetches and hydrates that team's data in the background without a page refresh. The UI just starts showing the new team's issues.

### Simplifies the client

The client doesn't need to know about permission logic, team membership, or workspace topology. It just subscribes to whatever the server says it should, and the server handles all the routing.

## Sync Groups vs Model Types

It's worth being clear: sync groups are **not** the same as model types. A sync group contains instances of multiple model types. `"team-eng"` might include Issues, Comments, Reactions, Attachments — all for that team.

Model types are a schema-level concept (what shape data has). Sync groups are a data-routing concept (which subset of data a client receives). They're orthogonal.

## What the Client Never Sees

Data from sync groups the client isn't subscribed to:
- Never enters IDB
- Never enters the ObjectPool
- Never exists in the JavaScript heap

This is the key memory benefit: the client's data footprint is bounded by the sync groups it's subscribed to, not by the total size of the server database.
