/**
 * Test model fixtures.
 *
 * Decorators execute at class-definition time and register these models into
 * the global ModelRegistry singleton.  Importing this file is enough — models
 * are only registered once no matter how many test files import it.
 *
 * Relationships used to exercise every delete mode:
 *
 *   TestWorkspace ──< TestProject        cascade  (project deleted when workspace deleted)
 *   TestProject   ──< TestTask           cascade  (task deleted when project deleted)
 *   TestUser      ──< TestTask.assignee  nullify  (assigneeId set to null when user deleted)
 *   TestTask      ──> TestComment        restrict (cannot delete task while comments exist)
 *
 * BackReference cascade (SyncConnection):
 *   TestNote has @BackReference('TestTask', 'taskId')
 *   → when a delta deletes TestTask, TestNotes with taskId === task.id are removed.
 */

import { BaseModel } from "@sync-engine/BaseModel";
import {
  ClientModel,
  Property,
  Reference,
  LazyReference,
  ReferenceCollection,
  LazyReferenceCollection,
  OwnedCollection,
  BackReference,
} from "@sync-engine/decorators";
import { LoadStrategy } from "@sync-engine/types";
import type { RefCollection } from "@sync-engine/LazyCollection";
import type { OwnedRefs } from "@sync-engine/LazyOwnedCollection";
const dateSerializer = (v: Date) => (v instanceof Date ? v.toISOString() : v);
const dateDeserializer = (v: unknown) => new Date(v as string);
import { reaction } from "mobx";
import type { StoreManager } from "@sync-engine/StoreManager";
import type { IObjectPool } from "@sync-engine/types";

/**
 * Run `expr` reactively, recording every value it emits (including the initial
 * read). Returns the array and a dispose function. Replaces the
 * reaction-with-observed-array boilerplate sprinkled across reactivity tests.
 */
export function observe<T>(expr: () => T): {
  observed: T[];
  dispose: () => void;
} {
  const observed: T[] = [];
  const dispose = reaction(expr, (v) => observed.push(v), {
    fireImmediately: true,
  });
  return { observed, dispose };
}

/** Hydrate, make observable, and register a model in the given StoreManager's pool. */
export function addToPool(
  sm: StoreManager,
  modelName: string,
  model: BaseModel,
) {
  model.makeModelObservable();
  sm.objectPool.put(modelName, model);
}

/**
 * No-op IObjectPool with optional overrides. Use anywhere a test needs to
 * satisfy `BaseModel.store` without booting a real StoreManager.
 */
export function makeFakePool(
  overrides: Partial<IObjectPool> = {},
): IObjectPool {
  return {
    getById: () => undefined,
    put: () => {},
    notifyReferenceChange: () => {},
    trackModel: () => {},
    ...overrides,
  };
}

/**
 * Hydrate a model, make it observable, and set a fake store on it —
 * the minimal setup for testing an existing pool model without a real StoreManager.
 */
export function hydrateObservable(
  model: BaseModel,
  data: Record<string, unknown>,
  store: IObjectPool = makeFakePool(),
) {
  model.hydrate(data);
  model.makeModelObservable();
  model.store = store;
}

type FakeStoreManagerOverrides = {
  commitCreate?: (model: BaseModel) => void;
  commitUpdate?: (
    id: string,
    name: string,
    changes: Record<string, unknown>,
  ) => void;
};

/**
 * Returns a minimal fake StoreManager suitable for wiring BaseModel.storeManager in tests.
 * Pass overrides to spy on specific methods.
 */
export function makeFakeStoreManager(
  overrides: FakeStoreManagerOverrides = {},
): StoreManager {
  return {
    objectPool: makeFakePool(),
    commitCreate: overrides.commitCreate ?? (() => {}),
    commitUpdate: overrides.commitUpdate ?? (() => {}),
    loadCollection: async () => [],
    loadByIds: async () => [],
    loadOne: async () => null,
  } as unknown as StoreManager;
}

// ── TestWorkspace ─────────────────────────────────────────────────────────────

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestWorkspace extends BaseModel {
  @Property()
  public name = "";
}

// ── TestProject ───────────────────────────────────────────────────────────────

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestProject extends BaseModel {
  @Property()
  public title = "";

  @Property()
  public status = "";

  /** Cascade: deleting the workspace also deletes this project. */
  @Property({ indexed: true })
  public workspaceId = "";

  @LazyReference("TestWorkspace", { onDelete: "cascade" })
  public workspace: TestWorkspace;

  @LazyReferenceCollection("TestTask", { inverseOf: "projectId" })
  public tasks: RefCollection<TestTask>;
}

// ── TestUser ──────────────────────────────────────────────────────────────────

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestUser extends BaseModel {
  @Property()
  public name = "";

  @Property()
  public email = "";
}

