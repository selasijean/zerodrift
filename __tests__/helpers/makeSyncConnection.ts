import {
  SyncConnection,
  type SSEEndpoint,
  type SyncConnectionOptions,
} from "@zerodrift/SyncConnection";
import type { StorageAdapter } from "@zerodrift/Database";
import type { ObjectPool } from "@zerodrift/ObjectPool";
import type { TransactionQueue } from "@zerodrift/TransactionQueue";

interface MakeSyncConnectionOptions extends SyncConnectionOptions {
  url?: SSEEndpoint;
  db: StorageAdapter;
  pool: ObjectPool;
  queue: TransactionQueue;
}

export function makeSyncConnection(
  opts: MakeSyncConnectionOptions,
): SyncConnection {
  const { url, db, pool, queue, ...rest } = opts;
  return new SyncConnection(
    url ?? "http://localhost/events",
    db,
    pool,
    queue,
    rest,
  );
}
