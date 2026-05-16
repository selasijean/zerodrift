import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import {
  StoreManager,
  type BootstrapResponse,
} from "@sync-engine/StoreManager";
import { controllableSSEClient, makeFactory } from "./helpers/sseClient";

const emptyBootstrap: BootstrapResponse = {
  lastSyncId: 0,
  subscribedSyncGroups: [],
  models: {},
};

let originalEventSource: typeof globalThis.EventSource | undefined;
let ctorCalls: Array<{ url: string; init: EventSourceInit | undefined }>;

beforeEach(() => {
  originalEventSource = globalThis.EventSource;
  ctorCalls = [];

  class FakeEventSource {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    constructor(url: string, init?: EventSourceInit) {
      ctorCalls.push({ url, init });
    }
    close() {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = FakeEventSource as any;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = originalEventSource;
});

describe("StoreManagerConfig.sseInit", () => {
  it("forwards sseInit to the default EventSource for the sync connection", async () => {
    const sm = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue(emptyBootstrap),
      syncUrl: "http://localhost/sync",
      sseInit: { withCredentials: true },
    });

    await sm.bootstrap();
    try {
      expect(ctorCalls).toHaveLength(1);
      expect(ctorCalls[0].url).toMatch(/^http:\/\/localhost\/sync/);
      expect(ctorCalls[0].init).toEqual({ withCredentials: true });
    } finally {
      await sm.teardown();
    }
  });

  it("forwards sseInit to every modelStream connection too", async () => {
    const sm = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue(emptyBootstrap),
      syncUrl: "http://localhost/sync",
      modelStreams: [{ url: "http://localhost/calc" }],
      sseInit: { withCredentials: true },
    });

    await sm.bootstrap();
    try {
      expect(ctorCalls).toHaveLength(2);
      for (const call of ctorCalls) {
        expect(call.init).toEqual({ withCredentials: true });
      }
      const urls = ctorCalls.map((c) => c.url).sort();
      expect(urls[0]).toMatch(/^http:\/\/localhost\/calc/);
      expect(urls[1]).toMatch(/^http:\/\/localhost\/sync/);
    } finally {
      await sm.teardown();
    }
  });

  it("ignores sseInit when sseClientFactory is provided", async () => {
    const client = controllableSSEClient();
    const factory = vi.fn(makeFactory(client));

    const sm = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue(emptyBootstrap),
      syncUrl: "http://localhost/sync",
      sseClientFactory: factory,
      sseInit: { withCredentials: true },
    });

    await sm.bootstrap();
    try {
      expect(factory).toHaveBeenCalledTimes(1);
      expect(ctorCalls).toEqual([]);
    } finally {
      await sm.teardown();
    }
  });

  it("constructs EventSource without init when sseInit is omitted", async () => {
    const sm = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue(emptyBootstrap),
      syncUrl: "http://localhost/sync",
    });

    await sm.bootstrap();
    try {
      expect(ctorCalls).toHaveLength(1);
      expect(ctorCalls[0].url).toMatch(/^http:\/\/localhost\/sync/);
      expect(ctorCalls[0].init).toBeUndefined();
    } finally {
      await sm.teardown();
    }
  });
});
