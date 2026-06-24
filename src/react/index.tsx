/**
 * React integration for the Sync Engine.
 *
 * Hooks subscribe to ObjectPool change notifications via useSyncExternalStore,
 * so a delta packet that adds, updates, or removes a model automatically
 * re-renders any component reading it through `useRecord` / `useRecords` /
 * `useRecordsByIndex` (or a relation via `useRelation`).
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
  useLayoutEffect,
} from "react";
import { StoreManager, type StoreManagerConfig } from "../core/StoreManager.js";
import { BootstrapPhase } from "../core/types.js";
import { LazyCollectionBase, BackRef } from "../core/LazyCollection.js";
import { readFk, ObjectPool } from "../core/ObjectPool.js";
import { FetchGate } from "./FetchGate.js";
export { FetchGate } from "./FetchGate.js";
import type { BaseModel } from "../core/BaseModel.js";
import {
  createStore,
  entityNamespaceRegistryName,
  type EntityNamespace,
  type EntityStore,
  type RecordWithExtensions,
} from "../schema/createStore.js";
import type { ExtensionDescriptor } from "../schema/extend.js";
import type { EntityKey, IndexedFieldKeys } from "../schema/infer.js";
import type { SchemaDef } from "../schema/types.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface SyncStatus {
  phase: BootstrapPhase;
  detail?: string;
  error?: string;
}

// `<any>` keeps the hooks free of TContext — none of them touch it.
const SyncContext = createContext<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sm: StoreManager<any>;
  status: SyncStatus;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store?: EntityStore<any, any>;
} | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function SyncProvider<
  TContext = unknown,
  S extends SchemaDef = SchemaDef,
>({
  config,
  schema,
  extensions,
  context,
  children,
  fallback,
}: {
  config: StoreManagerConfig<TContext>;
  /** Live context forwarded to `StoreManager.setContext` — consumed by
   * `identifierFn` when minting ids for client-side models. Pushed
   * synchronously so handlers fired in the same commit see the update. */
  context?: TContext;
  children: React.ReactNode;
  /** Shown while bootstrap is in progress. */
  fallback?: React.ReactNode;
} & (
  | { schema?: undefined; extensions?: undefined }
  | {
      /** Schema-first wiring. Read the store back with `useStore<typeof schema>()`. */
      schema: S;
      extensions?: readonly ExtensionDescriptor<S>[];
    }
)) {
  const [status, setStatus] = useState<SyncStatus>({
    phase: BootstrapPhase.Idle,
  });
  const smRef = useRef<StoreManager<TContext> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const storeRef = useRef<EntityStore<any, any> | undefined>(undefined);
  const cfgRef = useRef(config);
  cfgRef.current = config;
  const schemaRef = useRef(schema);
  schemaRef.current = schema;
  const extensionsRef = useRef(extensions);
  extensionsRef.current = extensions;

  // Detect bfcache restores. When a tab is duplicated (or the user navigates
  // back/forward) the browser may restore the page from its back/forward cache
  // (bfcache). In that case the JS heap is frozen and thawed — React effects do
  // NOT re-run, so the StoreManager never bootstraps and the fallback stays
  // visible forever. Reloading on persisted pageshow breaks out of that state.
  useEffect(() => {
    const handlePageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        window.location.reload();
      }
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  // Latest context, sampled at render time. Captured into a ref so the
  // construction effect can seed the StoreManager without re-running when
  // the context changes (the dedicated effect below pushes updates).
  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    let active = true;

    const sm = new StoreManager<TContext>({
      ...cfgRef.current,
      hooks: {
        ...cfgRef.current.hooks,
        onPhaseChange: (phase, detail) => {
          cfgRef.current.hooks?.onPhaseChange?.(phase, detail);
          if (active) {
            setStatus({ phase, detail });
          }
        },
      },
    });
    if (contextRef.current !== undefined) {
      sm.setContext(contextRef.current);
    }
    // createStore registers schema entities into ModelRegistry — must
    // run before bootstrap() so the first fetch sees them.
    if (schemaRef.current != null) {
      storeRef.current = createStore({
        schema: schemaRef.current,
        storeManager: sm,
        extensions: extensionsRef.current,
      });
    }
    smRef.current = sm;
    sm.bootstrap().catch((err) => {
      if (active) {
        setStatus({ phase: BootstrapPhase.Error, error: String(err) });
      }
    });
    return () => {
      active = false;
      sm.teardown();
      smRef.current = null;
      storeRef.current = undefined;
    };
  }, [cfgRef.current.workspaceId]);

  // Push context updates synchronously so an event handler dispatched in the
  // same commit as a context change sees the fresh value when minting ids.
  useLayoutEffect(() => {
    if (smRef.current != null && context !== undefined) {
      smRef.current.setContext(context);
    }
  }, [context]);

  if (smRef.current == null) {
    return fallback != null ? <>{fallback}</> : null;
  }
  if (
    status.phase !== BootstrapPhase.Ready &&
    status.phase !== BootstrapPhase.Error &&
    fallback != null
  ) {
    return <>{fallback}</>;
  }
  return (
    <SyncContext.Provider
      value={{ sm: smRef.current, status, store: storeRef.current }}
    >
      {children}
    </SyncContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Core hook
// ---------------------------------------------------------------------------

export function useSyncEngine() {
  const ctx = useContext(SyncContext);
  if (ctx == null) {
    throw new Error("useSyncEngine() must be inside <SyncProvider>");
  }
  return ctx;
}

export function useBootstrapStatus(): SyncStatus {
  return useSyncEngine().status;
}

/** Read the schema-first store from context — `useStore<typeof schema>()`. */
export function useStore<
  S extends SchemaDef,
  const Exts extends readonly ExtensionDescriptor<S>[] = readonly [],
>(): EntityStore<S, Exts> {
  const ctx = useSyncEngine();
  if (ctx.store == null) {
    throw new Error("useStore() requires <SyncProvider schema={…}>.");
  }
  return ctx.store as EntityStore<S, Exts>;
}

/** Subscribe to a model type's pool changes and read a snapshot synchronously.
 *
 * `getSnapshot` is intentionally NOT stabilized — useSyncExternalStore calls
 * it during render and compares the returned value, not the function identity.
 * Stabilizing via useStableCallback would defer ref-updates to useLayoutEffect
 * and silently return stale values on the render where its inputs change. */
function usePoolSnapshot<R>(modelName: string, getSnapshot: () => R): R {
  const { sm } = useSyncEngine();
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      sm.objectPool.subscribe(modelName, onStoreChange),
    [sm, modelName],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// useLoader — internal helper carrying the loading/error/reload + race-guard
// shape shared by every pool-aware hook below. Auto-fires on mount and on
// `triggerKey` change when `shouldAutoFire` returns true; `reload()` always
// fires regardless of the gate.
// ---------------------------------------------------------------------------

function useLoader(
  load: () => Promise<unknown>,
  enabled: boolean,
  triggerKey: string,
  shouldAutoFire: () => boolean,
): {
  isLoading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
} {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const gen = useRef(0);
  const stableLoad = useStableCallback(load);
  const stableShouldAutoFire = useStableCallback(shouldAutoFire);

  const reload = useCallback(async () => {
    if (!enabled) {
      return;
    }
    const g = ++gen.current;
    setIsLoading(true);
    setError(null);
    try {
      await stableLoad();
      if (g === gen.current) {
        setIsLoading(false);
      }
    } catch (e) {
      if (g === gen.current) {
        setError(e as Error);
        setIsLoading(false);
      }
    }
  }, [enabled, triggerKey, stableLoad]);

  useEffect(() => {
    if (enabled && stableShouldAutoFire()) {
      void reload();
    }
  }, [reload, enabled, triggerKey, stableShouldAutoFire]);

  return { isLoading, error, reload };
}

/**
 * Uniform async-resource shape for every load-aware hook (`useRecord`,
 * `useRecords`, `useRecordsByIndex`, `useRelation`). `data` is the payload
 * (`T | null` for a single record, `T[]` for a list); the rest is the
 * lifecycle bag. `isLoaded` is true once the first resolve settled without
 * error (a pool hit counts as resolved from frame zero).
 */
export interface AsyncResource<T> {
  data: T;
  isLoading: boolean;
  isLoaded: boolean;
  error: Error | null;
  reload: () => Promise<void>;
}

/** Per-call options shared by the load-aware read hooks. */
export interface UseQueryOptions {
  /**
   * When true, hold all fetching — auto-fire on mount/dependency change *and*
   * `reload()` are suppressed until it flips false. The hook still reads the
   * pool synchronously, so anything already resident renders immediately;
   * only the async backfill waits. Use it to defer a fetch until a prerequisite
   * is ready (auth resolved, a parent record loaded, a panel actually opened).
   */
  pause?: boolean;
  /**
   * A re-enableable signal that gates fetching, on top of `pause`. While the
   * gate is disabled the hook holds its fetch exactly as `pause: true` does,
   * and resumes (backfilling if needed) when it re-enables. Unlike `pause` it
   * can be shared across many hooks and driven imperatively — e.g. wire one to
   * an `IntersectionObserver` via `useVisibilityGate` to stop off-screen
   * components from fetching. Fetching proceeds only when `!pause` *and* the
   * gate is enabled.
   */
  gate?: FetchGate;
}

/** `isLoaded` for the pool-keyed hooks: ready, not loading, no error — true
 * from frame zero on a pool hit (the loader's auto-fire is gated). */
const settled = (
  ready: boolean,
  isLoading: boolean,
  error: Error | null,
): boolean => ready && !isLoading && error == null;

/**
 * Resolve the effective "hold fetching" flag from a hook's options: paused when
 * `pause` is true OR a `gate` is present and disabled. Subscribes to the gate
 * via `useSyncExternalStore` so a flip re-renders the consumer (no gate → a
 * stable no-op subscription, so this is cheap on the common path).
 */
/** @internal Exported for unit testing the gate→pause resolution. */
export function usePaused(opts: UseQueryOptions | undefined): boolean {
  const gate = opts?.gate;
  const subscribe = useCallback(
    (onChange: () => void) => gate?.subscribe(onChange) ?? (() => {}),
    [gate],
  );
  const getEnabled = useCallback(() => gate?.enabled ?? true, [gate]);
  const gateEnabled = useSyncExternalStore(subscribe, getEnabled, getEnabled);
  return (opts?.pause ?? false) || !gateEnabled;
}

/** Options for {@link useVisibilityGate}. Extends `IntersectionObserverInit`
 * (`root`, `rootMargin`, `threshold`) with the gate's starting state. */
export interface UseVisibilityGateOptions extends IntersectionObserverInit {
  /** Gate state before the observer first reports. Defaults to `false`
   * (treat as off-screen until proven visible), so nothing fetches until the
   * element is actually seen. Set `true` to fetch optimistically up front. */
  initiallyVisible?: boolean;
}

/**
 * A {@link FetchGate} driven by an `IntersectionObserver`: enabled while the
 * observed element is on screen, disabled when it scrolls out. Spread the
 * returned `ref` onto the element and hand `gate` to any read hook to stop
 * off-screen components from fetching.
 *
 *     const { ref, gate } = useVisibilityGate({ rootMargin: "200px" });
 *     const { data } = useRecord(store.issue, id, { gate });
 *     return <div ref={ref}>{data?.title}</div>;
 *
 * The gate is a stable instance for the component's lifetime. Outside the
 * browser (SSR / no `IntersectionObserver`) it stays at `initiallyVisible`.
 */
export function useVisibilityGate(options?: UseVisibilityGateOptions): {
  ref: (el: Element | null) => void;
  gate: FetchGate;
} {
  const gateRef = useRef<FetchGate | null>(null);
  if (gateRef.current == null) {
    gateRef.current = new FetchGate(options?.initiallyVisible ?? false);
  }
  const gate = gateRef.current;

  // Keep the latest observer options without re-creating the observer each
  // render (option object literals are unstable).
  const optsRef = useRef(options);
  optsRef.current = options;

  const observerRef = useRef<IntersectionObserver | null>(null);

  const ref = useCallback(
    (el: Element | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (el == null || typeof IntersectionObserver === "undefined") {
        return;
      }
      const observer = new IntersectionObserver((entries) => {
        gate.set(entries.some((entry) => entry.isIntersecting));
      }, optsRef.current);
      observer.observe(el);
      observerRef.current = observer;
    },
    [gate],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { ref, gate };
}

// ── Observation tracking for eviction safety ──────────────────────────────
//
// Tracks which record IDs are currently rendered by list hooks so the
// eviction safety predicate (pool.isObserved) can protect them. Diffs the
// snapshot IDs on each render and observes/unobserves the delta.

/** @internal Exported for unit testing the observe/unobserve diffing. */
export function useObserveItems(
  pool: ObjectPool,
  modelName: string,
  items: BaseModel[],
): void {
  const prevIds = useRef<Set<string>>(new Set());

  // Diff each render: observe newly-added ids, unobserve removed ones. No
  // cleanup here — React fires effect cleanup on every dependency change, and
  // unobserving the whole set on each `items` change would drop the refcount
  // for records that are still rendered (the next effect, seeing them already
  // in `prevIds`, wouldn't re-observe them).
  useEffect(() => {
    const currentIds = new Set(items.map((m) => m.id));
    for (const id of currentIds) {
      if (!prevIds.current.has(id)) {
        pool.observeInstance(modelName, id);
      }
    }
    for (const id of prevIds.current) {
      if (!currentIds.has(id)) {
        pool.unobserveInstance(modelName, id);
      }
    }
    prevIds.current = currentIds;
  }, [items, pool, modelName]);

  // Release whatever is still observed on unmount only.
  useEffect(() => {
    return () => {
      for (const id of prevIds.current) {
        pool.unobserveInstance(modelName, id);
      }
      prevIds.current = new Set();
    };
  }, [pool, modelName]);
}

// Model-name-keyed implementations. The public hooks resolve a handle
// (schema namespace or model class) to a registry name and delegate here,
// so the pool-subscription / loader machinery lives in exactly one place.

/** Reactive single model by id. Pool-first sync read; async backfill on miss. */
function useRecordByName<T extends BaseModel>(
  modelName: string,
  id: string | null | undefined,
  opts?: UseQueryOptions,
): AsyncResource<T | null> {
  const { sm, status } = useSyncEngine();
  const pool = sm.objectPool;
  const ready = status.phase === BootstrapPhase.Ready;
  const pause = usePaused(opts);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (id != null) {
        pool.observeInstance(modelName, id);
      }
      const unsub = pool.subscribe(modelName, onStoreChange);
      return () => {
        unsub();
        if (id != null) {
          pool.unobserveInstance(modelName, id);
        }
      };
    },
    [pool, modelName, id],
  );

  const getSnapshot = useCallback(
    () => (id != null ? (pool.getById(modelName, id) ?? null) : null),
    [pool, modelName, id],
  );

  const item = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const { isLoading, error, reload } = useLoader(
    () => sm.getOrLoadById(modelName, id!),
    ready && id != null && !pause,
    `${modelName}:${id ?? ""}`,
    // Skip the load when the pool already has the entry — eager models
    // render with isLoading: false from frame zero.
    () => id != null && pool.getById(modelName, id) == null,
  );

  const prevItem = useRef(item);

  useEffect(() => {
    if (prevItem.current != null && item == null && id != null) {
      if (pool.wasEvicted(modelName, id)) {
        pool.clearEvicted(modelName, id);
        void reload();
      }
    }
    prevItem.current = item;
  }, [item, id, reload, pool, modelName]);

  return {
    data: ready ? (item as T | null) : null,
    isLoading,
    isLoaded: settled(ready, isLoading, error),
    error,
    reload,
  };
}

/** Reactive list of models of a type, optionally filtered to a specific id
 * set. Without `ids`: every instance in the pool. With `ids`: just those, in
 * the order given, with async backfill for any missing from the pool. The
 * ids array is compared by content so inline literals don't cause re-fetches. */
function useRecordsByName<T extends BaseModel>(
  modelName: string,
  ids?: string[] | null,
  opts?: UseQueryOptions,
): AsyncResource<T[]> {
  const { sm, status } = useSyncEngine();
  const pool = sm.objectPool;
  const ready = status.phase === BootstrapPhase.Ready;
  const pause = usePaused(opts);
  const idsKey = ids?.join(",") ?? "";

  const all = usePoolSnapshot(modelName, () => pool.getAll(modelName));

  const items = useMemo(() => {
    if (ids == null) {
      return all;
    }
    const byId = new Map(all.map((m) => [m.id, m]));
    return ids
      .map((id) => byId.get(id))
      .filter((m): m is (typeof all)[number] => m != null);
  }, [all, idsKey]);

  useObserveItems(pool, modelName, items);

  const { isLoading, error, reload } = useLoader(
    () => sm.getOrLoadByIds(modelName, ids ?? []),
    ready && ids != null && ids.length > 0 && !pause,
    `${modelName}:${idsKey}`,
    () => ids != null && ids.some((id) => pool.getById(modelName, id) == null),
  );

  return {
    data: ready ? (items as T[]) : [],
    isLoading,
    isLoaded: settled(ready, isLoading, error),
    error,
    reload,
  };
}

/** Reactive list of models matching one OR many values on a foreign-key
 * index. A single string and a `string[]` take the same path (the single
 * value is a one-element set), so semantics are identical. Coverage is
 * tracked per `(name, indexKey, value)` so re-renders don't re-fetch
 * already-covered buckets; values are compared by content so inline literals
 * don't trigger re-fetches.
 *
 * For one-round-trip multi-value fetches, configure
 * `onDemandIndexBatchFetcher` + `serverSupportsCompoundIndexKeys: true` —
 * see `agent-docs/04-lazy-loading.md`. */
function useRecordsByIndexName<T extends BaseModel>(
  modelName: string,
  indexKey: string,
  value: string | readonly string[] | null | undefined,
  opts?: UseQueryOptions,
): AsyncResource<T[]> {
  const { sm, status } = useSyncEngine();
  const ready = status.phase === BootstrapPhase.Ready;
  const pause = usePaused(opts);

  const values =
    value == null
      ? []
      : (Array.isArray(value) ? value : [value as string]).filter(
          (v) => v != null && v !== "",
        );
  const valuesKey = values.join(",");
  const hasValues = values.length > 0;

  const all = usePoolSnapshot(modelName, () => sm.objectPool.getAll(modelName));

  const items = useMemo(() => {
    if (!hasValues) {
      return [];
    }
    const set = new Set(values);
    return all.filter((m) => {
      const v = readFk(m, indexKey);
      return v != null && set.has(v);
    });
    // valuesKey: content equality; array identity is unstable for inline literals.
  }, [all, indexKey, valuesKey, hasValues]);

  useObserveItems(sm.objectPool, modelName, items);

  const { isLoading, error, reload } = useLoader(
    async () => {
      await Promise.all(
        values.map((v) => sm.getOrLoadCollection(modelName, indexKey, v)),
      );
    },
    ready && hasValues && !pause,
    `${modelName}:${indexKey}:${valuesKey}`,
    () =>
      hasValues &&
      values.some((v) => !sm.isCollectionLoaded(modelName, indexKey, v)),
  );

  return {
    data: ready ? (items as T[]) : [],
    isLoading,
    isLoaded: settled(ready, isLoading, error),
    error,
    reload,
  };
}

// ---------------------------------------------------------------------------
// Batch and undo/redo
// ---------------------------------------------------------------------------

/** Returns `store.batch` — the sync overload yields the `batchId` string,
 * the async overload a `Promise<string>`. */
export function useBatch(): StoreManager["batch"] {
  const { sm } = useSyncEngine();
  return useCallback(
    ((fn: () => void | Promise<void>) =>
      sm.batch(fn as () => void)) as StoreManager["batch"],
    [sm],
  );
}

export function useUndoRedo() {
  const { sm } = useSyncEngine();
  const snapshotRef = useRef({ undoDepth: 0, redoDepth: 0 });
  const subscribe = useCallback(
    (onStoreChange: () => void) => sm.transactionQueue.subscribe(onStoreChange),
    [sm],
  );
  const getSnapshot = useCallback(() => {
    const undoDepth = sm.transactionQueue.undoDepth;
    const redoDepth = sm.transactionQueue.redoDepth;
    if (
      snapshotRef.current.undoDepth !== undoDepth ||
      snapshotRef.current.redoDepth !== redoDepth
    ) {
      snapshotRef.current = { undoDepth, redoDepth };
    }
    return snapshotRef.current;
  }, [sm]);
  const { undoDepth, redoDepth } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );

  return {
    undo: useCallback(() => sm.undo(), [sm]),
    redo: useCallback(() => sm.redo(), [sm]),
    canUndo: undoDepth > 0,
    canRedo: redoDepth > 0,
  };
}

