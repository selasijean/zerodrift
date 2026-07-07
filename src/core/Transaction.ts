/**
 * Transaction types with batchId for multi-model grouped undo and rebase support.
 *
 * batchId groups transactions from one user action (e.g. moveIssueToTeam
 * updates Issue.teamId AND Team.issueCount). undo() reverts the entire batch.
 *
 * Rebasing (UpdateTransaction): when a delta packet conflicts with our local
 * change, the server value becomes our new baseline and our value is re-applied.
 */

import type { BaseModel } from "./BaseModel.js";
import { TransactionState, type PropertyChange } from "./types.js";

export abstract class BaseTransaction {
  readonly id = crypto.randomUUID();
  readonly modelId: string;
  readonly modelName: string;
  readonly timestamp = Date.now();
  abstract readonly action: "I" | "U" | "D" | "A";

  state = TransactionState.Pending;
  batchId: string | null = null;
  syncIdNeededForCompletion: number | null = null;
  idbKey: number | null = null;

  constructor(modelId: string, modelName: string) {
    this.modelId = modelId;
    this.modelName = modelName;
  }

  markCompleted(syncId: number) {
    this.syncIdNeededForCompletion = syncId;
    this.state = TransactionState.CompletedButUnsynced;
  }

  isSyncedBy(syncId: number): boolean {
    return (
      this.syncIdNeededForCompletion !== null &&
      syncId >= this.syncIdNeededForCompletion
    );
  }

  abstract revert(model: BaseModel): void;
  abstract serialize(): Record<string, unknown>;
}

export class UpdateTransaction extends BaseTransaction {
  readonly action = "U" as const;
  readonly changes: Map<string, PropertyChange>;

  constructor(
    modelId: string,
    modelName: string,
    changes: Record<string, PropertyChange>,
  ) {
    super(modelId, modelName);
    this.changes = new Map(Object.entries(changes));
  }

  revert(model: BaseModel) {
    for (const [prop, { oldValue }] of this.changes) {
      model.setQuiet(prop, oldValue);
    }
  }

  /**
   * Last-writer-wins rebase: update baseline to server value, re-apply ours.
   * Only rebases fields where the server value differs from our intended newValue —
   * an echo of our own change (serverValue === newValue) must not overwrite oldValue,
   * as that would corrupt the undo baseline.
   */
  rebase(model: BaseModel, serverData: Record<string, unknown>) {
    for (const [prop, serverValue] of Object.entries(serverData)) {
      const change = this.changes.get(prop);
      if (change != null && serverValue !== change.newValue) {
        change.oldValue = serverValue;
        // Dynamic property assignment on BaseModel — no better type for runtime field access
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (model as any)[prop] = change.newValue;
      }
    }
  }

  /** Returns true only when the server data has a field we're changing AND the
   *  server's value differs from our intended newValue (i.e. a real conflict,
   *  not just an echo of our own change). */
  conflictsWith(data: Record<string, unknown>): boolean {
    for (const [k, serverValue] of Object.entries(data)) {
      const change = this.changes.get(k);
      if (change != null && serverValue !== change.newValue) {
        return true;
      }
    }
    return false;
  }

  serialize() {
    return {
      id: this.id,
      action: this.action,
      batchId: this.batchId,
      modelId: this.modelId,
      modelName: this.modelName,
      timestamp: this.timestamp,
      changes: Object.fromEntries([...this.changes.entries()]),
    };
  }
}

export class CreateTransaction extends BaseTransaction {
  readonly action = "I" as const;
  readonly data: Record<string, unknown>;
  constructor(
    modelId: string,
    modelName: string,
    data: Record<string, unknown>,
  ) {
    super(modelId, modelName);
    this.data = data;
  }
  revert() {
    /* pool removal handled by queue */
  }
  serialize() {
    return {
      id: this.id,
      action: this.action,
      batchId: this.batchId,
      modelId: this.modelId,
      modelName: this.modelName,
      timestamp: this.timestamp,
      data: this.data,
    };
  }
}

export class DeleteTransaction extends BaseTransaction {
  readonly action = "D" as const;
  readonly snapshot: Record<string, unknown>;
  constructor(
    modelId: string,
    modelName: string,
    snapshot: Record<string, unknown>,
  ) {
    super(modelId, modelName);
    this.snapshot = snapshot;
  }
  revert(model: BaseModel) {
    model.hydrate(this.snapshot);
    model.makeModelObservable();
  }
  serialize() {
    return {
      id: this.id,
      action: this.action,
      batchId: this.batchId,
      modelId: this.modelId,
      modelName: this.modelName,
      timestamp: this.timestamp,
      snapshot: this.snapshot,
    };
  }
}

