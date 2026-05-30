import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ModelStream } from "@zerodrift/ModelStream";
import type { ModelStreamMessageTransform } from "@zerodrift/ModelStream";
import { ObjectPool } from "@zerodrift/ObjectPool";
import { MemoryAdapter } from "@zerodrift/MemoryAdapter";
import { BaseModel } from "@zerodrift/BaseModel";
import type { SSEClient, SSEClientFactory } from "@zerodrift/SyncConnection";
import { TestTask, TestMetric } from "./fixtures";
import {
  controllableSSEClient,
  makeFactory,
  sendMessage,
} from "./helpers/sseClient";

// ── setup ────────────────────────────────────────────────────────────────────

let adapter: MemoryAdapter;
let pool: ObjectPool;

beforeEach(async () => {
  BaseModel.storeManager = null;
  adapter = new MemoryAdapter();
  await adapter.connect();
  pool = new ObjectPool();
});

afterEach(() => {
  BaseModel.storeManager = null;
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("ModelStream", () => {
  describe("connect / disconnect", () => {
    it("connects and sets isConnected", () => {
      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
      );

      expect(stream.isConnected).toBe(false);
      stream.connect();
      expect(stream.isConnected).toBe(true);

      stream.disconnect();
      expect(stream.isConnected).toBe(false);
      expect(client.close).toHaveBeenCalled();
    });

    it("reconnect closes and reopens", () => {
      const clients: SSEClient[] = [];
      const factory: SSEClientFactory = () => {
        const c = controllableSSEClient();
        clients.push(c);
        return c;
      };
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        factory,
      );

      stream.connect();
      expect(clients).toHaveLength(1);

      stream.reconnect();
      expect(clients[0].close).toHaveBeenCalled();
      expect(clients).toHaveLength(2);
      expect(stream.isConnected).toBe(true);

      stream.disconnect();
    });

    it("accepts a thunk URL and re-evaluates it on every (re)connect", () => {
      let cursor = 0;
      const urlThunk = vi.fn(() => `http://calc/events?cursor=${++cursor}`);
      const seenUrls: string[] = [];
      const factory: SSEClientFactory = (url) => {
        seenUrls.push(url);
        return controllableSSEClient();
      };
      const stream = new ModelStream(
        urlThunk,
        adapter,
        pool,
        undefined,
        factory,
      );

      stream.connect();
      stream.reconnect();
      stream.reconnect();

      expect(urlThunk).toHaveBeenCalledTimes(3);
      expect(seenUrls).toEqual([
        "http://calc/events?cursor=1",
        "http://calc/events?cursor=2",
        "http://calc/events?cursor=3",
      ]);

      stream.disconnect();
    });
  });

  describe("applyUpdate — upsert", () => {
    it("writes to storage but does not hydrate new models into pool", async () => {
      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
      );
      stream.connect();

      sendMessage(client, {
        modelName: "TestTask",
        modelId: "t1",
        data: { title: "Calculated", done: false },
      });

      await vi.waitFor(async () => {
        const stored = await adapter.readModel("TestTask", "t1");
        expect(stored).not.toBeNull();
        expect(stored!.title).toBe("Calculated");
      });

      expect(pool.getById("TestTask", "t1")).toBeUndefined();

      stream.disconnect();
    });

    it("updates an existing model in the pool", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Original", done: false });
      task.makeModelObservable();
      pool.put("TestTask", task);

      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
      );
      stream.connect();

      sendMessage(client, {
        modelName: "TestTask",
        modelId: "t1",
        data: { title: "Updated" },
      });

      await vi.waitFor(() => {
        expect((pool.getById("TestTask", "t1") as TestTask).title).toBe(
          "Updated",
        );
      });

      stream.disconnect();
    });
  });

  describe("error handling", () => {
    it("ignores unknown model names", async () => {
      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
      );
      stream.connect();

      sendMessage(client, {
        modelName: "NonExistentModel",
        modelId: "x1",
        data: { foo: "bar" },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(pool.getById("NonExistentModel", "x1")).toBeUndefined();

      stream.disconnect();
    });

    it("ignores messages with null data", async () => {
      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
      );
      stream.connect();

      sendMessage(client, {
        modelName: "TestTask",
        modelId: "t1",
        data: null,
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(pool.getById("TestTask", "t1")).toBeUndefined();

      stream.disconnect();
    });

    it("ignores malformed JSON", () => {
      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
      );
      stream.connect();

      client.onmessage?.({ data: "not json" } as MessageEvent);

      stream.disconnect();
    });
  });

  describe("ephemeral models", () => {
    it("skips IDB and does not hydrate new ephemeral models", async () => {
      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
      );
      stream.connect();

      sendMessage(client, {
        modelName: "TestMetric",
        modelId: "m1",
        data: { value: 42, label: "cpu" },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(pool.getById("TestMetric", "m1")).toBeUndefined();

      const stored = await adapter.readModel("TestMetric", "m1");
      expect(stored).toBeNull();

      stream.disconnect();
    });

    it("updates existing ephemeral model without IDB write", async () => {
      const metric = new TestMetric();
      metric.hydrate({ id: "m1", value: 10, label: "mem" });
      metric.makeModelObservable();
      pool.put("TestMetric", metric);

      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
      );
      stream.connect();

      sendMessage(client, {
        modelName: "TestMetric",
        modelId: "m1",
        data: { value: 99 },
      });

      await vi.waitFor(() => {
        expect((pool.getById("TestMetric", "m1") as TestMetric).value).toBe(99);
      });

      const stored = await adapter.readModel("TestMetric", "m1");
      expect(stored).toBeNull();

      stream.disconnect();
    });
  });

  describe("onStatusChange", () => {
    it("fires true on connect, false on disconnect", () => {
      const client = controllableSSEClient();
      const statusChanges: boolean[] = [];
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        (connected) => statusChanges.push(connected),
        makeFactory(client),
      );

      stream.connect();
      expect(statusChanges).toEqual([true]);

      stream.disconnect();
      expect(statusChanges).toEqual([true, false]);
    });

    it("fires false on error, true on reconnect", () => {
      vi.useFakeTimers();

      const clients: SSEClient[] = [];
      const statusChanges: boolean[] = [];
      const factory: SSEClientFactory = () => {
        const c = controllableSSEClient();
        clients.push(c);
        return c;
      };
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        (connected) => statusChanges.push(connected),
        factory,
      );

      stream.connect();
      expect(statusChanges).toEqual([true]);

      (clients[0] as ReturnType<typeof controllableSSEClient>).triggerError();
      expect(statusChanges).toEqual([true, false]);

      vi.advanceTimersByTime(3000);
      expect(statusChanges).toEqual([true, false, true]);

      stream.disconnect();
      vi.useRealTimers();
    });
  });

  describe("transform", () => {
    it("converts a non-canonical envelope into a ModelUpdate", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Original" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      const transform: ModelStreamMessageTransform = (raw) => {
        const m = raw as {
          entity: string;
          id: string;
          fields: Record<string, unknown>;
        };
        return { modelName: m.entity, modelId: m.id, data: m.fields };
      };

      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
        transform,
      );
      stream.connect();

      sendMessage(client, {
        entity: "TestTask",
        id: "t1",
        fields: { title: "Transformed" },
      });

      await vi.waitFor(() => {
        expect((pool.getById("TestTask", "t1") as TestTask).title).toBe(
          "Transformed",
        );
      });

      stream.disconnect();
    });

    it("accepts an array of ModelUpdates", async () => {
      const t1 = new TestTask();
      t1.hydrate({ id: "t1", title: "One" });
      t1.makeModelObservable();
      pool.put("TestTask", t1);
      const t2 = new TestTask();
      t2.hydrate({ id: "t2", title: "Two" });
      t2.makeModelObservable();
      pool.put("TestTask", t2);

      const transform: ModelStreamMessageTransform = (raw) => {
        const items = raw as Array<{ id: string; title: string }>;
        return items.map((m) => ({
          modelName: "TestTask",
          modelId: m.id,
          data: { title: m.title },
        }));
      };

      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
        transform,
      );
      stream.connect();

      sendMessage(client, [
        { id: "t1", title: "OneUpdated" },
        { id: "t2", title: "TwoUpdated" },
      ]);

      await vi.waitFor(() => {
        expect((pool.getById("TestTask", "t1") as TestTask).title).toBe(
          "OneUpdated",
        );
        expect((pool.getById("TestTask", "t2") as TestTask).title).toBe(
          "TwoUpdated",
        );
      });

      stream.disconnect();
    });

    it("drops the message when the transform returns null", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Untouched" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      const transform: ModelStreamMessageTransform = () => null;

      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
        transform,
      );
      stream.connect();

      sendMessage(client, {
        modelName: "TestTask",
        modelId: "t1",
        data: { title: "Should Not Apply" },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect((pool.getById("TestTask", "t1") as TestTask).title).toBe(
        "Untouched",
      );

      stream.disconnect();
    });
  });

  describe("reconnect on error", () => {
    it("schedules reconnect when SSE errors", () => {
      vi.useFakeTimers();

      const clients: SSEClient[] = [];
      const factory: SSEClientFactory = () => {
        const c = controllableSSEClient();
        clients.push(c);
        return c;
      };
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        factory,
      );

      stream.connect();
      expect(clients).toHaveLength(1);
      expect(stream.isConnected).toBe(true);

      (clients[0] as ReturnType<typeof controllableSSEClient>).triggerError();
      expect(stream.isConnected).toBe(false);

      // Advance past reconnect delay (3s)
      vi.advanceTimersByTime(3000);
      expect(clients).toHaveLength(2);
      expect(stream.isConnected).toBe(true);

      stream.disconnect();
      vi.useRealTimers();
    });

    it("disconnect cancels pending reconnect", () => {
      vi.useFakeTimers();

      const clients: SSEClient[] = [];
      const factory: SSEClientFactory = () => {
        const c = controllableSSEClient();
        clients.push(c);
        return c;
      };
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        factory,
      );

      stream.connect();
      (clients[0] as ReturnType<typeof controllableSSEClient>).triggerError();

      // Disconnect before timer fires
      stream.disconnect();
      vi.advanceTimersByTime(5000);

      // Should NOT have reconnected
      expect(clients).toHaveLength(1);

      vi.useRealTimers();
    });
  });
});