// ---------------------------------------------------------------------------
// useRelation — watch a relation object (RefCollection or BackRef)
//
//   const { data: issue }   = useRecord(store.issue, issueId);
//   const { data: comments } = useRelation(issue?.comments);  // collection → T[]
//   const { data: favorite } = useRelation(issue?.favorite);  // back-ref   → T|null
//
// Loads on mount, re-renders on invalidation. The *-to-many overload yields
// `T[]`; the back-reference overload yields `T | null`; both via
// `AsyncResource`.
// ---------------------------------------------------------------------------

export function useRelation<T extends BaseModel = BaseModel>(
  relation: LazyCollectionBase<T> | null | undefined,
  opts?: UseQueryOptions,
): AsyncResource<T[]>;
export function useRelation<T extends BaseModel = BaseModel>(
  relation: BackRef<T> | null | undefined,
  opts?: UseQueryOptions,
): AsyncResource<T | null>;
export function useRelation(
  relation:
    | LazyCollectionBase<BaseModel>
    | BackRef<BaseModel>
    | null
    | undefined,
  opts?: UseQueryOptions,
): AsyncResource<BaseModel[] | BaseModel | null> {
  const [tick, forceRender] = useState(0);
  const isBackRef = relation instanceof BackRef;
  const pause = usePaused(opts);

  // Collections expose watch() for invalidation; BackRef does not.
  useEffect(() => {
    if (relation == null || isBackRef) {
      return;
    }
    return (relation as LazyCollectionBase<BaseModel>).watch(() =>
      forceRender((n) => n + 1),
    );
  }, [relation, isBackRef]);

  useEffect(() => {
    if (!pause && relation != null && !relation.isLoaded && !relation.isLoading) {
      relation.load().then(() => forceRender((n) => n + 1));
    }
  }, [relation, tick, pause]);

  if (relation == null) {
    // Can't tell collection from back-ref at null; `[]` is the map-safe
    // default. A null back-ref reads `[]` rather than `null` — harmless
    // (consumers use `data?.x`), and the relation object is non-null
    // whenever its holding record exists.
    return {
      data: [],
      isLoading: false,
      isLoaded: false,
      error: null,
      reload: async () => {},
    };
  }

  return {
    data: isBackRef
      ? ((relation as BackRef<BaseModel>).value ?? null)
      : ((relation as LazyCollectionBase<BaseModel>).items ?? []),
    isLoading: relation.isLoading ?? false,
    isLoaded: relation.isLoaded ?? false,
    error: relation.error ?? null,
    reload: async () => {
      if (pause) {
        return;
      }
      await (isBackRef
        ? (relation as BackRef<BaseModel>).load()
        : (relation as LazyCollectionBase<BaseModel>).reload());
    },
  };
}

