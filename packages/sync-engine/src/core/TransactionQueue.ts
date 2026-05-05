/**
 * TransactionQueue — manages transaction lifecycle and batch undo.
 *
 * Three queues:
 *   pending       → created, not yet sent
 *   executing     → sent to server, awaiting response
 *   awaitingSync  → server ACK'd, waiting for delta packet with syncId
 *
 * Batch undo:
 *   beginBatch() opens a batch. All save() calls inside share a batchId.
 *   endBatch() closes it. undo() pops the entire batch and reverts all.
 *
 * The undo stack stores "entries" — either a single tx or a batch of txs.
 */

import type { StorageAdapter } from "./Database";
import { ObjectPool } from "./ObjectPool";
import { ModelRegistry } from "./ModelRegistry";
import { toError, type EngineErrorContext } from "./types";
import {
  BaseTransaction,
  UpdateTransaction,
  CreateTransaction,
  DeleteTransaction,
  ArchiveTransaction,
  type UndoableAction,
} from "./Transaction";
import { TransactionState, type PropertyChange } from "./types";
import type { BaseModel } from "./BaseModel";

export interface BatchResponse {
  success: boolean;
  lastSyncId: number;
}

export type TransactionSender = (
  batch: ReturnType<BaseTransaction["serialize"]>[],
) => Promise<BatchResponse>;

// Shape of a serialized transaction as stored in IndexedDB cache.
interface CachedTransactionRecord {
  action: string;
  modelId: string;
  modelName: string;
  batchId?: string | null;
  changes?: Record<string, PropertyChange>;
  data?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  /** Set when the server ack'd the tx; recovery checks the SyncAction store
   * to decide whether the awaited delta already arrived. Absent → tx never
   * left the pending queue and should be resent on restart. */
  syncIdNeededForCompletion?: number;
}

type UndoItem = BaseTransaction | UndoableAction;

type UndoEntry =
  | { kind: "single"; item: UndoItem }
  | { kind: "batch"; batchId: string; entries: UndoItem[] };

export type UndoPhase = "undo" | "redo";

export interface UndoResult {
  txs: BaseTransaction[];
  actions: UndoableAction[];
}

/** Handlers the consumer supplies via `StoreManagerConfig.undoableActions`.
 *  Each handler talks to the consumer's backend change-log API and returns the
 *  compensating action so the engine can place it on the opposite stack.
 *  Returning `void` reuses the original entry — fine when the same
 *  `changeLogId` is replayable in either direction. */
export interface UndoableActionHandlers {
  undo: (action: UndoableAction) => Promise<UndoableAction | void>;
  redo?: (action: UndoableAction) => Promise<UndoableAction | void>;
}

type Listener = () => void;

const isAction = (e: UndoItem): e is UndoableAction =>
  !(e instanceof BaseTransaction);

export class TransactionQueue {
  private database: StorageAdapter;
  private pool: ObjectPool;
  private sender: TransactionSender | null = null;

  // The three queues
  private pending: BaseTransaction[] = [];
  private executing: BaseTransaction[] = [];
  private awaitingSync: BaseTransaction[] = [];

