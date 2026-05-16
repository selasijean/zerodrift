/**
 * Headless / agent usage tests.
 *
 * Verifies the claims in the README:
 *
 *   1. StoreManager works outside React — no browser globals required.
 *   2. A custom sseClientFactory is accepted and used instead of EventSource.
 *   3. Isolated sessions: two StoreManagers with separate pools stay independent
 *      until a delta is delivered; then both converge.
 *   4. MemoryAdapter: pluggable in-memory storage for agent environments.
 *   5. Shared session: two "agents" sharing one StoreManager see each other's
 *      writes immediately without a server round-trip.
 *   6. Reactivity: objectPool.subscribe and collection.subscribe fire callbacks
 *      without React; unsubscribe() stops them.
 *   7. model.watch() — per-property reactivity without exposing MobX.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import { StoreManager } from "@sync-engine/StoreManager";
import {
  SyncConnection,
  type SSEClient,
  type SSEClientFactory,
} from "@sync-engine/SyncConnection";
import { makeSyncConnection } from "./helpers/makeSyncConnection";
import { BaseModel } from "@sync-engine/BaseModel";
import { Database, type StorageAdapter } from "@sync-engine/Database";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { ObjectPool } from "@sync-engine/ObjectPool";
import { TransactionQueue } from "@sync-engine/TransactionQueue";
import { TestTask, TestProject, addToPool } from "./fixtures";
import type { DeltaPacket } from "@sync-engine/SyncConnection";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a bare-bones SyncConnection rig using the given storage adapter.
 * Defaults to a fresh Database when no adapter is passed.
 */
async function makeAgent(adapter?: StorageAdapter) {
  const storage = adapter ?? new Database(crypto.randomUUID());
  await storage.connect();
  await storage.saveMeta({
    lastSyncId: 0,
    subscribedSyncGroups: [],
    schemaHash: "test",
    dbVersion: 1,
    backendDatabaseVersion: 0,
  });
  const pool = new ObjectPool();
  const queue = new TransactionQueue(storage, pool);
  const conn = makeSyncConnection({
    url: "http://x/events",
    db: storage,
    pool,
    queue,
  });
  return { storage, pool, queue, conn };
}

/** Minimal no-op SSEClient that never fires events. */
function noopSSEClient(): SSEClient {
  return { onmessage: null, onerror: null, close: vi.fn() };
}

/** Factory that records the URL it was called with and returns a no-op client. */
function recordingSSEFactory(): { factory: SSEClientFactory; calls: string[] } {
  const calls: string[] = [];
  const factory: SSEClientFactory = (url) => {
    calls.push(url);
    return noopSSEClient();
  };
  return { factory, calls };
}

// Push a delta packet directly into a SyncConnection (bypasses EventSource).
const pushPacket = (conn: SyncConnection, packet: DeltaPacket) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (conn as any).processDeltaPacket(packet);

// ── fixtures ──────────────────────────────────────────────────────────────────

let sm: StoreManager;

beforeEach(async () => {
  BaseModel.storeManager = null;
  sm = makeStoreManager({
    workspaceId: crypto.randomUUID(),
    bootstrapFetcher: vi.fn().mockResolvedValue({
      lastSyncId: 0,
      subscribedSyncGroups: [],
      models: {},
    }),
  });
  await sm.database.connect();
});

afterEach(async () => {
  BaseModel.storeManager = null;
  await sm.teardown();
});

// ── 1. No browser globals required ────────────────────────────────────────────

describe("Headless usage — no browser globals", () => {
  it("StoreManager constructs without EventSource in scope", () => {
    // Vitest runs in jsdom, but we verify no EventSource call is made
    // at construction time. EventSource is only touched in connect().
    const originalES = (globalThis as Record<string, unknown>)["EventSource"];
    delete (globalThis as Record<string, unknown>)["EventSource"];

    expect(() => {
      makeStoreManager({
        workspaceId: "test",
        bootstrapFetcher: vi.fn(),
      });
    }).not.toThrow();

    (globalThis as Record<string, unknown>)["EventSource"] = originalES;
  });

  it("ObjectPool, TransactionQueue, and Database work with no DOM", async () => {
    const db = new Database(crypto.randomUUID());
    await db.connect();
    const pool = new ObjectPool();
    const queue = new TransactionQueue(db, pool);

    const task = new TestTask();
    task.hydrate({ id: "t1", title: "Headless task" });
    task.makeModelObservable();
    pool.put("TestTask", task);

    expect(pool.getById("TestTask", "t1")).toBe(task);
    await queue.enqueueUpdate("t1", "TestTask", {
      title: { oldValue: "Headless task", newValue: "Updated" },
    });
    expect(queue.pendingCount).toBe(1);

    await db.destroy();
  });
});

