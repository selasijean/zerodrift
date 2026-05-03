/**
 * Coalesces concurrent on-demand index queries into a single server call.
 * Used by `StoreManager.loadCollection` when an `onDemandIndexBatchFetcher`
 * is configured; otherwise the per-triple `onDemandFetcher` runs directly.
 */

export interface IndexQuery {
  modelName: string;
  indexKey: string;
  value: string;
}

export type IndexBatchFetcher = (
  queries: IndexQuery[],
) => Promise<Record<string, Record<string, unknown>[]>>;

interface PendingRequest {
  query: IndexQuery;
  resolve: (records: Record<string, unknown>[]) => void;
  reject: (err: unknown) => void;
}

function queryKey(q: IndexQuery): string {
  return `${q.modelName}:${q.indexKey}:${q.value}`;
}

export class BatchModelLoader {
  private fetcher: IndexBatchFetcher;
  private pending: PendingRequest[] = [];
  private flushScheduled = false;
  private disposed = false;

  constructor(fetcher: IndexBatchFetcher) {
    this.fetcher = fetcher;
  }

  /**
   * Schedule `query` for the next batch. The returned promise resolves with
   * the records matching this specific triple (filtered from the per-model
   * bag the server returns).
   */
  load(query: IndexQuery): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error("BatchModelLoader disposed"));
        return;
      }
      this.pending.push({ query, resolve, reject });
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => this.flush());
      }
    });
  }

  /** Reject any unflushed waiters. Called from `StoreManager.teardown`. */
  dispose(): void {
    this.disposed = true;
    const stale = this.pending;
    this.pending = [];
    for (const req of stale) {
      req.reject(new Error("BatchModelLoader disposed"));
    }
  }

  private async flush() {
    if (this.disposed) {
      return;
    }
    const batch = this.pending;
    this.pending = [];
    this.flushScheduled = false;

    // Dedupe identical triples — every waiter for the same triple shares one
    // server call.
    const uniqueByKey = new Map<string, IndexQuery>();
    for (const req of batch) {
      uniqueByKey.set(queryKey(req.query), req.query);
    }
    const unique = [...uniqueByKey.values()];

    try {
      const results = await this.fetcher(unique);
      for (const req of batch) {
        const bag = results[req.query.modelName] ?? [];
        req.resolve(
          bag.filter((r) => r[req.query.indexKey] === req.query.value),
        );
      }
    } catch (err) {
      for (const req of batch) {
        req.reject(err);
      }
    }
  }
}