function useStableCallback<TParams extends unknown[], TResult>(
  callback: (...args: TParams) => TResult,
): (...args: TParams) => TResult {
  const computedRef = useRef(callback);
  const stableRef = useRef((...args: TParams) => {
    return computedRef.current(...args);
  });

  useLayoutEffect(
    function updateStableCallbackRef() {
      computedRef.current = callback;
    },
    [callback],
  );

  return stableRef.current;
}


// ---------------------------------------------------------------------------
// Public read hooks — keyed by a "handle"
//
// A handle is either a schema namespace (`store.issue`) or a decorator
// model class (`Issue`). Both resolve to a registry name; the record type
// is inferred from whichever form was passed, so the same four hooks serve
// both authoring paths with one vocabulary:
//
//   useRecord(handle, id)               → AsyncResource<T | null>
//   useRecords(handle, ids?)            → AsyncResource<T[]>
//   useRecordsByIndex(handle, key, v|v[]) → AsyncResource<T[]>
//   useRelation(record.relation)        → AsyncResource<T[] | T | null>
//
// For namespace handles the index key is constrained to the schema's
// `.indexed()` fields; for class handles it's `string`.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNamespace = EntityNamespace<any, any, any>;
// `abstract new` so both `class X` and abstract bases satisfy it.
type ModelCtor<T extends BaseModel = BaseModel> = abstract new (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...args: any[]
) => T;
type Handle = AnyNamespace | ModelCtor;