// ── 2. Custom SSE client factory ──────────────────────────────────────────────

describe("Custom sseClientFactory", () => {
  it("is called with the correct URL when SyncConnection.connect() is invoked", async () => {
    const { factory, calls } = recordingSSEFactory();
    const db = new Database(crypto.randomUUID());
    await db.connect();
    await db.saveMeta({
      lastSyncId: 42,
      subscribedSyncGroups: ["group-a"],
      schemaHash: "test",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });

    const pool = new ObjectPool();
    const queue = new TransactionQueue(db, pool);
    const conn = makeSyncConnection({
      url: "http://node-agent:8081/api/events",
      db,
      pool,
      queue,
      sseClientFactory: factory,
    });

    conn.connect();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("http://node-agent:8081/api/events");
    expect(calls[0]).toContain("lastSyncId=42");
    expect(calls[0]).toContain("group-a");

    conn.disconnect();
    await db.destroy();
  });

  it("close() is called on the client when disconnect() is invoked", async () => {
    const client = noopSSEClient();
    const factory: SSEClientFactory = () => client;

    const db = new Database(crypto.randomUUID());
    await db.connect();
    await db.saveMeta({
      lastSyncId: 0,
      subscribedSyncGroups: [],
      schemaHash: "test",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });

    const pool = new ObjectPool();
    const queue = new TransactionQueue(db, pool);
    const conn = makeSyncConnection({
      db,
      pool,
      queue,
      sseClientFactory: factory,
    });

    conn.connect();
    conn.disconnect();

    expect(client.close).toHaveBeenCalledOnce();
    await db.destroy();
  });

  it("StoreManager passes sseClientFactory through to SyncConnection", async () => {
    const { factory, calls } = recordingSSEFactory();

    const agent = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      syncUrl: "http://node-agent:8081/api/events",
      sseClientFactory: factory,
    });

    await agent.bootstrap();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("node-agent");

    await agent.teardown();
  });
});

// ── Model streams — StoreManager wiring ──────────────────────────────────────

describe("modelStreams wiring", () => {
  it("bootstrap connects model streams using sseClientFactory", async () => {
    const { factory, calls } = recordingSSEFactory();

    const agent = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      modelStreams: [
        { url: "http://calc-service/events" },
        { url: "http://analytics/events" },
      ],
      sseClientFactory: factory,
    });

    await agent.bootstrap();

    expect(calls).toHaveLength(2);
    expect(calls).toContain("http://calc-service/events");
    expect(calls).toContain("http://analytics/events");

    await agent.teardown();
  });

  it("bootstrap connects both syncUrl and modelStreams", async () => {
    const { factory, calls } = recordingSSEFactory();

    const agent = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      syncUrl: "http://primary/events",
      modelStreams: [{ url: "http://calc-service/events" }],
      sseClientFactory: factory,
    });

    await agent.bootstrap();

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("primary");
    expect(calls[1]).toContain("calc-service");

    await agent.teardown();
  });

  it("teardown disconnects all model streams", async () => {
    const clients: SSEClient[] = [];
    const factory: SSEClientFactory = (_url) => {
      const c = noopSSEClient();
      clients.push(c);
      return c;
    };

    const agent = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      modelStreams: [
        { url: "http://calc/events" },
        { url: "http://analytics/events" },
      ],
      sseClientFactory: factory,
    });

    await agent.bootstrap();
    expect(clients).toHaveLength(2);

    await agent.teardown();

    for (const c of clients) {
      expect(c.close).toHaveBeenCalled();
    }
  });

  it("model stream updates existing pool models", async () => {
    let capturedClient: SSEClient | null = null;
    const factory: SSEClientFactory = (_url) => {
      const c = noopSSEClient();
      capturedClient = c;
      return c;
    };

    const agent = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {
          TestTask: [{ id: "calc-1", title: "Original", done: false }],
        },
      }),
      modelStreams: [{ url: "http://calc/events" }],
      sseClientFactory: factory,
      storageAdapter: new MemoryAdapter(),
    });

    await agent.bootstrap();

    capturedClient!.onmessage!({
      data: JSON.stringify({
        modelName: "TestTask",
        modelId: "calc-1",
        data: { title: "Calculated value", done: true },
      }),
    } as MessageEvent);

    await vi.waitFor(() => {
      const task = agent.objectPool.getById("TestTask", "calc-1") as TestTask;
      expect(task).toBeDefined();
      expect(task.title).toBe("Calculated value");
      expect(task.done).toBe(true);
    });

    await agent.teardown();
  });
});

