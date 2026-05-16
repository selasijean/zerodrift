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
import { dateDeserializer, dateSerializer } from "@sync-engine/serializers";
import type { RefCollection } from "@sync-engine/LazyCollection";
import type { OwnedRefs } from "@sync-engine/LazyOwnedCollection";
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
  mintId?: (instance: BaseModel) => string;
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
    getOrLoadCollection: async () => [],
    getOrLoadByIds: async () => [],
    getOrLoadById: async () => null,
    mintId: overrides.mintId ?? (() => crypto.randomUUID()),
    hasFieldTransforms: false,
    applyTransform: (_instance, _propName, value) => value,
    registerAtomicTouch: () => {},
  } as unknown as StoreManager;
}

// ── TestWorkspace ─────────────────────────────────────────────────────────────

@ClientModel({ name: "TestWorkspace", loadStrategy: LoadStrategy.Eager })
export class TestWorkspace extends BaseModel {
  @Property()
  public name = "";
}

// ── TestProject ───────────────────────────────────────────────────────────────

@ClientModel({ name: "TestProject", loadStrategy: LoadStrategy.Eager })
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

@ClientModel({ name: "TestUser", loadStrategy: LoadStrategy.Eager })
export class TestUser extends BaseModel {
  @Property()
  public name = "";

  @Property()
  public email = "";
}

// ── TestTask ──────────────────────────────────────────────────────────────────

@ClientModel({ name: "TestTask", loadStrategy: LoadStrategy.Eager })
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

@ClientModel({ name: "TestComment", loadStrategy: LoadStrategy.Eager })
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

@ClientModel({ name: "TestActivity", loadStrategy: LoadStrategy.Partial })
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

@ClientModel({ name: "TestLayeredDriver", loadStrategy: LoadStrategy.Eager })
export class TestLayeredDriver extends BaseModel {
  @Property()
  public name = "";

  @Property({ indexed: true })
  public layerId = "";
}

@ClientModel({ name: "TestLayeredAccount", loadStrategy: LoadStrategy.Eager })
export class TestLayeredAccount extends BaseModel {
  @Property()
  public label = "";

  @Property({ indexed: true })
  public layerId = "";
}

// ── TestScopedAlert / TestAlertNote (covering-index opt-in) ──────────────────
//
// TestScopedAlert exposes a lazy collection of TestAlertNotes keyed by
// `alertId`, and additionally covers the `groupId` axis. When the parent
// hydrates, the collection's loader fires one load for `alertId === alert.id`
// AND one for `groupId === alert.groupId`, unioning the results.

@ClientModel({ name: "TestScopedAlert", loadStrategy: LoadStrategy.Eager })
export class TestScopedAlert extends BaseModel {
  @Property()
  public title = "";

  @Property({ indexed: true })
  public groupId = "";

  @LazyReferenceCollection("TestAlertNote", {
    inverseOf: "alertId",
    coveringIndexes: ["groupId"],
  })
  public notes: RefCollection<TestAlertNote>;
}

@ClientModel({ name: "TestAlertNote", loadStrategy: LoadStrategy.Partial })
export class TestAlertNote extends BaseModel {
  @Property()
  public body = "";

  @Property({ indexed: true })
  public alertId = "";

  @Property({ indexed: true })
  public groupId = "";
}

// ── TestNote (BackReference cascade via SyncConnection) ───────────────────────

// ── TestMetric (ephemeral / pool-only model) ────────────────────────────────

@ClientModel({ name: "TestMetric", loadStrategy: LoadStrategy.Ephemeral })
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

@ClientModel({ name: "TestEagerLeaf", loadStrategy: LoadStrategy.Eager })
export class TestEagerLeaf extends BaseModel {
  @Property()
  public label = "";

  @Property({ indexed: true })
  public childId = "";
}

@ClientModel({ name: "TestEagerChild", loadStrategy: LoadStrategy.Eager })
export class TestEagerChild extends BaseModel {
  @Property()
  public name = "";

  @Property({ indexed: true })
  public ownerId = "";

  @ReferenceCollection("TestEagerLeaf", { inverseOf: "childId" })
  public leaves: RefCollection<TestEagerLeaf>;
}

@ClientModel({ name: "TestEagerOwner", loadStrategy: LoadStrategy.Eager })
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

@ClientModel({ name: "TestEagerHolder", loadStrategy: LoadStrategy.Eager })
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

// ── Denormalized-FK chain (auto-coveringIndexes / transient-index test bed) ──
//
// TestDenormChild has BOTH `parentId` (its direct FK) AND a denormalized
// `grandparentId` field. TestDenormParent has `grandparentId` as its own FK to
// TestDenormGrandparent. So the registry walk from TestDenormParent → child
// finds `grandparentId` as a depth-1 auto-derived covering axis.
//
// Depth-2 example: TestDenormGrandparent.greatId points to a great-grandparent;
// the child has indexed `greatId` (denormalized 2 hops). Walking from a great-
// grandparent collection of children would resolve via two pool hops.

@ClientModel({ name: "TestDenormGreatParent", loadStrategy: LoadStrategy.Eager })
export class TestDenormGreatParent extends BaseModel {
  @Property()
  public name = "";
}

@ClientModel({ name: "TestDenormGrandparent", loadStrategy: LoadStrategy.Eager })
export class TestDenormGrandparent extends BaseModel {
  @Property({ indexed: true })
  public greatId = "";

  @LazyReference("TestDenormGreatParent")
  public great: TestDenormGreatParent;
}

@ClientModel({ name: "TestDenormParent", loadStrategy: LoadStrategy.Eager })
export class TestDenormParent extends BaseModel {
  @Property({ indexed: true })
  public grandparentId = "";

  @LazyReference("TestDenormGrandparent")
  public grandparent: TestDenormGrandparent;

  @LazyReferenceCollection("TestDenormChild", { inverseOf: "parentId" })
  public children: RefCollection<TestDenormChild>;
}

@ClientModel({ name: "TestDenormChild", loadStrategy: LoadStrategy.Partial })
export class TestDenormChild extends BaseModel {
  @Property({ indexed: true })
  public parentId = "";

  /** Denormalized 1 hop — auto-derived from TestDenormParent.grandparentId. */
  @Property({ indexed: true })
  public grandparentId = "";

  /** Denormalized 2 hops — auto-derived through TestDenormGrandparent.greatId. */
  @Property({ indexed: true })
  public greatId = "";
}

// ── Abstract base class with decorated properties ──────────────────────────
//
// Verifies the side-table inheritance flow: an abstract class declaring
// @Property / @Reference / etc. is NOT registered in ModelRegistry, but
// @ClientModel concrete subclasses inherit its decorations via the
// prototype-chain drain.

export abstract class TestAbstractBase extends BaseModel {
  @Property()
  public sharedTitle = "";

  @Property({ indexed: true })
  public sharedTaskId = "";
}

@ClientModel({ name: "TestSharedSubclassA", loadStrategy: LoadStrategy.Eager })
export class TestSharedSubclassA extends TestAbstractBase {
  @Property()
  public extraA = 0;
}

@ClientModel({ name: "TestSharedSubclassB", loadStrategy: LoadStrategy.Eager })
export class TestSharedSubclassB extends TestAbstractBase {
  @Property()
  public extraB = false;
}

@ClientModel({ name: "TestNote", loadStrategy: LoadStrategy.Eager })
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