// Namespace projections, factored out so the handle types compose them
// rather than re-spelling the EntityNamespace → record/indexed-key chain.
type RecordOfNamespace<NS> =
  NS extends EntityNamespace<infer S, infer K, infer Exts>
    ? S extends SchemaDef
      ? K extends EntityKey<S>
        ? Exts extends readonly ExtensionDescriptor<S>[]
          ? RecordWithExtensions<S, K, Exts>
          : never
        : never
      : never
    : never;

type IndexKeyOfNamespace<NS> =
  NS extends EntityNamespace<infer S, infer K, infer _Exts>
    ? S extends SchemaDef
      ? K extends EntityKey<S>
        ? IndexedFieldKeys<S, K>
        : never
      : never
    : never;

/** Record type for a handle: the class instance type, or the schema's typed
 * projection for a namespace. Ctor is checked first — a namespace is a plain
 * object and never matches `ModelCtor`. */
type RecordOf<H> =
  H extends ModelCtor<infer T> ? T : RecordOfNamespace<H>;

/** Index-key constraint for a handle: schema `.indexed()` fields for a
 * namespace, unconstrained `string` for a decorator class. */
type IndexKeyOf<H> =
  H extends ModelCtor ? string : IndexKeyOfNamespace<H>;

function handleRegistryName(handle: Handle): string {
  if (typeof handle === "function") {
    // Set by @ClientModel (explicit { name } or ctor.name fallback).
    return (
      (handle as { _modelName?: string })._modelName ??
      (handle as { name: string }).name
    );
  }
  return entityNamespaceRegistryName(handle as AnyNamespace);
}