// ── 3. Isolated sessions converge via delta ───────────────────────────────────

describe("Isolated agent sessions", () => {
  it("two StoreManagers have independent pools", async () => {
    const agentA = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(),
    });
    const agentB = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(),
    });
    await agentA.database.connect();
    await agentB.database.connect();

    const task = new TestTask();
    task.hydrate({ id: "t1", title: "Agent A task" });
    addToPool(agentA, "TestTask", task);

    // Pool B is unaffected
    expect(agentA.objectPool.getById("TestTask", "t1")).toBeDefined();
    expect(agentB.objectPool.getById("TestTask", "t1")).toBeUndefined();

    await agentA.teardown();
    await agentB.teardown();
  });

  it("delivering a delta to both sessions makes them converge", async () => {
    const [a, b] = await Promise.all([makeAgent(), makeAgent()]);

    const delta: DeltaPacket = {
      syncId: 1,
      syncActions: [
        {
          action: "I",
          modelName: "TestTask",
          modelId: "t-shared",
          data: { title: "Shared task", done: false },
        },
      ],
    };

    await Promise.all([pushPacket(a.conn, delta), pushPacket(b.conn, delta)]);

    expect(a.pool.getById("TestTask", "t-shared")).toBeDefined();
    expect(b.pool.getById("TestTask", "t-shared")).toBeDefined();
    expect((a.pool.getById("TestTask", "t-shared") as TestTask).title).toBe(
      "Shared task",
    );
    expect((b.pool.getById("TestTask", "t-shared") as TestTask).title).toBe(
      "Shared task",
    );

    a.conn.disconnect();
    b.conn.disconnect();
    await Promise.all([a.storage.destroy(), b.storage.destroy()]);
  });
});

// ── 4. MemoryAdapter — arbitrary StorageAdapter implementation ────────────────

describe("MemoryAdapter as storageAdapter", () => {
  it("StoreManager bootstraps successfully with MemoryAdapter", async () => {
    const agent = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 7,
        subscribedSyncGroups: ["g1"],
        models: {
          TestTask: [{ id: "t1", title: "From server", done: false }],
        },
      }),
      storageAdapter: new MemoryAdapter(),
    });

    await agent.bootstrap();

    expect(agent.objectPool.getById("TestTask", "t1")).toBeDefined();
    expect(agent.database.currentMeta?.lastSyncId).toBe(7);

    await agent.teardown();
  });

  it("MemoryAdapter stores and retrieves models", async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();

    await adapter.writeModels("TestTask", [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);

    expect(await adapter.readAllModels("TestTask")).toHaveLength(2);
    expect(await adapter.readModel("TestTask", "a")).toMatchObject({
      id: "a",
      title: "A",
    });
    expect(await adapter.readModel("TestTask", "z")).toBeNull();
  });

  it("MemoryAdapter readModelsByIndex filters correctly", async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();

    await adapter.writeModels("TestTask", [
      { id: "1", teamId: "t-x", title: "X1" },
      { id: "2", teamId: "t-x", title: "X2" },
      { id: "3", teamId: "t-y", title: "Y1" },
    ]);

    const results = await adapter.readModelsByIndex(
      "TestTask",
      "teamId",
      "t-x",
    );
    expect(results).toHaveLength(2);
    expect(results.every((r) => r["teamId"] === "t-x")).toBe(true);
  });

  it("MemoryAdapter caches and replays transactions", async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();

    const k1 = await adapter.cacheTransaction({ action: "U", modelId: "x" });
    const k2 = await adapter.cacheTransaction({ action: "U", modelId: "y" });

    expect(await adapter.getCachedTransactions()).toHaveLength(2);

    await adapter.deleteCachedTransactions([k1 as number]);
    const remaining = await adapter.getCachedTransactions();
    expect(remaining).toHaveLength(1);
    expect((remaining[0].data as { modelId: string }).modelId).toBe("y");

    await adapter.deleteCachedTransactions([k2 as number]);
    expect(await adapter.getCachedTransactions()).toHaveLength(0);
  });

  it("MemoryAdapter is independent across instances", async () => {
    const a = new MemoryAdapter();
    const b = new MemoryAdapter();
    await a.connect();
    await b.connect();

    await a.writeModels("TestTask", [{ id: "1", title: "Only in A" }]);

    expect(await a.readAllModels("TestTask")).toHaveLength(1);
    expect(await b.readAllModels("TestTask")).toHaveLength(0);
  });

  it("two agents with separate MemoryAdapters converge via delta", async () => {
    const [a, b] = await Promise.all([
      makeAgent(new MemoryAdapter()),
      makeAgent(new MemoryAdapter()),
    ]);

    const delta: DeltaPacket = {
      syncId: 1,
      syncActions: [
        {
          action: "I",
          modelName: "TestTask",
          modelId: "t-mem",
          data: { title: "Memory task", done: false },
        },
      ],
    };

    await Promise.all([pushPacket(a.conn, delta), pushPacket(b.conn, delta)]);

    expect((a.pool.getById("TestTask", "t-mem") as TestTask).title).toBe(
      "Memory task",
    );
    expect((b.pool.getById("TestTask", "t-mem") as TestTask).title).toBe(
      "Memory task",
    );

    a.conn.disconnect();
    b.conn.disconnect();
    await Promise.all([a.storage.destroy(), b.storage.destroy()]);
  });
});