// ── TestTask ──────────────────────────────────────────────────────────────────

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestTask extends BaseModel {
  @Property({ serializer: dateSerializer, deserializer: dateDeserializer })
  public createdAt: Date = new Date();

  @Property({ serializer: dateSerializer, deserializer: dateDeserializer })
  public updatedAt: Date = new Date();

  @Property()
  public title = "";

  @Property()
  public done = false;

  /** Cascade: deleting the project also deletes this task. */
  @Property({ indexed: true })
  public projectId = "";

  @LazyReference("TestProject", { onDelete: "cascade" })
  public project: TestProject;

  /** Nullify: deleting the user clears this field instead of deleting the task. */
  @Property({ indexed: true })
  public assigneeId: string | null = null;

  @LazyReference("TestUser", { nullable: true, onDelete: "nullify" })
  public assignee: TestUser | null;
}

// ── TestComment ───────────────────────────────────────────────────────────────

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestComment extends BaseModel {
  @Property()
  public text = "";

  /** Restrict: cannot delete a TestTask while a TestComment references it. */
  @Property({ indexed: true })
  public taskId = "";

  @LazyReference("TestTask", { onDelete: "restrict" })
  public task: TestTask;
}

// ── TestActivity (on-demand / progressive loading) ────────────────────────────
//
// LoadStrategy.Partial means this model is NOT loaded at bootstrap.
// It is fetched on demand when a collection referencing it is first accessed.

@ClientModel({ loadStrategy: LoadStrategy.Partial })
export class TestActivity extends BaseModel {
  @Property()
  public text = "";

  @Property({ indexed: true })
  public taskId = "";

  @LazyReference("TestTask")
  public task: TestTask;
}

// ── TestLayeredDriver / TestLayeredAccount (layer-scoped models) ──────────────
//
// Both share `layerId` so cross-model eviction (`evictAllByIndex`) has more
// than one type to walk.

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestLayeredDriver extends BaseModel {
  @Property()
  public name = "";

  @Property({ indexed: true })
  public layerId = "";
}

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestLayeredAccount extends BaseModel {
  @Property()
  public label = "";

  @Property({ indexed: true })
  public layerId = "";
}

// ── TestNote (BackReference cascade via SyncConnection) ───────────────────────

// ── TestMetric (ephemeral / pool-only model) ────────────────────────────────

@ClientModel({ loadStrategy: LoadStrategy.Ephemeral })
export class TestMetric extends BaseModel {
  @Property()
  public value = 0;

  @Property()
  public label = "";
}

// ── Eager hydration fixtures ──────────────────────────────────────────────────
//
// TestEagerOwner ──< TestEagerChild ──< TestEagerLeaf
// `@ReferenceCollection` is the eager variant — when an Owner is hydrated,
// its children load eagerly, and each child's leaves also load, exercising
// recursive eager hydration through makeModelObservable.

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestEagerLeaf extends BaseModel {
  @Property()
  public label = "";

  @Property({ indexed: true })
  public childId = "";
}

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestEagerChild extends BaseModel {
  @Property()
  public name = "";

  @Property({ indexed: true })
  public ownerId = "";

  @ReferenceCollection("TestEagerLeaf", { inverseOf: "childId" })
  public leaves: RefCollection<TestEagerLeaf>;
}

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestEagerOwner extends BaseModel {
  @Property()
  public name = "";

  @ReferenceCollection("TestEagerChild", { inverseOf: "ownerId" })
  public children: RefCollection<TestEagerChild>;
}

// TestEagerHolder exercises eager @Reference and eager @OwnedCollection.
//
//   refUserId  ──> TestUser     (eager Reference: pulled into the pool)
//   leafIds[]  ──> TestEagerLeaf (eager OwnedCollection)

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestEagerHolder extends BaseModel {
  @Property()
  public name = "";

  @Property({ indexed: true })
  public refUserId = "";

  @Reference("TestUser", { idField: "refUserId" })
  public refUser: TestUser;

  @Property()
  public leafIds: string[] = [];

  @OwnedCollection("TestEagerLeaf", { idsField: "leafIds" })
  public ownedLeaves: OwnedRefs<TestEagerLeaf>;
}

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestNote extends BaseModel {
  @Property()
  public content = "";

  @Property({ indexed: true })
  public taskId = "";

  @LazyReference("TestTask")
  public task: TestTask;

  /**
   * BackReference pointing to TestTask.
   * inverseOf = 'taskId'  → the property on THIS model that holds the task's id.
   *
   * SyncConnection.cascadeDelete uses this: when a TestTask delta arrives with
   * action 'D', it finds TestNotes whose taskId matches and removes them.
   */
  @BackReference("TestTask", "taskId")
  public taskRef: TestTask;
}