/**
 * A side-effect that's already been committed via a non-model API call (e.g. a
 * server bulk-mutation endpoint that returns a `changeLogId`). Lives on the
 * undo stack alongside `BaseTransaction`s so user actions that mix model edits
 * and remote calls can be undone atomically. Reverted via the consumer's
 * `undoableActions.undo` handler — the engine itself doesn't know how.
 */
export interface UndoableAction {
  id: string;
  changeLogId: string;
  actionType?: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

/**
 * One captured inverse for a delta-applied sync action, recorded when the
 * consumer's `remoteUndo.evaluate` marks a server-pushed edit as undoable.
 * `"U"` stores only the touched fields (serialized), so a local revert
 * hydrates exactly what the delta changed; `"D"`/`"A"` store the full
 * pre-delete snapshot; `"I"`'s inverse is deletion, and `data` is kept for
 * redo.
 */
export type RemoteChange =
  | {
      action: "I";
      modelName: string;
      modelId: string;
      data: Record<string, unknown>;
    }
  | {
      action: "U";
      modelName: string;
      modelId: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }
  | {
      action: "D" | "A";
      modelName: string;
      modelId: string;
      snapshot: Record<string, unknown>;
    };

/**
 * A server-pushed delta packet tracked as user-undoable. Lives on the same
 * undo stack as `BaseTransaction`s / `UndoableAction`s (discriminated by
 * `source: "remote"`). On undo the engine optimistically reverts the pool +
 * storage from `changes`, then asks the consumer's `remoteUndo.undo` to
 * revert server-side by `syncId`. All tracked actions from one packet share
 * one entry, so a multi-action delta undoes atomically.
 */
export interface RemoteUndoAction {
  source: "remote";
  id: string;
  /** The delta packet's syncId — the handle the consumer reverts by. */
  syncId: number;
  changes: RemoteChange[];
  timestamp: number;
}

/** Passed to `remoteUndo.evaluate` for every action in an incoming delta
 *  packet. The engine pre-filters only packets it provably owns (awaited
 *  write ACKs and undo compensations); distinguishing any other echo from a
 *  genuinely remote edit — including `"V"` confirmations — is the
 *  evaluator's job, typically via an actor/user id the server includes in
 *  `data`. */
export interface RemoteUndoContext {
  syncId: number;
  action: "I" | "U" | "D" | "A" | "V" | "C";
  modelName: string;
  modelId: string;
  data?: Record<string, unknown>;
  /** The model's serialized state before the delta applies — `null` when
   *  the model isn't in the pool. Lazy; serialization runs only if called. */
  previousData: () => Record<string, unknown> | null;
}

/** Optionally returned by `remoteUndo.undo` / `redo`. When the server revert
 *  mints its own syncId, returning it here lets the engine skip re-evaluating
 *  the compensating delta when it echoes back over SSE. */
export interface RemoteUndoHandlerResult {
  compensatingSyncId?: number;
}

/**
 * Consumer wiring for undoable server-pushed edits (`advanced.remoteUndo`).
 * `evaluate` decides which incoming delta actions enter the undo stack;
 * `undo` submits the server-side revert by syncId after the engine has
 * already applied the local revert optimistically. If `undo` throws, the
 * local revert is rolled forward again (server stays the source of truth)
 * and the entry is returned to the undo stack for retry.
 */
export interface RemoteUndoConfig {
  evaluate: (ctx: RemoteUndoContext) => boolean;
  undo: (
    action: RemoteUndoAction,
  ) => Promise<RemoteUndoHandlerResult | void> | RemoteUndoHandlerResult | void;
  redo?: (
    action: RemoteUndoAction,
  ) => Promise<RemoteUndoHandlerResult | void> | RemoteUndoHandlerResult | void;
}

export class ArchiveTransaction extends BaseTransaction {
  readonly action = "A" as const;
  readonly snapshot: Record<string, unknown>;
  constructor(
    modelId: string,
    modelName: string,
    snapshot: Record<string, unknown>,
  ) {
    super(modelId, modelName);
    this.snapshot = snapshot;
  }
  revert(model: BaseModel) {
    model.hydrate(this.snapshot);
    model.makeModelObservable();
  }
  serialize() {
    return {
      id: this.id,
      action: this.action,
      batchId: this.batchId,
      modelId: this.modelId,
      modelName: this.modelName,
      timestamp: this.timestamp,
      snapshot: this.snapshot,
    };
  }
}
