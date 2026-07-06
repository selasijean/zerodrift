/**
 * SyncConnection — WebSocket for receiving delta packets from the server.
 *
 * Delta packet processing:
 *   1. Handle sync group changes (idempotent — triggers authoritative refetch)
 *   2. Apply sync actions → IndexedDB (the ONLY way model tables get updated)
 *   3. Apply sync actions → in-memory ObjectPool + rebase + cascade + invalidate
 *   4. Advance lastSyncId
 *   5. Resolve transactions waiting for this syncId
 *
 * Stale packets (syncId <= lastSyncId) skip steps 2-4: re-applying would
 * clobber any newer state already in the pool. Group changes still run.
 *
 * Cascade delete (from BackReference metadata):
 *   When a model is deleted, find all BackReferences pointing to it and
 *   remove those "owned" models too. Also handle onDelete: "cascade" on References.
 *
 * Inverse-link maintenance:
 *   The ObjectPool keeps parent RefCollections / BackRefs in sync with the
 *   pool automatically — `pool.put` attaches and `pool.remove` detaches, and
 *   `BaseModel.hydrate` dispatches FK changes for in-pool models. SyncConnection
 *   only has to mutate the pool; parent collections track changes themselves.
 */

import type { StorageAdapter } from "./Database.js";
import { ObjectPool } from "./ObjectPool.js";
import { ModelRegistry } from "./ModelRegistry.js";
import { TransactionQueue } from "./TransactionQueue.js";
import {
  LoadStrategy,
  PropertyType,
  toError,
  type ModelMeta,
} from "./types.js";
import type { RemoteChange, RemoteUndoConfig } from "./Transaction.js";
import {
  BaseSSEConnection,
  type SSEClientFactory,
  type SSEEndpoint,
  type SSEErrorReporter,
} from "./BaseSSEConnection.js";

// Re-export so existing imports from "@zerodrift/SyncConnection" keep working.
export {
  type SSEClient,
  type SSEClientFactory,
  type SSEEndpoint,
  type SSEErrorReporter,
  createBrowserSSEFactory,
} from "./BaseSSEConnection.js";

/** How many syncIds back to retain in the SyncAction store before pruning.
 * Covers short offline gaps where a persisted pending tx asks "was my
 * target deleted while I was away?" on next reconnect. */
const SYNC_ACTION_PRUNE_MARGIN = 10_000;
/** Run a prune sweep at most every Nth syncId of advancement — opening a
 * readwrite transaction per packet is wasteful when nothing matches. */
const SYNC_ACTION_PRUNE_STRIDE = 1_000;

/**
 * Encode each element then comma-join — the right shape for a list-of-
 * strings inside a URL query parameter or a stable cache key. Commas
 * inside an element become `%2C`, leaving the join-comma unambiguous.
 * Encode-after-join would silently collapse `["a,b"]` and `["a", "b"]`
 * into the same string.
 */
export function encodeCsvList(parts: ReadonlyArray<string>): string {
  return parts.map(encodeURIComponent).join(",");
}

export interface SyncAction {
  modelName: string;
  modelId: string;
  action: "I" | "U" | "D" | "A" | "V" | "C";
  data?: Record<string, unknown>;
}

export interface DeltaPacket {
  syncId: number;
  syncActions: SyncAction[];
  addedSyncGroups?: string[];
  removedSyncGroups?: string[];
}

/**
 * Callback when new sync groups are added. StoreManager uses this to
 * fetch all models scoped to the new groups from the server.
 */
export type SyncGroupChangeHandler = (
  addedGroups: string[],
  removedGroups: string[],
) => Promise<void>;

/**
 * Return null to drop the message. When not provided, raw payloads are
 * assumed to already match `DeltaPacket`.
 */
export type SyncMessageTransform = (
  raw: unknown,
) => DeltaPacket | null | undefined;

/** Optional construction args for `SyncConnection`. The four required
 * collaborators (url, database, pool, queue) stay positional. */