// ── 5. Shared pool — writes visible immediately between agents ────────────────

describe("Shared StoreManager between agents", () => {
  it("a write by agent A is immediately visible to agent B", () => {
    const task = new TestTask();
    task.hydrate({ id: "t1", title: "Original" });
    addToPool(sm, "TestTask", task);

    // Agent A and agent B both hold a reference to the same pool model.
    const agentAView = sm.objectPool.getById("TestTask", "t1") as TestTask;
    const agentBView = sm.objectPool.getById("TestTask", "t1") as TestTask;

    // Same instance — shared reference
    expect(agentAView).toBe(agentBView);

    // Agent A mutates
    agentAView.title = "Updated by A";

    // Agent B sees it immediately — no delta required
    expect(agentBView.title).toBe("Updated by A");
  });

  it("pool subscription notifies when any agent writes a new model", () => {
    const notifications: string[] = [];
    sm.objectPool.subscribe("TestTask", () => {
      notifications.push("change");
    });

    const task = new TestTask();
    task.hydrate({ id: "t-new", title: "New" });
    task.makeModelObservable();
    sm.objectPool.put("TestTask", task);

    expect(notifications).toHaveLength(1);
  });

  it("undo by one agent reverts state visible to all", async () => {
    BaseModel.storeManager = sm as unknown as typeof BaseModel.storeManager;

    const task = new TestTask();
    task.hydrate({ id: "t1", title: "Original" });
    addToPool(sm, "TestTask", task);
    task.store = sm.objectPool;

    task.title = "Changed";
    task.save();

    await sm.undo();

    // Both "agents" (any consumer of the shared pool) now see Original
    expect((sm.objectPool.getById("TestTask", "t1") as TestTask).title).toBe(
      "Original",
    );
  });
});

// ── 6. Reactivity callbacks — objectPool.subscribe and collection.subscribe ───

