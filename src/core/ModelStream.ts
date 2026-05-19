/**
 * Lightweight SSE connection for secondary services (e.g. a calculation engine).
 * Writes to IDB and upserts into the ObjectPool — no sync state management.
 * Ephemeral models skip IDB and are only held in the pool.
 */

import type { StorageAdapter } from "./Database.js";
import { ObjectPool } from "./ObjectPool.js";
import { ModelRegistry } from "./ModelRegistry.js";
import {
  BaseSSEConnection,
  type SSEClientFactory,
  type SSEErrorReporter,
} from "./BaseSSEConnection.js";
import { LoadStrategy } from "./types.js";

export interface ModelUpdate {
  modelName: string;
  modelId: string;
  data: Record<string, unknown>;
}

/**
 * Return null to drop the message. When not provided, raw payloads are
 * assumed to already match `ModelUpdate`.
 */
export type ModelStreamMessageTransform = (
  raw: unknown,
) => ModelUpdate | ModelUpdate[] | null | undefined;

export class ModelStream extends BaseSSEConnection {
  private updateQueue: ModelUpdate[] = [];
  private processing = false;

  constructor(
    url: string,
    private database: StorageAdapter,
    private pool: ObjectPool,
    private onStatusChange?: (connected: boolean) => void,
    sseClientFactory?: SSEClientFactory,
    private transform?: ModelStreamMessageTransform,
    reportError?: SSEErrorReporter,
  ) {
    super(url, sseClientFactory, reportError);
  }

  disconnect() {
    super.disconnect();
    this.updateQueue = [];
    this.processing = false;
  }

  protected onOpen() {
    this.onStatusChange?.(true);
  }

  protected onClose() {
    this.onStatusChange?.(false);
  }

  protected onMessage(data: string): void {
    const raw = JSON.parse(data);
    const transformed =
      this.transform != null ? this.transform(raw) : (raw as ModelUpdate);
    if (transformed == null) {
      return;
    }
    this.enqueue(Array.isArray(transformed) ? transformed : [transformed]);
  }

  private async enqueue(updates: ModelUpdate[]) {
    this.updateQueue.push(...updates);
    if (this.processing) {
      return;
    }
    this.processing = true;
    while (this.updateQueue.length > 0) {
      await this.applyUpdate(this.updateQueue.shift()!);
    }
    this.processing = false;
  }

  private async applyUpdate(update: ModelUpdate) {
    const { modelName, modelId, data } = update;
    if (data == null) {
      return;
    }

    const modelMeta = ModelRegistry.getModelMeta(modelName);
    if (modelMeta == null) {
      return;
    }

    const record = { id: modelId, ...data };

    if (modelMeta.loadStrategy !== LoadStrategy.Ephemeral) {
      await this.database.writeModels(modelName, [record]);
    }

    const existing = this.pool.getById(modelName, modelId);
    if (existing != null) {
      existing.hydrate(data);
      this.pool.put(modelName, existing);
    }
  }
}