// `as unknown as` bridges `BaseModel` (what the internal name-keyed hooks
// return) and `RecordOf<H>` (the typed view of the same pooled instance).
// Same object at runtime; neither type is assignable to the other (BaseModel
// has `__mobx`/`store`; RecordOf has schema fields + extensions). One cast
// per wrapper, contained.

/** Reactive single record by id. Pool-first sync read; async backfill on miss. */
export function useRecord<H extends Handle>(
  handle: H,
  id: string | null | undefined,
  opts?: UseQueryOptions,
): AsyncResource<RecordOf<H> | null> {
  return useRecordByName(
    handleRegistryName(handle),
    id,
    opts,
  ) as unknown as AsyncResource<RecordOf<H> | null>;
}

/** Reactive list of records, optionally filtered to (and ordered by) `ids`. */
export function useRecords<H extends Handle>(
  handle: H,
  ids?: string[] | null,
  opts?: UseQueryOptions,
): AsyncResource<RecordOf<H>[]> {
  return useRecordsByName(
    handleRegistryName(handle),
    ids,
    opts,
  ) as unknown as AsyncResource<RecordOf<H>[]>;
}

/** Reactive list of records matching one value, or any of several, on a
 * foreign-key index. */
export function useRecordsByIndex<H extends Handle>(
  handle: H,
  indexKey: IndexKeyOf<H>,
  value: string | readonly string[] | null | undefined,
  opts?: UseQueryOptions,
): AsyncResource<RecordOf<H>[]> {
  return useRecordsByIndexName(
    handleRegistryName(handle),
    indexKey as string,
    value,
    opts,
  ) as unknown as AsyncResource<RecordOf<H>[]>;
}