describe("Reactivity in headless mode", () => {
  it("objectPool.subscribe fires when a new model is added", () => {
    const notifications: string[] = [];
    sm.objectPool.subscribe("TestTask", () => notifications.push("add"));

    const task = new TestTask();
    task.hydrate({ id: "t-new", title: "Hello" });
    task.makeModelObservable();
    sm.objectPool.put("TestTask", task);

    expect(notifications).toHaveLength(1);
  });

  it("objectPool unsubscribe() stops future notifications", () => {
    const notifications: string[] = [];
    const unsubscribe = sm.objectPool.subscribe("TestTask", () =>
      notifications.push("change"),
    );

    const task1 = new TestTask();
    task1.hydrate({ id: "t1", title: "First" });
    task1.makeModelObservable();
    sm.objectPool.put("TestTask", task1);
    expect(notifications).toHaveLength(1);

    unsubscribe();

    const task2 = new TestTask();
    task2.hydrate({ id: "t2", title: "Second" });
    task2.makeModelObservable();
    sm.objectPool.put("TestTask", task2);

    // No new notification after unsubscribe
    expect(notifications).toHaveLength(1);
  });

  it("collection.subscribe fires when load() completes", async () => {
    const project = new TestProject();
    project.hydrate({ id: "p1", title: "Project" });
    project.makeModelObservable();

    const notifications: string[] = [];
    project.tasks.watch(() => notifications.push("fired"));

    await project.tasks.load();

    expect(notifications).toHaveLength(1);
  });

  it("collection unsubscribe() stops notifications on subsequent loads", async () => {
    const project = new TestProject();
    project.hydrate({ id: "p2", title: "Project" });
    project.makeModelObservable();

    const notifications: string[] = [];
    const unsubscribe = project.tasks.watch(() =>
      notifications.push("fired"),
    );

    await project.tasks.load();
    expect(notifications).toHaveLength(1);

    unsubscribe();
    await project.tasks.reload();

    // Subscriber was removed — no second notification
    expect(notifications).toHaveLength(1);
  });
});

// ── 7. model.watch() — per-property reactivity without MobX exposure ─────────

describe("model.watch() in headless context", () => {
  it("fires when a @Property changes", () => {
    const task = new TestTask();
    task.hydrate({ id: "t1", title: "Original" });
    task.makeModelObservable();

    const observed: string[] = [];
    const unwatch = task.watch(
      (m) => m.title,
      (newVal) => observed.push(newVal),
    );

    task.title = "Updated";

    expect(observed).toEqual(["Updated"]);
    unwatch();
  });

  it("passes both new and old value to the callback", () => {
    const task = new TestTask();
    task.hydrate({ id: "t1", title: "Before" });
    task.makeModelObservable();

    const transitions: Array<[string, string]> = [];
    const unwatch = task.watch(
      (m) => m.title,
      (newVal, oldVal) => transitions.push([oldVal, newVal]),
    );

    task.title = "After";

    expect(transitions).toEqual([["Before", "After"]]);
    unwatch();
  });

  it("does NOT fire when the value is set to the same thing", () => {
    const task = new TestTask();
    task.hydrate({ id: "t1", title: "Same" });
    task.makeModelObservable();

    const observed: string[] = [];
    const unwatch = task.watch(
      (m) => m.title,
      (newVal) => observed.push(newVal),
    );

    task.title = "Same";

    expect(observed).toHaveLength(0);
    unwatch();
  });

  it("unwatch() stops further notifications", () => {
    const task = new TestTask();
    task.hydrate({ id: "t1", title: "Start" });
    task.makeModelObservable();

    const observed: string[] = [];
    const unwatch = task.watch(
      (m) => m.title,
      (newVal) => observed.push(newVal),
    );

    task.title = "First";
    unwatch();
    task.title = "Second";

    expect(observed).toEqual(["First"]);
  });

  it("objectPool.subscribe fires when a delta updates a model, watch fires on the updated field", async () => {
    const { pool, conn, storage } = await makeAgent(new MemoryAdapter());

    const poolNotifications: string[] = [];
    const unsubscribePool = pool.subscribe("TestTask", () =>
      poolNotifications.push("pool"),
    );

    await pushPacket(conn, {
      syncId: 1,
      syncActions: [
        {
          action: "I",
          modelName: "TestTask",
          modelId: "t-delta",
          data: { title: "From delta", done: false },
        },
      ],
    });

    expect(poolNotifications).toHaveLength(1);

    const task = pool.getById("TestTask", "t-delta") as TestTask;
    expect(task).toBeDefined();

    const titleChanges: string[] = [];
    const unwatch = task.watch(
      (m) => m.title,
      (newVal) => titleChanges.push(newVal),
    );

    await pushPacket(conn, {
      syncId: 2,
      syncActions: [
        {
          action: "U",
          modelName: "TestTask",
          modelId: "t-delta",
          data: { title: "Updated by delta" },
        },
      ],
    });

    expect(poolNotifications).toHaveLength(2);
    expect(titleChanges).toEqual(["Updated by delta"]);

    unwatch();
    unsubscribePool();
    conn.disconnect();
    await storage.destroy();
  });
});
