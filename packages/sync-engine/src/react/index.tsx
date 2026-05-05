/**
 * React integration for the Sync Engine.
 *
 * Hooks subscribe to ObjectPool change notifications via useSyncExternalStore,
 * so a delta packet that adds, updates, or removes a model automatically
 * re-renders any component reading it through `useModel` / `useModels` /
 * `useIndexedCollection` (or directly via `useCollection` / `useBackRef`).
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
import { StoreManager, type StoreManagerConfig } from "../core/StoreManager";
import { BootstrapPhase } from "../core/types";
import { LazyCollectionBase, BackRef } from "../core/LazyCollection";
import { readFk } from "../core/ObjectPool";
import type { BaseModel } from "../core/BaseModel";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface SyncStatus {
  phase: BootstrapPhase;
  detail?: string;
  error?: string;
}

const SyncContext = createContext<{
  sm: StoreManager;
  status: SyncStatus;
} | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function SyncProvider({
  config,
  children,
  fallback,
}: {
  config: StoreManagerConfig;
  children: React.ReactNode;
  /** Shown while bootstrap is in progress. */
  fallback?: React.ReactNode;
}) {
  const [status, setStatus] = useState<SyncStatus>({
    phase: BootstrapPhase.Idle,
  });
  const smRef = useRef<StoreManager | null>(null);
  const cfgRef = useRef(config);
  cfgRef.current = config;

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

  useEffect(() => {
    let active = true;

    const sm = new StoreManager({
      ...cfgRef.current,
      onPhaseChange: (phase, detail) => {
        cfgRef.current.onPhaseChange?.(phase, detail);
        if (active) {
          setStatus({ phase, detail });
        }
      },
    });
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
    };
  }, [cfgRef.current.workspaceId]);

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
    <SyncContext.Provider value={{ sm: smRef.current, status }}>
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
 * Shared shape for the load-aware hooks: `item` / `items` / `value`
 * payload plus the lifecycle bag (`isLoading`, `error`, `reload`).
 * Internal — exposed via the individual hook return types.
 */
interface LoaderBase {
  isLoading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
}
interface LoaderItemResult<T> extends LoaderBase {
  item: T | null;
}
interface LoaderItemsResult<T> extends LoaderBase {
  items: T[];
}

/** Reactive single model by id. Pool-first sync read; async backfill on miss. */
export function useModel<T extends BaseModel = BaseModel>(
  modelName: string,
  id: string | null | undefined,
): LoaderItemResult<T> {
  const { sm, status } = useSyncEngine();
  const pool = sm.objectPool;
  const ready = status.phase === BootstrapPhase.Ready;

  const item = usePoolSnapshot(modelName, () =>
    id != null ? (pool.getById(modelName, id) ?? null) : null,
  );

  const { isLoading, error, reload } = useLoader(
    () => sm.loadOne(modelName, id!),
    ready && id != null,
    `${modelName}:${id ?? ""}`,
    // Skip the load when the pool already has the entry — instant models render
    // with isLoading: false from frame zero.
    () => id != null && pool.getById(modelName, id) == null,
  );

  return {
    item: ready ? (item as T | null) : null,
    isLoading,
    error,
    reload,
  };
}

/** Reactive list of models of a type, optionally filtered to a specific id set.
 * Without `ids`: every instance in the pool. With `ids`: just those, in the
 * order given, with async backfill for any missing from the pool. The ids
 * array is compared by content so inline literals don't cause re-fetches. */
export function useModels<T extends BaseModel = BaseModel>(
  modelName: string,
  ids?: string[] | null,
): LoaderItemsResult<T> {
  const { sm, status } = useSyncEngine();
  const pool = sm.objectPool;
  const ready = status.phase === BootstrapPhase.Ready;
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

  const { isLoading, error, reload } = useLoader(
    () => sm.loadByIds(modelName, ids ?? []),
    ready && ids != null && ids.length > 0,
    `${modelName}:${idsKey}`,
    () => ids != null && ids.some((id) => pool.getById(modelName, id) == null),
  );

  return {
    items: ready ? (items as T[]) : [],
    isLoading,
    error,
    reload,
  };
}

/** Reactive list of models matching a foreign-key index, e.g. `teamId === id`.
 * Fires `loadCollection` on first use; subsequent calls hit the cache. */
export function useIndexedCollection<T extends BaseModel = BaseModel>(
  modelName: string,
  indexKey: string,
  value: string | null | undefined,
): LoaderItemsResult<T> {
  const { sm, status } = useSyncEngine();
  const ready = status.phase === BootstrapPhase.Ready;
  const hasValue = value != null && value !== "";

  const all = usePoolSnapshot(modelName, () => sm.objectPool.getAll(modelName));

  const items = useMemo(() => {
    if (!hasValue) {
      return [];
    }
    return all.filter((m) => readFk(m, indexKey) === value);
  }, [all, indexKey, value, hasValue]);

  const { isLoading, error, reload } = useLoader(
    () => sm.loadCollection(modelName, indexKey, value!),
    ready && hasValue,
    `${modelName}:${indexKey}:${value ?? ""}`,
    () => hasValue && !sm.isCollectionLoaded(modelName, indexKey, value!),
  );

  return {
    items: ready ? (items as T[]) : [],
    isLoading,
    error,
    reload,
  };
}

// ---------------------------------------------------------------------------
// Batch and undo/redo
// ---------------------------------------------------------------------------

