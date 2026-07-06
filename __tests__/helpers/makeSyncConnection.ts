import {
  SyncConnection,
  type DeltaPacket,
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

/** Push a delta packet through the private processDeltaPacket — tests drive
 *  packets directly to avoid needing a real EventSource. */
export function processPacket(
  conn: SyncConnection,
  packet: DeltaPacket,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (conn as any).processDeltaPacket(packet);
}
