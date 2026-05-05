import { describe, it, expect, afterEach } from "vitest";
import { BaseModel } from "@sync-engine/BaseModel";
import type { IObjectPool } from "@sync-engine/types";
import {
  TestTask,
  TestProject,
  hydrateObservable,
  makeFakePool,
  makeFakeStoreManager,
} from "./fixtures";

// We need BaseModel.storeManager to be null between tests so auto-commit
// doesn't fire into a stale StoreManager.
afterEach(() => {
  BaseModel.storeManager = null;
});

describe("BaseModel", () => {
  // ── construction ────────────────────────────────────────────────────────────

  describe("construction", () => {
    it("assigns a UUID id on construction", () => {
      const task = new TestTask();
      expect(task.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("each instance gets a unique id", () => {
      const ids = new Set(Array.from({ length: 20 }, () => new TestTask().id));
      expect(ids.size).toBe(20);
    });
  });

  // ── hydrate ─────────────────────────────────────────────────────────────────

  describe("hydrate()", () => {
    it("sets id and string properties from plain data", () => {
      const task = new TestTask();
      task.hydrate({ id: "task-1", title: "Fix bug", done: false });
      expect(task.id).toBe("task-1");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((task as any).__raw_title).toBe("Fix bug");
    });

    it("deserialises createdAt / updatedAt to Date objects", () => {
      const iso = "2024-01-15T10:00:00.000Z";
      const task = new TestTask();
      task.hydrate({ id: "t", createdAt: iso, updatedAt: iso });
      expect(task.createdAt).toBeInstanceOf(Date);
      expect(task.createdAt.toISOString()).toBe(iso);
    });

    it("stores @Reference FK values as __raw_<key>", () => {
      const task = new TestTask();
      task.hydrate({ id: "t", projectId: "proj-99" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((task as any).__raw_projectId).toBe("proj-99");
    });
  });

  // ── makeModelObservable ─────────────────────────────────────────────────────

  describe("makeModelObservable()", () => {
    it("enables observable flag", () => {
      const task = new TestTask();
      expect(task.__observabilityEnabled).toBe(false);
      task.makeModelObservable();
      expect(task.__observabilityEnabled).toBe(true);
    });

    it("flushes __raw_ values into MobX boxes", () => {
      const task = new TestTask();
      task.hydrate({ id: "t", title: "Hello" });
      task.makeModelObservable();
      expect(task.title).toBe("Hello");
      expect(task.__mobx["title"]).toBeDefined();
    });

    it("creates a RefCollection for @ReferenceCollection", () => {
      const proj = new TestProject();
      proj.hydrate({ id: "p1", title: "My Project" });
      proj.makeModelObservable();
      expect(proj.__collections["tasks"]).toBeDefined();
    });
  });

  // ── change tracking ─────────────────────────────────────────────────────────

  describe("propertyChanged() and hasUnsavedChanges", () => {
    it("records a change after observability is enabled", () => {
      const task = new TestTask();
      task.hydrate({ id: "t", title: "Old" });
      task.makeModelObservable();
      task.title = "New";
      expect(task.hasUnsavedChanges).toBe(true);
    });

    it("preserves the FIRST old value across multiple writes", () => {
      const task = new TestTask();
      task.hydrate({ id: "t", title: "Original" });
      task.makeModelObservable();
      task.store = makeFakePool();
      task.title = "Middle";
      task.title = "Final";
      // save() returns {oldValue: 'Original', newValue: 'Final'}
      const changes = task.save();
      expect(changes["title"].oldValue).toBe("Original");
      expect(changes["title"].newValue).toBe("Final");
    });

    it("does NOT track changes before makeModelObservable is called", () => {
      const task = new TestTask();
      task.hydrate({ id: "t", title: "A" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (task as any).__raw_title = "B"; // direct mutation, not via setter
      task.makeModelObservable();
      // No pending changes yet
      expect(task.hasUnsavedChanges).toBe(false);
    });
  });

  // ── save ────────────────────────────────────────────────────────────────────

  describe("save()", () => {
    // Wire a minimal fake store so save() takes the update path, not the create path.
    const fakeStore = makeFakePool();

    it("returns the change map and clears pending changes", () => {
      const task = new TestTask();
      task.hydrate({ id: "t", title: "Old" });
      task.makeModelObservable();
      task.store = fakeStore;
      task.title = "New";
      const changes = task.save();
      expect(changes["title"]).toEqual({ oldValue: "Old", newValue: "New" });
      expect(task.hasUnsavedChanges).toBe(false);
    });

    it("returns an empty object when nothing changed", () => {
      const task = new TestTask();
      task.hydrate({ id: "t", title: "Same" });
      task.makeModelObservable();
      task.store = fakeStore;
      const changes = task.save();
      expect(Object.keys(changes)).toHaveLength(0);
    });

    it("updates updatedAt on each save()", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t", title: "A" });
      task.makeModelObservable();
      task.store = fakeStore;
      const before = task.updatedAt;
      await new Promise((r) => setTimeout(r, 2));
      task.title = "B";
      task.save();
      expect(task.updatedAt.getTime()).toBeGreaterThan(before.getTime());
    });
  });

  // ── discardUnsavedChanges ────────────────────────────────────────────────────

  describe("discardUnsavedChanges()", () => {
    it("reverts a changed property to its pre-edit value", () => {
      const task = new TestTask();
      task.hydrate({ id: "t", title: "Original" });
      task.makeModelObservable();
      task.title = "Edited";
      expect(task.title).toBe("Edited");
      task.discardUnsavedChanges();
      expect(task.title).toBe("Original");
      expect(task.hasUnsavedChanges).toBe(false);
    });

    it("reverts multiple changed properties", () => {
      const task = new TestTask();
      task.hydrate({ id: "t", title: "Original", done: false });
      task.makeModelObservable();
      task.title = "Edited";
      task.done = true;
      task.discardUnsavedChanges();
      expect(task.title).toBe("Original");
      expect(task.done).toBe(false);
      expect(task.hasUnsavedChanges).toBe(false);
    });

    it("handles Date properties with serializer/deserializer", () => {
      const original = new Date("2025-01-01T00:00:00.000Z");
      const task = new TestTask();
      task.hydrate({ id: "t", createdAt: original.toISOString() });
      task.makeModelObservable();
      task.createdAt = new Date("2099-12-31T00:00:00.000Z");
      task.discardUnsavedChanges();
      expect(task.createdAt.getTime()).toBe(original.getTime());
    });

    it("is a no-op when there are no unsaved changes", () => {
      const task = new TestTask();
      task.hydrate({ id: "t", title: "Same" });
      task.makeModelObservable();
      task.discardUnsavedChanges();
      expect(task.title).toBe("Same");
      expect(task.hasUnsavedChanges).toBe(false);
    });

    it("reverts to the first old value even after multiple edits", () => {
      const task = new TestTask();
      task.hydrate({ id: "t", title: "First" });
      task.makeModelObservable();
      task.title = "Second";
      task.title = "Third";
      task.discardUnsavedChanges();
      expect(task.title).toBe("First");
      expect(task.hasUnsavedChanges).toBe(false);
    });
  });

  // ── assign ──────────────────────────────────────────────────────────────────

  describe("assign()", () => {
    it("bulk-assigns fields without saving", () => {
      const task = new TestTask();
      hydrateObservable(task, { id: "t", title: "Old", done: false });
      task.assign({ title: "New", done: true });
      expect(task.title).toBe("New");
      expect(task.done).toBe(true);
      expect(task.hasUnsavedChanges).toBe(true);
    });

    it("ignores non-property keys", () => {
      const task = new TestTask();
      hydrateObservable(task, { id: "t", title: "Old" });
      task.assign({ id: "other", title: "New", bogus: 123 });
      expect(task.id).toBe("t");
      expect(task.title).toBe("New");
    });

    it("works with discardUnsavedChanges to revert", () => {
      const task = new TestTask();
      hydrateObservable(task, { id: "t", title: "Original", done: false });
      task.assign({ title: "Draft", done: true });
      task.discardUnsavedChanges();
      expect(task.title).toBe("Original");
      expect(task.done).toBe(false);
      expect(task.hasUnsavedChanges).toBe(false);
    });

    it("works with save to commit", () => {
      const commits: unknown[] = [];
      BaseModel.storeManager = makeFakeStoreManager({
        commitUpdate: (_id, _name, changes) => {
          commits.push(changes);
        },
      });

      const task = new TestTask();
      hydrateObservable(task, { id: "t", title: "Old" });
      task.assign({ title: "New" });
      task.save();
      expect(commits).toHaveLength(1);
      expect(task.hasUnsavedChanges).toBe(false);
    });
  });

  // ── update ──────────────────────────────────────────────────────────────────

  describe("update()", () => {
    describe("new model (store === null)", () => {
      it("populates fields and makes them readable after makeModelObservable", () => {
        const task = new TestTask();
        task.update({ id: "t-1", title: "Hello", done: true });
        task.makeModelObservable();
        expect(task.id).toBe("t-1");
        expect(task.title).toBe("Hello");
        expect(task.done).toBe(true);
      });

      it("calls commitCreate via save()", () => {
        let created: BaseModel | null = null;
        BaseModel.storeManager = makeFakeStoreManager({
          commitCreate: (m) => {
            created = m;
          },
        });

        const task = new TestTask();
        task.update({ title: "From snapshot", done: false });
        expect(created).toBe(task);
      });
    });

    describe("existing pool model (store set)", () => {
      it("assigns @Property fields and sends changes to server", () => {
        const commits: unknown[] = [];
        BaseModel.storeManager = makeFakeStoreManager({
          commitUpdate: (_id, _name, changes) => {
            commits.push(changes);
          },
        });

        const task = new TestTask();
        hydrateObservable(task, { id: "t", title: "Old", done: false });

        task.update({ title: "New", done: true });
        expect(task.title).toBe("New");
        expect(task.done).toBe(true);
        expect(commits).toHaveLength(1);
      });

      it("assigns @Reference FK fields", () => {
        const task = new TestTask();
        hydrateObservable(task, { id: "t", projectId: "" });

        task.update({ projectId: "proj-99" });
        expect(task.projectId).toBe("proj-99");
      });

      it("ignores @ReferenceCollection keys and leaves the collection unchanged", () => {
        const proj = new TestProject();
        hydrateObservable(proj, { id: "p", title: "P" });
        const collectionBefore = proj.__collections["tasks"];

        proj.update({ tasks: [] as unknown as never });
        expect(proj.__collections["tasks"]).toBe(collectionBefore);
      });

      it("ignores unknown keys", () => {
        const task = new TestTask();
        hydrateObservable(task, { id: "t", title: "A" });

        task.update({ nonExistent: "x" } as never);
        expect(task.title).toBe("A");
      });

      it("does not change id", () => {
        const task = new TestTask();
        hydrateObservable(task, { id: "original-id", title: "A" });

        task.update({ id: "hacked-id", title: "B" } as never);
        expect(task.id).toBe("original-id");
      });

      it("batches all field assignments into a single commitUpdate with correct values", () => {
        type ChangeMap = Record<
          string,
          { oldValue: unknown; newValue: unknown }
        >;
        const commits: ChangeMap[] = [];
        BaseModel.storeManager = makeFakeStoreManager({
          commitUpdate: (_id, _name, changes) => {
            commits.push(changes as ChangeMap);
          },
        });

        const task = new TestTask();
        hydrateObservable(task, { id: "t", title: "Old", done: false });

        task.update({ title: "New", done: true });
        expect(commits).toHaveLength(1);
        expect(commits[0]["title"]).toEqual({
          oldValue: "Old",
          newValue: "New",
        });
        expect(commits[0]["done"]).toEqual({ oldValue: false, newValue: true });
      });
    });
  });

  // ── serialize ───────────────────────────────────────────────────────────────

  describe("serialize()", () => {
    it("includes id, createdAt, updatedAt and @Property fields", () => {
      const task = new TestTask();
      task.hydrate({ id: "ser-1", title: "Serialize me", done: true });
      task.makeModelObservable();
      const out = task.serialize();
      expect(out.id).toBe("ser-1");
      expect(out.title).toBe("Serialize me");
      expect(out.done).toBe(true);
    });

    it("includes Reference ID fields (e.g. projectId)", () => {
      const task = new TestTask();
      task.hydrate({ id: "t2", projectId: "proj-42" });
      task.makeModelObservable();
      const out = task.serialize();
      expect(out.projectId).toBe("proj-42");
    });

    it("excludes ReferenceModel virtual properties", () => {
      const task = new TestTask();
      task.hydrate({ id: "t3", projectId: "p" });
      task.makeModelObservable();
      // 'project' is the virtual ReferenceModel accessor — must not appear
      expect("project" in task.serialize()).toBe(false);
    });

    it("excludes ReferenceCollection properties", () => {
      const proj = new TestProject();
      proj.hydrate({ id: "p", title: "P" });
      proj.makeModelObservable();
      expect("tasks" in proj.serialize()).toBe(false);
    });
  });

  // ── @Reference virtual accessor ─────────────────────────────────────────────

  describe("@Reference getter / setter", () => {
    it("getter returns the model from store.getById when store is set", () => {
      const project = new TestProject();
      project.hydrate({ id: "proj-1", title: "P" });

      const task = new TestTask();
      task.hydrate({ id: "t", projectId: "proj-1" });
      task.makeModelObservable();

      // Simulate pool being wired as the store
      const fakeStore = makeFakePool({
        getById: (() => project) as IObjectPool["getById"],
      });
      task.store = fakeStore;

      expect(task.project).toBe(project);
    });

    it("setter sets the FK to the model's id", () => {
      const project = new TestProject();
      project.id = "proj-x";

      const task = new TestTask();
      task.hydrate({ id: "t" });
      task.makeModelObservable();
      task.project = project;

      expect(task.projectId).toBe("proj-x");
    });

    it("setter with null clears the FK", () => {
      const task = new TestTask();
      task.hydrate({ id: "t", projectId: "old" });
      task.makeModelObservable();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (task as any).project = null; // intentionally bypasses type — tests runtime null-clearing behaviour
      expect(task.projectId).toBeNull();
    });
  });

  // ── id minting via StoreManager ─────────────────────────────────────────────

  describe("id minting", () => {
    it("falls back to a UUID when no StoreManager is wired", () => {
      const task = new TestTask();
      expect(task.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("routes through storeManager.mintId when one is wired", () => {
      const calls: string[] = [];
      BaseModel.storeManager = makeFakeStoreManager({
        mintId: (instance) => {
          calls.push(instance.constructor.name);
          return "minted-id";
        },
      });

      const task = new TestTask();

      expect(task.id).toBe("minted-id");
      expect(calls).toEqual(["TestTask"]);
    });
  });
});