export interface SyncConnectionOptions {
  onPacket?: (p: DeltaPacket) => void;
  onSyncGroupsChanged?: SyncGroupChangeHandler;
  isCollectionLoaded?: (
    modelName: string,
    indexKey: string,
    value: string,
  ) => boolean;
  sseClientFactory?: SSEClientFactory;
  transform?: SyncMessageTransform;
  reportError?: SSEErrorReporter;
  isModelFullyLoaded?: (modelName: string) => boolean;
  /** Notified for every D/A action so StoreManager can tombstone deletes
   * that arrive while a `getOrLoadAll` / `fetchDeferredModels` snapshot
   * fetch is in flight. The implementation is expected to be a cheap no-op
   * when no fetch is pending. */
  recordInflightDelete?: (modelName: string, id: string) => void;
  /** When set, each incoming delta action (except own-write echoes and `"V"`
   * confirmations) is offered to this evaluator; a `true` return captures
   * the pre-delta state and records the packet on the undo stack as a
   * `RemoteUndoAction`. Wired from `advanced.remoteUndo.evaluate`. */
  remoteUndoEvaluate?: RemoteUndoConfig["evaluate"];
}

export class SyncConnection extends BaseSSEConnection {
  // Serializes packet processing to prevent interleaved async mutations.
  private packetQueue: DeltaPacket[] = [];
  private processing = false;
  /** SyncId at which we last pruned `__syncActions`. Pruning fires every
   * `SYNC_ACTION_PRUNE_STRIDE` syncIds rather than per-packet — opening a
   * readwrite transaction is wasteful when nothing matches. */
  private lastPrunedSyncId = 0;

  private onPacket?: (p: DeltaPacket) => void;
  private onSyncGroupsChanged?: SyncGroupChangeHandler;
  private isCollectionLoaded?: (
    modelName: string,
    indexKey: string,
    value: string,
  ) => boolean;
  private transform?: SyncMessageTransform;
  /** True when the adopter called `getOrLoadAll(modelName, ...)` (any
   * scope) since the last bootstrap. SSE inserts for fully-loaded models
   * always land in the pool — bypassing the per-FK `isCollectionLoaded`
   * gate, which doesn't see `getOrLoadAll`'s sentinel coverage. */
  private isModelFullyLoaded?: (modelName: string) => boolean;
  private recordInflightDelete?: (modelName: string, id: string) => void;
  private remoteUndoEvaluate?: RemoteUndoConfig["evaluate"];
  private reportEngineError?: SSEErrorReporter;

  constructor(
    url: SSEEndpoint,
    private database: StorageAdapter,
    private pool: ObjectPool,
    private queue: TransactionQueue,
    opts: SyncConnectionOptions = {},
  ) {
    super(url, opts.sseClientFactory, opts.reportError);
    this.onPacket = opts.onPacket;
    this.onSyncGroupsChanged = opts.onSyncGroupsChanged;
    this.isCollectionLoaded = opts.isCollectionLoaded;
    this.transform = opts.transform;
    this.isModelFullyLoaded = opts.isModelFullyLoaded;
    this.recordInflightDelete = opts.recordInflightDelete;
    this.remoteUndoEvaluate = opts.remoteUndoEvaluate;
    this.reportEngineError = opts.reportError;
  }

