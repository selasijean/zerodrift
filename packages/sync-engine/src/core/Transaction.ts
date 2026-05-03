/**
 * Transaction types with batchId for multi-model grouped undo and rebase support.
 *
 * batchId groups transactions from one user action (e.g. moveIssueToTeam
 * updates Issue.teamId AND Team.issueCount). undo() reverts the entire batch.
 *
 * Rebasing (UpdateTransaction): when a delta packet conflicts with our local
 * change, the server value becomes our new baseline and our value is re-applied.
 */

import type { BaseModel } from "./BaseModel";
import { TransactionState, type PropertyChange } from "./types";

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