  // Undo/redo
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];

  // Active batch state. `activeBatchEntries` mixes BaseTransactions and
  // UndoableActions so a single user action that combines model edits and
  // remote API calls undoes as one unit, in reverse insertion order.
  private activeBatchId: string | null = null;
  private activeBatchEntries: (BaseTransaction | UndoableAction)[] = [];

  private actionHandlers: UndoableActionHandlers | null = null;

  // When true, enqueue() and endBatch() skip undo stack mutations.
  // Set during undo/redo so their inverse operations don't re-enter the stack.
  private suppressUndoStack = false;

  // Flush timer
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushDelay = 50; // ms — batches rapid saves
  private undoLimit: number;
  private listeners = new Set<Listener>();
  private reportError:
    | ((err: Error, context: EngineErrorContext) => void)
    | null = null;

  constructor(database: StorageAdapter, pool: ObjectPool, undoLimit = 100) {
    this.database = database;
    this.pool = pool;
    this.undoLimit = undoLimit;
  }

  setErrorReporter(
    reporter: (err: Error, context: EngineErrorContext) => void,
  ) {
    this.reportError = reporter;
  }

  setSender(sender: TransactionSender) {
    this.sender = sender;
  }

  setActionHandlers(handlers: UndoableActionHandlers) {
    this.actionHandlers = handlers;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    this.listeners.forEach((listener) => listener());
  }

  // ── Batch API ─────────────────────────────────────────────────────────────

  beginBatch(): string {
    if (this.activeBatchId != null) {
      throw new Error(
        `Nested batches are not supported. Active batch "${this.activeBatchId}" ` +
          `must end before opening another batch.`,
      );
    }
    const batchId = crypto.randomUUID();
    this.activeBatchId = batchId;
    this.activeBatchEntries = [];
    return batchId;
  }

  endBatch(batchId: string) {
    if (this.activeBatchId !== batchId) {
      return;
    }
    if (this.activeBatchEntries.length > 0 && !this.suppressUndoStack) {
      this.undoStack.push({
        kind: "batch",
        batchId,
        entries: [...this.activeBatchEntries],
      });
      if (this.undoStack.length > this.undoLimit) {
        this.undoStack.shift();
      }
      this.redoStack = [];
      this.notify();
    }
    this.activeBatchId = null;
    this.activeBatchEntries = [];
  }

  get hasActiveBatch(): boolean {
    return this.activeBatchId != null;
  }

  // ── Enqueue methods (one per transaction type) ────────────────────────────

  async enqueueUpdate(
    modelId: string,
    modelName: string,
    changes: Record<string, PropertyChange>,
  ) {
    const tx = new UpdateTransaction(modelId, modelName, changes);
    await this.enqueue(tx);
    return tx;
  }

  async enqueueCreate(
    modelId: string,
    modelName: string,
    data: Record<string, unknown>,
  ) {
    await this.enqueue(new CreateTransaction(modelId, modelName, data));
  }

  async enqueueDelete(model: BaseModel) {
    const meta = ModelRegistry.getMetaForInstance(model);
    const tx = new DeleteTransaction(
      model.id,
      meta?.name ?? "Unknown",
      model.serialize(),
    );
    if (meta != null) {
      this.pool.remove(meta.name, model.id);
    } // optimistic removal
    await this.enqueue(tx);
  }

  /** Record an already-committed remote side-effect on the undo stack. No
   *  pending/executing/awaitingSync involvement and no IDB caching — the
   *  consumer's API call already happened, so there's nothing to resend. */
  enqueueAction(action: UndoableAction) {
    if (this.activeBatchId != null) {
      this.activeBatchEntries.push(action);
      return;
    }
    if (this.suppressUndoStack) {
      return;
    }
    this.undoStack.push({ kind: "single", item: action });
    if (this.undoStack.length > this.undoLimit) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.notify();
  }

  async enqueueArchive(model: BaseModel) {
    const meta = ModelRegistry.getMetaForInstance(model);
    const tx = new ArchiveTransaction(
      model.id,
      meta?.name ?? "Unknown",
      model.serialize(),
    );
    if (meta != null) {
      this.pool.remove(meta.name, model.id);
    }
    await this.enqueue(tx);
  }

  private async enqueue(tx: BaseTransaction) {
    tx.state = TransactionState.Pending;

    // Tag with batch if one is active
    if (this.activeBatchId != null) {
      tx.batchId = this.activeBatchId;
      this.activeBatchEntries.push(tx);
    } else if (!this.suppressUndoStack) {
      this.undoStack.push({ kind: "single", item: tx });
      if (this.undoStack.length > this.undoLimit) {
        this.undoStack.shift();
      }
      this.redoStack = [];
      this.notify();
    }

    // Add to pending and schedule flush synchronously so callers can immediately
    // inspect pendingCount without waiting for the IDB cache write to complete.
    this.pending.push(tx);
    this.scheduleFlush();

    // Cache in IDB for offline resilience (async — idbKey needed only for resendCached)
    tx.idbKey = await this.database.cacheTransaction(tx.serialize());
  }

  // ── Flush — send batch to server ──────────────────────────────────────────

  private scheduleFlush() {
    if (this.flushTimer != null) {
      return;
    }
    this.flushTimer = setTimeout(() => this.flush(), this.flushDelay);
  }

  private async flush() {
    this.flushTimer = null;
    if (this.pending.length === 0 || this.sender == null) {
      return;
    }

    const batch = [...this.pending];
    this.pending = [];
    batch.forEach((tx) => (tx.state = TransactionState.Executing));
    this.executing.push(...batch);

    try {
      const response = await this.sender(batch.map((tx) => tx.serialize()));
      this.executing = this.executing.filter((tx) => !batch.includes(tx));

      const batchKeys = batch
        .map((tx) => tx.idbKey)
        .filter((k): k is number => k != null);
      if (response.success) {
        // Don't delete cached records on ACK — flag them as awaiting the
        // server's syncId. If the client crashes here, recovery checks the
        // SyncAction store; if the matching delta already arrived, the tx
        // is dropped without resending. The cached record is removed on
        // resolveBySync (when the matching SSE delta hits this tab).
        for (const tx of batch) {
          tx.markCompleted(response.lastSyncId);
          this.awaitingSync.push(tx);
          if (tx.idbKey != null) {
            const cached: CachedTransactionRecord = {
              ...(tx.serialize() as unknown as CachedTransactionRecord),
              syncIdNeededForCompletion: response.lastSyncId,
            };
            await this.database.updateCachedTransaction(tx.idbKey, cached);
          }
        }
      } else {
        // Server rejected — revert first, then remove from IDB so failed
        // transactions don't replay on next app start via resendCached()
        for (let i = batch.length - 1; i >= 0; i--) {
          batch[i].state = TransactionState.Failed;
          this.revertOne(batch[i]);
        }
        await this.database.deleteCachedTransactions(batchKeys);
      }
    } catch (err) {
      // Network error — put back in pending for retry
      this.executing = this.executing.filter((tx) => !batch.includes(tx));
      batch.forEach((tx) => (tx.state = TransactionState.Pending));
      this.pending = [...batch, ...this.pending];
      setTimeout(() => this.scheduleFlush(), 2000);
      this.reportError?.(toError(err), {
        kind: "transactionSend",
        batchSize: batch.length,
      });
    }
  }

  // ── Sync completion (called by SyncConnection on delta packet) ────────────

  resolveBySync(receivedSyncId: number): BaseTransaction[] {
    if (this.awaitingSync.length === 0) {
      return [];
    }

    const resolved: BaseTransaction[] = [];
    const remaining: BaseTransaction[] = [];

    for (const tx of this.awaitingSync) {
      if (tx.isSyncedBy(receivedSyncId)) {
        tx.state = TransactionState.Completed;
        resolved.push(tx);
      } else {
        remaining.push(tx);
      }
    }

    this.awaitingSync = remaining;

    // Drop the resolved txs' cached records — they're no longer needed for
    // crash recovery (the awaited delta is now persisted in __syncActions).
    const idbKeys = resolved
      .map((tx) => tx.idbKey)
      .filter((k): k is number => k != null);
    if (idbKeys.length > 0) {
      void this.database.deleteCachedTransactions(idbKeys);
    }

    return resolved;
  }

  // ── Rebasing (called by SyncConnection for I/U/V/C actions) ───────────────

  rebaseAll(
    modelId: string,
    modelName: string,
    serverData: Record<string, unknown>,
  ) {
    const model = this.pool.getById(modelName, modelId);
    if (model == null) {
      return;
    }

    // Check all active queues for conflicting UpdateTransactions
    const allActive = [
      ...this.pending,
      ...this.executing,
      ...this.awaitingSync,
    ];
    for (const tx of allActive) {
      if (
        tx instanceof UpdateTransaction &&
        tx.modelId === modelId &&
        tx.modelName === modelName &&
        tx.conflictsWith(serverData)
      ) {
        tx.rebase(model, serverData);
      }
    }
  }

  // ── Revert a single transaction ───────────────────────────────────────────

  private revertOne(tx: BaseTransaction) {
    if (tx instanceof UpdateTransaction) {
      const model = this.pool.getById(tx.modelName, tx.modelId);
      if (model != null) {
        tx.revert(model);
        this.pool.put(tx.modelName, model);
      }
    } else if (tx instanceof CreateTransaction) {
      this.pool.remove(tx.modelName, tx.modelId);
    } else if (
      tx instanceof DeleteTransaction ||
      tx instanceof ArchiveTransaction
    ) {
      const meta = ModelRegistry.getModelMeta(tx.modelName);
      if (meta != null) {
        const inst = new meta.ctor() as BaseModel;
        tx.revert(inst);
        this.pool.put(tx.modelName, inst);
      }
    }
  }

  // ── Undo/Redo — batch-aware, mixed tx + action entries ──────────────────

  private itemsOf(entry: UndoEntry): UndoItem[] {
    return entry.kind === "single" ? [entry.item] : entry.entries;
  }

  /** Build the inverse-stack entry from a list of replaced items. Single-item
   *  entries collapse to `single`, otherwise reuse the original `batchId`. */
  private wrapEntry(original: UndoEntry, items: UndoItem[]): UndoEntry {
    if (original.kind === "single") {
      return { kind: "single", item: items[0] };
    }
    return { kind: "batch", batchId: original.batchId, entries: items };
  }

  /** Run the consumer's action handler, surfacing failures through
   *  `reportError`. Returns the compensating action for the opposite stack —
   *  the handler's return value, or the original action on void/error. */
  private async invokeActionHandler(
    action: UndoableAction,
    phase: UndoPhase,
  ): Promise<UndoableAction> {
    const handler = this.actionHandlers?.[phase];
    if (handler == null) {
      this.reportError?.(
        new Error(`No ${phase} handler configured for undoable actions`),
        {
          kind: "undoableAction",
          phase,
          changeLogId: action.changeLogId,
          actionType: action.actionType,
        },
      );
      return action;
    }
    try {
      const result = await handler(action);
      return result ?? action;
    } catch (err) {
      this.reportError?.(toError(err), {
        kind: "undoableAction",
        phase,
        changeLogId: action.changeLogId,
        actionType: action.actionType,
      });
      return action;
    }
  }

  /** Reverse a single transaction and enqueue the inverse server call. */
  private async revertTx(tx: BaseTransaction) {
    if (tx instanceof UpdateTransaction) {
      const model = this.pool.getById(tx.modelName, tx.modelId);
      if (model == null) {
        return;
      }
      tx.revert(model);
      this.pool.put(tx.modelName, model);
      const inverse: Record<string, PropertyChange> = {};
      for (const [p, c] of tx.changes) {
        inverse[p] = { oldValue: c.newValue, newValue: c.oldValue };
      }
      await this.enqueueUpdate(tx.modelId, tx.modelName, inverse);
    } else if (tx instanceof CreateTransaction) {
      const model = this.pool.getById(tx.modelName, tx.modelId);
      if (model != null) {
        await this.enqueueDelete(model);
      }
    } else if (tx instanceof DeleteTransaction) {
      const meta = ModelRegistry.getModelMeta(tx.modelName);
      if (meta != null) {
        this.pool.hydrateAndPut(tx.modelName, meta, tx.snapshot);
        await this.enqueueCreate(tx.modelId, tx.modelName, tx.snapshot);
      }
    }
    // ArchiveTransaction has no inverse enqueue today — pass through.
  }

  /** Re-apply a single transaction and enqueue the forward server call. */
  private async replayTx(tx: BaseTransaction) {
    if (tx instanceof UpdateTransaction) {
      const model = this.pool.getById(tx.modelName, tx.modelId);
      if (model == null) {
        return;
      }
      const changes: Record<string, PropertyChange> = {};
      for (const [p, c] of tx.changes) {
        // Dynamic property assignment on BaseModel — no better type for runtime field access
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (model as any)[p] = c.newValue;
        changes[p] = { oldValue: c.oldValue, newValue: c.newValue };
      }
      this.pool.put(tx.modelName, model);
      await this.enqueueUpdate(tx.modelId, tx.modelName, changes);
    } else if (tx instanceof DeleteTransaction) {
      const model = this.pool.getById(tx.modelName, tx.modelId);
      if (model != null) {
        await this.enqueueDelete(model);
      }
    } else if (tx instanceof CreateTransaction) {
      const meta = ModelRegistry.getModelMeta(tx.modelName);
      if (meta != null) {
        this.pool.hydrateAndPut(tx.modelName, meta, tx.data);
        await this.enqueueCreate(tx.modelId, tx.modelName, tx.data);
      }
    }
  }

  /** Walk an entry's items in `direction`, applying tx reverts/replays and
   *  delegating actions to the consumer's handler. Returns the compensating
   *  items for the opposite stack, in original insertion order. */
  private async processEntry(
    entry: UndoEntry,
    direction: UndoPhase,
  ): Promise<UndoItem[]> {
    const items = this.itemsOf(entry);
    const swaps = new Map<UndoableAction, UndoableAction>();

    // suppressUndoStack prevents inverse txs (and any handler-side re-entries)
    // from polluting the active stack while we replay.
    this.suppressUndoStack = true;
    const batchId = this.beginBatch();
    try {
      const apply = direction === "undo" ? this.revertTx : this.replayTx;
      const order = direction === "undo" ? -1 : 1;
      for (
        let i = direction === "undo" ? items.length - 1 : 0;
        i >= 0 && i < items.length;
        i += order
      ) {
        const item = items[i];
        if (isAction(item)) {
          swaps.set(item, await this.invokeActionHandler(item, direction));
        } else {
          await apply.call(this, item);
        }
      }
    } finally {
      this.endBatch(batchId);
      this.suppressUndoStack = false;
    }

    return items.map((x) => (isAction(x) ? swaps.get(x) ?? x : x));
  }

  private partition(items: UndoItem[]): UndoResult {
    const txs: BaseTransaction[] = [];
    const actions: UndoableAction[] = [];
    for (const x of items) {
      if (isAction(x)) {
        actions.push(x);
      } else {
        txs.push(x);
      }
    }
    return { txs, actions };
  }

  async undo(): Promise<UndoResult | null> {
    const entry = this.undoStack.pop();
    if (entry == null) {
      return null;
    }
    const replayed = await this.processEntry(entry, "undo");
    this.redoStack.push(this.wrapEntry(entry, replayed));
    this.notify();
    return this.partition(this.itemsOf(entry));
  }

  async redo(): Promise<UndoResult | null> {
    const entry = this.redoStack.pop();
    if (entry == null) {
      return null;
    }
    const replayed = await this.processEntry(entry, "redo");
    this.undoStack.push(this.wrapEntry(entry, replayed));
    this.notify();
    return this.partition(this.itemsOf(entry));
  }

  // ── Reconnection ──────────────────────────────────────────────────────────

  async resendCached(): Promise<number> {
    const cached = await this.database.getCachedTransactions();
    if (cached.length === 0) {
      return 0;
    }

    // Build a signature set for transactions already in-flight, pending, or awaiting sync.
    // If a transaction is currently being sent (executing) or already queued (pending),
    // re-enqueueing from IDB would send a duplicate to the server.
    const inFlight = new Set<string>();
    for (const tx of [
      ...this.pending,
      ...this.executing,
      ...this.awaitingSync,
    ]) {
      inFlight.add(`${tx.action}:${tx.modelName}:${tx.modelId}`);
    }

    // Walk the cached records once. For each:
    //   - syncIdNeededForCompletion present + matching SSE delta already
    //     persisted → drop (server ack'd, delta arrived).
    //   - syncIdNeededForCompletion present + no matching delta yet →
    //     restore to awaitingSync (do NOT resend; just wait for the delta).
    //   - No syncId set → it's still pending. If the target model has been
    //     deleted/archived since the tx was queued, drop it and emit a
    //     transactionDiscarded error. Otherwise rebuild and re-enqueue.
    const dropKeys: number[] = [];
    let count = 0;
    for (const entry of cached) {
      const d = entry.data as CachedTransactionRecord;
      const idbKey = entry.idbKey;
      const inFlightKey = `${d.action}:${d.modelName}:${d.modelId}`;

      if (d.syncIdNeededForCompletion != null) {
        if (await this.database.hasSyncAction(d.syncIdNeededForCompletion)) {
          dropKeys.push(idbKey);
          continue;
        }
        if (inFlight.has(inFlightKey)) {
          dropKeys.push(idbKey);
          continue;
        }
        const tx = this.rebuildTransaction(d);
        if (tx == null) {
          dropKeys.push(idbKey);
          continue;
        }
        tx.idbKey = idbKey;
        tx.markCompleted(d.syncIdNeededForCompletion);
        this.awaitingSync.push(tx);
        continue;
      }

      if (inFlight.has(inFlightKey)) {
        dropKeys.push(idbKey);
        continue;
      }

      // Pending tx — check whether the target was deleted/archived in our absence.
      if (d.action === "U" || d.action === "D" || d.action === "A") {
        const actions = await this.database.findSyncActionsForModel(
          d.modelName,
          d.modelId,
        );
        if (actions.some((a) => a.action === "D" || a.action === "A")) {
          dropKeys.push(idbKey);
          this.reportError?.(
            new Error(
              `Discarded persisted ${d.action} for ${d.modelName} ${d.modelId}: target was deleted`,
            ),
            {
              kind: "transactionDiscarded",
              modelName: d.modelName,
              modelId: d.modelId,
              action: d.action,
              reason: "target-deleted",
            },
          );
          continue;
        }
      }

      const tx = this.rebuildTransaction(d);
      if (tx == null) {
        dropKeys.push(idbKey);
        continue;
      }
      tx.idbKey = idbKey;
      this.pending.push(tx);
      count++;
    }

    if (dropKeys.length > 0) {
      await this.database.deleteCachedTransactions(dropKeys);
    }
    if (count > 0) {
      this.scheduleFlush();
    }
    return count;
  }

  private rebuildTransaction(d: CachedTransactionRecord): BaseTransaction | null {
    let tx: BaseTransaction;
    switch (d.action) {
      case "U":
        if (d.changes == null) {
          return null;
        }
        tx = new UpdateTransaction(d.modelId, d.modelName, d.changes);
        break;
      case "I":
        if (d.data == null) {
          return null;
        }
        tx = new CreateTransaction(d.modelId, d.modelName, d.data);
        break;
      case "D":
        if (d.snapshot == null) {
          return null;
        }
        tx = new DeleteTransaction(d.modelId, d.modelName, d.snapshot);
        break;
      case "A":
        if (d.snapshot == null) {
          return null;
        }
        tx = new ArchiveTransaction(d.modelId, d.modelName, d.snapshot);
        break;
      default:
        return null;
    }
    tx.batchId = d.batchId ?? null;
    return tx;
  }

  destroy() {
    if (this.flushTimer != null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.listeners.clear();
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  get pendingCount() {
    return this.pending.length;
  }
  get executingCount() {
    return this.executing.length;
  }
  get awaitingSyncCount() {
    return this.awaitingSync.length;
  }
  get undoDepth() {
    return this.undoStack.length;
  }
  get redoDepth() {
    return this.redoStack.length;
  }
}