export function useBatch() {
  const { sm } = useSyncEngine();
  return useCallback(
    (fn: () => void | Promise<void>) => sm.batch(fn as () => void),
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
// useCollection — subscribe to a RefCollection directly
//
// The cleanest way to use ReferenceCollections in components:
//
//   const team = useModel("Team", teamId);
//   const { items, isLoading, reload } = useCollection(team?.issues);
//
// Triggers load() on mount. Re-renders when the collection is invalidated
// (e.g. delta packet adds an Issue to this team). Uses the collection's
// subscribe() method for proper reactivity.
// ---------------------------------------------------------------------------

export function useCollection<T extends BaseModel = BaseModel>(
  collection: LazyCollectionBase<T> | null | undefined,
) {
  const [tick, forceRender] = useState(0);

  // Subscribe to collection invalidation events
  useEffect(() => {
    if (collection == null) {
      return;
    }
    return collection.subscribe(() => forceRender((n) => n + 1));
  }, [collection]);

  // Trigger load on mount or after invalidation
  useEffect(() => {
    if (collection != null && !collection.isLoaded && !collection.isLoading) {
      collection.load().then(() => forceRender((n) => n + 1));
    }
  }, [collection, tick]);

  if (collection == null) {
    return {
      items: [] as T[],
      isLoading: false,
      isLoaded: false,
      error: null,
      reload: () => {},
    };
  }

  return {
    items: (collection.items ?? []) as T[],
    isLoading: collection.isLoading ?? false,
    isLoaded: collection.isLoaded ?? false,
    error: collection.error ?? null,
    reload: () => collection.reload(),
  };
}

// ---------------------------------------------------------------------------
// useBackRef — subscribe to a BackRef directly
//
//   const issue = useModel("Issue", issueId);
//   const { value: favorite, isLoading } = useBackRef(issue?.favorite);
// ---------------------------------------------------------------------------

export function useBackRef<T extends BaseModel = BaseModel>(
  backRef: BackRef<T> | null | undefined,
) {
  const [tick, forceRender] = useState(0);

  useEffect(() => {
    if (backRef != null && !backRef.isLoaded && !backRef.isLoading) {
      backRef.load().then(() => forceRender((n) => n + 1));
    }
  }, [backRef, tick]);

  if (backRef == null) {
    return {
      value: null as T | null,
      isLoading: false,
      isLoaded: false,
      error: null,
      reload: () => {},
    };
  }

  return {
    value: (backRef.value ?? null) as T | null,
    isLoading: backRef.isLoading ?? false,
    isLoaded: backRef.isLoaded ?? false,
    error: backRef.error ?? null,
    reload: () => backRef.load(),
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
// Typed schema-first hooks
//
// `useDbModel(db.<entity>, id)`, `useDbModels(db.<entity>, ids?)`, and
// `useDbIndexedCollection(db.<entity>, key, value)` are schema-aware
// counterparts of the string-keyed hooks above. They infer the record
// type from the namespace and constrain the index key against the
// schema's `.indexed()` fields. Internally they extract the registry
// name from the namespace and delegate to the same primitives.
// ---------------------------------------------------------------------------

import {
  entityNamespaceRegistryName,
  type EntityNamespace,
  type RecordWithExtensions,
} from "../schema/createDb";
import type { ExtensionDescriptor } from "../schema/extend";
import type { EntityKey, IndexedFieldKeys } from "../schema/infer";
import type { SchemaDef } from "../schema/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNamespace = EntityNamespace<any, any, any>;

type RecordOf<NS> = NS extends EntityNamespace<infer S, infer K, infer Exts>
  ? S extends SchemaDef
    ? K extends EntityKey<S>
      ? Exts extends readonly ExtensionDescriptor<S>[]
        ? RecordWithExtensions<S, K, Exts>
        : never
      : never
    : never
  : never;

type IndexedKeysOf<NS> = NS extends EntityNamespace<infer S, infer K, infer _Exts>
  ? S extends SchemaDef
    ? K extends EntityKey<S>
      ? IndexedFieldKeys<S, K>
      : never
    : never
  : never;

// `as unknown as` bridges the type-system gap between `BaseModel` (what the
// underlying string-keyed hooks return) and `RecordOf<NS>` (the schema's
// typed view of the same instance). They're literally the same object at
// runtime — `RecordOf<NS>` is a structural projection of the `BaseModel`
// in the pool — but neither type is assignable to the other (BaseModel
// has internals like `__mobx`/`store`; RecordOf has schema fields like
// `title`/`name` plus extension members). One cast per wrapper, contained.

export function useDbModel<NS extends AnyNamespace>(
  ns: NS,
  id: string | null | undefined,
): LoaderItemResult<RecordOf<NS>> {
  return useModel(entityNamespaceRegistryName(ns), id) as unknown as
    LoaderItemResult<RecordOf<NS>>;
}

export function useDbModels<NS extends AnyNamespace>(
  ns: NS,
  ids?: string[] | null,
): LoaderItemsResult<RecordOf<NS>> {
  return useModels(entityNamespaceRegistryName(ns), ids) as unknown as
    LoaderItemsResult<RecordOf<NS>>;
}

export function useDbIndexedCollection<NS extends AnyNamespace>(
  ns: NS,
  indexKey: IndexedKeysOf<NS>,
  value: string | null | undefined,
): LoaderItemsResult<RecordOf<NS>> {
  return useIndexedCollection(
    entityNamespaceRegistryName(ns),
    indexKey,
    value,
  ) as unknown as LoaderItemsResult<RecordOf<NS>>;
}