  protected buildUrl(): string {
    const meta = this.database.currentMeta;
    const lastSyncId = meta?.lastSyncId ?? 0;
    const syncGroups = encodeCsvList(meta?.subscribedSyncGroups ?? []);
    // Sort the union — equivalent sets must produce identical URLs so the
    // engine doesn't churn reconnects when iteration order shifts.
    const subscribed = [
      ...new Set([
        ...ModelRegistry.alwaysSubscribedModelNames(),
        ...this.database.loadedModels,
      ]),
    ].sort();
    const onlyModels =
      subscribed.length > 0 ? `&onlyModels=${encodeCsvList(subscribed)}` : "";
    const base = this.resolveUrl();
    // Thunk endpoints often already carry query params (tenant, cursor, …);
    // pick `&` when the base is already in query-string mode.
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}lastSyncId=${lastSyncId}&syncGroups=${syncGroups}${onlyModels}`;
  }

  protected onMessage(data: string): void {
    const raw = JSON.parse(data);
    const packet =
      this.transform != null ? this.transform(raw) : (raw as DeltaPacket);
    if (packet == null) {
      return;
    }
    this.enqueuePacket(packet);
  }

  protected onReconnect(): void {
    // Fire-and-forget: resend is best-effort and self-heals on the next
    // reconnect (the cache is durable), so a rejection here — typically the
    // teardown/closing-DB race — must not become an unhandledRejection.
    // resendCached() already reports its own domain failures via the queue's
    // error reporter; this catch only absorbs the unexpected throw.
    void this.queue.resendCached().catch(() => {});
  }

  // =========================================================================
  // Sequential packet processing
  // =========================================================================

  /** Queue a packet and drain sequentially. */
  private async enqueuePacket(packet: DeltaPacket) {
    this.packetQueue.push(packet);
    if (this.processing) {
      return;
    } // already draining
    this.processing = true;
    while (this.packetQueue.length > 0) {
      const next = this.packetQueue.shift()!;
      await this.processDeltaPacket(next);
    }
    this.processing = false;
  }

  // =========================================================================
  // 7-step delta packet processing
  // =========================================================================

  private async processDeltaPacket(packet: DeltaPacket) {
    const meta = this.database.currentMeta;
    if (meta == null) {
      return;
    }

    // Step 1: sync group changes → trigger scoped loading
    let groupsChanged = false;
    if (
      (packet.addedSyncGroups?.length ?? 0) > 0 ||
      (packet.removedSyncGroups?.length ?? 0) > 0
    ) {
      groupsChanged = true;
      const groups = new Set(meta.subscribedSyncGroups);
      for (const g of packet.addedSyncGroups ?? []) {
        groups.add(g);
      }
      for (const g of packet.removedSyncGroups ?? []) {
        groups.delete(g);
      }
      meta.subscribedSyncGroups = [...groups];

      // Fetch models scoped to the new sync groups.
      // e.g. user joined a new team → fetch all Issues/Comments for that team.
      if (this.onSyncGroupsChanged != null) {
        await this.onSyncGroupsChanged(
          packet.addedSyncGroups ?? [],
          packet.removedSyncGroups ?? [],
        );
      }
    }

    // Stale packets (syncId <= lastSyncId): these actions would clobber newer pool state.
    const advanced = packet.syncId > meta.lastSyncId;
    if (advanced) {
      // Step 1b: remote-undo capture. Must run before the IDB writes below —
      // the pre-delta state (the undo baseline) is only readable until then.
      // Own round-trips (write echoes, undo compensations) are excluded.
      if (
        this.remoteUndoEvaluate != null &&
        !this.queue.isOwnSyncId(packet.syncId)
      ) {
        const capturedActions = await this.captureRemoteUndo(packet);

        // Step 1c: supersession rebase. Foreign UNTRACKED edits will never
        // be unwound through the undo stack, so any tracked entry field they
        // overwrite must stop reverting locally. Captured actions are
        // exempt — LIFO undo keeps their chains coherent — and own packets
        // never reach this branch.
        for (const action of packet.syncActions) {
          if (
            action.action === "V" ||
            action.data == null ||
            capturedActions.has(action)
          ) {
            continue;
          }
          this.queue.rebaseRemoteEntries(
            action.modelName,
            action.modelId,
            action.data,
          );
        }
      }

      // Step 2: apply to IndexedDB (server is SSOT — IDB mirrors it)
      for (const action of packet.syncActions) {
        const actionMeta = ModelRegistry.getModelMeta(action.modelName);
        if (actionMeta?.loadStrategy === LoadStrategy.Ephemeral) {
          continue;
        }
        if (
          ["I", "U", "V", "C"].includes(action.action) &&
          action.data != null
        ) {
          await this.database.writeModels(action.modelName, [
            { id: action.modelId, ...action.data },
          ]);
        } else if (action.action === "D" || action.action === "A") {
          await this.database.deleteModel(action.modelName, action.modelId);
        }
      }

      // Step 2b: persist sync-action headers for crash recovery — lets the
      // queue (a) recognize an ack-syncId already arrived, (b) detect that
      // a pending tx's target was deleted before flush. All actions in a
      // packet share `packet.syncId`.
      await this.database.recordSyncActions(
        packet.syncActions.map((a) => ({
          syncId: packet.syncId,
          modelName: a.modelName,
          modelId: a.modelId,
          action: a.action,
        })),
      );

      // Step 3: apply to in-memory + rebase + cascade. Each action may need to
      // read from IDB to decide whether to hydrate a not-yet-pooled model
      // whose update brings it into a loaded scope, so this is async.
      for (const action of packet.syncActions) {
        await this.applySyncAction(action);
      }

      // Step 4: advance lastSyncId
      meta.lastSyncId = packet.syncId;
    }

    if (advanced || groupsChanged) {
      await this.database.saveMeta(meta);
    }

    // Step 5: resolve transactions
    this.queue.resolveBySync(packet.syncId);

    // Step 6: prune the SyncAction store. Recovery only needs recent
    // history — anything well below `lastSyncId` is safe to drop. The
    // 10k-syncId margin covers short offline gaps where a persisted-but-
    // unsent tx checks the log for a delete of its target. We prune every
    // ~1000 syncIds rather than per-packet to avoid opening a readwrite
    // transaction when nothing matches.
    if (
      packet.syncId > SYNC_ACTION_PRUNE_MARGIN &&
      packet.syncId - this.lastPrunedSyncId >= SYNC_ACTION_PRUNE_STRIDE
    ) {
      this.lastPrunedSyncId = packet.syncId;
      void this.database.pruneSyncActionsBelow(
        packet.syncId - SYNC_ACTION_PRUNE_MARGIN,
      );
    }

    this.onPacket?.(packet);
  }

  // =========================================================================
  // Remote-undo capture (before the packet is applied anywhere)
  // =========================================================================

  /** Offer each action to the consumer's evaluator and capture the inverse
   *  of every accepted one. All captures from one packet form a single
   *  atomic undo entry keyed by the packet's syncId. Captures are pure
   *  pre-state reads, so they run concurrently; Promise.all keeps the
   *  captured order aligned with the packet's action order.
   *
   *  Best-effort: a failure here (e.g. an IDB read rejecting mid-teardown)
   *  is reported and swallowed — it must never abort delta application or
   *  stall the sequential packet queue.
   *
   *  Returns the actions that produced a capture so the caller's
   *  supersession pass can exempt them. */
  private async captureRemoteUndo(
    packet: DeltaPacket,
  ): Promise<Set<SyncAction>> {
    const capturedActions = new Set<SyncAction>();
    try {
      const results = await Promise.all(
        packet.syncActions.map((action) =>
          // "V" confirms this client's own optimistic write — never remote.
          action.action === "V"
            ? null
            : this.captureRemoteChange(packet.syncId, action),
        ),
      );
      const captured: RemoteChange[] = [];
      results.forEach((change, i) => {
        if (change != null) {
          captured.push(change);
          capturedActions.add(packet.syncActions[i]);
        }
      });
      if (captured.length > 0) {
        this.queue.recordRemoteEntry({
          source: "remote",
          id: crypto.randomUUID(),
          syncId: packet.syncId,
          changes: captured,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      this.reportEngineError?.(toError(err), {
        kind: "remoteUndo",
        phase: "evaluate",
        syncId: packet.syncId,
      });
    }
    return capturedActions;
  }

  private async captureRemoteChange(
    syncId: number,
    action: SyncAction,
  ): Promise<RemoteChange | null> {
    if (ModelRegistry.getModelMeta(action.modelName) == null) {
      return null;
    }
    const { modelName, modelId } = action;
    const pooled = this.pool.getById(modelName, modelId);
    let previous: Record<string, unknown> | null = null;
    const previousData = () => {
      previous ??= pooled?.serialize() ?? null;
      return previous;
    };

    let tracked: boolean;
    try {
      tracked = this.remoteUndoEvaluate!({
        syncId,
        action: action.action as "I" | "U" | "D" | "A" | "C",
        modelName,
        modelId,
        data: action.data,
        previousData,
      });
    } catch (err) {
      this.reportEngineError?.(toError(err), {
        kind: "remoteUndo",
        phase: "evaluate",
        syncId,
      });
      return null;
    }
    if (!tracked) {
      return null;
    }

    // Baseline: the pooled instance, else the not-yet-overwritten IDB record.
    previousData();
    if (previous == null) {
      previous = await this.database.readModel(modelName, modelId);
    }

    if (action.action === "D" || action.action === "A") {
      // Nothing local to restore → nothing locally undoable.
      return previous == null
        ? null
        : { action: action.action, modelName, modelId, snapshot: previous };
    }

    if (action.data == null) {
      return null;
    }
    if (previous == null && action.action === "I") {
      return {
        action: "I",
        modelName,
        modelId,
        data: { id: modelId, ...action.data },
      };
    }
    // "U"/"C" — and "I" onto an existing record, which applies as a merge.
    // Capture only the fields the delta actually moves.
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(action.data)) {
      if (key === "id") {
        continue;
      }
      const prior = previous?.[key];
      if (!Object.is(prior, value)) {
        before[key] = prior;
        after[key] = value;
      }
    }
    if (Object.keys(after).length === 0) {
      return null;
    }
    return { action: "U", modelName, modelId, before, after };
  }

  // =========================================================================
  // Apply a single sync action to the in-memory ObjectPool
  // =========================================================================

  private async applySyncAction(action: SyncAction) {
    const modelMeta = ModelRegistry.getModelMeta(action.modelName);
    if (modelMeta == null) {
      return;
    }

    switch (action.action) {
      case "I": {
        if (action.data == null) {
          break;
        }
        const existing = this.pool.getById(action.modelName, action.modelId);
        if (existing != null) {
          existing.hydrate(action.data);
          this.pool.put(action.modelName, existing);
        } else if (this.shouldHydrateInsert(modelMeta, action.data)) {
          this.pool.hydrateAndPut(action.modelName, modelMeta, {
            id: action.modelId,
            ...action.data,
          });
        }
        this.queue.rebaseAll(action.modelId, action.modelName, action.data);
        break;
      }

      case "U":
      case "V":
      case "C": {
        if (action.data == null) {
          break;
        }
        const model = this.pool.getById(action.modelName, action.modelId);
        if (model != null) {
          model.hydrate(action.data);
          this.pool.put(action.modelName, model);
        } else if (modelMeta.loadStrategy !== LoadStrategy.Ephemeral) {
          // Dependents loader: the model isn't in the pool, but the update
          // may have moved it into a scope we already track. Step 2 wrote the
          // merged record to IDB; read it back and let `shouldHydrateInsert`
          // decide whether to hydrate based on the post-update FK values.
          // (Ephemeral models skip IDB entirely in step 2, so there's never
          // anything to read.)
          const idbRecord = await this.database.readModel(
            action.modelName,
            action.modelId,
          );
          if (
            idbRecord != null &&
            this.shouldHydrateInsert(modelMeta, idbRecord)
          ) {
            this.pool.hydrateAndPut(action.modelName, modelMeta, idbRecord);
          }
        }
        this.queue.rebaseAll(action.modelId, action.modelName, action.data);
        break;
      }

      case "D":
      case "A": {
        // Tombstone the id so any in-flight `getOrLoadAll` /
        // `fetchDeferredModels` snapshot fetch drops a stale resurrection
        // when its older snapshot still includes the now-deleted record.
        this.recordInflightDelete?.(action.modelName, action.modelId);
        // Cascade delete: remove BackReference-owned models
        this.cascadeDelete(action.modelName, action.modelId);
        // Pool.remove detaches the model from any parent RefCollections / BackRefs
        this.pool.remove(action.modelName, action.modelId);
        break;
      }
    }
  }

  // =========================================================================
  // On-demand hydration guard
  //
  // For non-Eager models, SSE inserts should only enter the pool if the
  // relevant collection has already been loaded this session. Otherwise the
  // insert is written to IDB (step 4) and will be picked up the next time
  // getOrLoadCollection is called for that parent.
  // =========================================================================

  private shouldHydrateInsert(
    modelMeta: ModelMeta,
    data: Record<string, unknown>,
  ): boolean {
    // No checker registered → behave as before (hydrate everything)
    if (this.isCollectionLoaded == null) {
      return true;
    }

    // Eager models always go into the pool — they were bootstrapped in full
    if (modelMeta.loadStrategy === LoadStrategy.Eager) {
      return true;
    }

    // `getOrLoadAll` recorded "we want every instance of this model" via a
    // sentinel coverage entry. SSE inserts must land in the pool too,
    // otherwise observers reading via `useRecords(Model)` miss the row
    // until the next explicit `getOrLoadAll` call refreshes from IDB.
    if (this.isModelFullyLoaded?.(modelMeta.name) === true) {
      return true;
    }

    // For on-demand models, hydrate only if the parent collection has been loaded
    for (const [propName, propMeta] of modelMeta.properties) {
      if (
        propMeta.type !== PropertyType.Reference ||
        propMeta.referenceTo == null
      ) {
        continue;
      }
      const parentId = data[propName] as string | undefined;
      if (
        parentId != null &&
        this.isCollectionLoaded(modelMeta.name, propName, parentId)
      ) {
        return true;
      }
    }
    return false;
  }

  // =========================================================================
  // Cascade delete
  //
  // Walk all registered models. For each BackReference that points to the
  // deleted model's type, remove instances where the inverse key matches.
  // Also cascade for References with onDelete: "cascade".
  // =========================================================================

  private cascadeDelete(deletedModelName: string, deletedModelId: string) {
    for (const meta of ModelRegistry.allModels()) {
      for (const [, propMeta] of meta.properties) {
        // BackReference cascade: "owned by" the deleted model
        if (
          propMeta.type === PropertyType.BackReference &&
          propMeta.referenceTo === deletedModelName
        ) {
          const inverseKey = propMeta.inverseOf!;
          const toDelete = this.pool
            .getAll(meta.name)
            .filter(
              (m) =>
                (m as unknown as Record<string, unknown>)[inverseKey] ===
                deletedModelId,
            );
          for (const m of toDelete) {
            this.pool.remove(meta.name, m.id);
          }
          if (meta.loadStrategy !== LoadStrategy.Ephemeral) {
            this.database.deleteModels(
              meta.name,
              toDelete.map((m) => m.id),
            ); // fire and forget
          }
        }

        // Reference with onDelete: "cascade"
        if (
          propMeta.type === PropertyType.Reference &&
          propMeta.referenceTo === deletedModelName &&
          propMeta.onDelete === "cascade"
        ) {
          const toDelete = this.pool
            .getAll(meta.name)
            .filter(
              (m) =>
                (m as unknown as Record<string, unknown>)[propMeta.name] ===
                deletedModelId,
            );
          for (const m of toDelete) {
            this.pool.remove(meta.name, m.id);
          }
          if (meta.loadStrategy !== LoadStrategy.Ephemeral) {
            this.database.deleteModels(
              meta.name,
              toDelete.map((m) => m.id),
            ); // fire and forget
          }
        }
      }
    }
  }
}
