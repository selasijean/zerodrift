import { describe, it, expect } from "vitest";
import { ModelRegistry } from "@sync-engine/ModelRegistry";
import { PropertyType, LoadStrategy } from "@sync-engine/types";
import { TestProject, TestTask } from "./fixtures";

describe("ModelRegistry", () => {
  // ── model registration ──────────────────────────────────────────────────────

  describe("model registration", () => {
    it("registers all fixture models by name", () => {
      const names = ModelRegistry.allModels().map((m) => m.name);
      expect(names).toContain("TestWorkspace");
      expect(names).toContain("TestProject");
      expect(names).toContain("TestTask");
      expect(names).toContain("TestUser");
      expect(names).toContain("TestComment");
    });

    it("stores the correct constructor", () => {
      expect(ModelRegistry.getModelMeta("TestProject")!.ctor).toBe(TestProject);
    });

    it("respects the loadStrategy option passed to @ClientModel", () => {
      // All fixtures use LoadStrategy.Eager
      const meta = ModelRegistry.getModelMeta("TestTask")!;
      expect(meta.loadStrategy).toBe(LoadStrategy.Eager);
    });

    it("getMetaForInstance resolves from the _modelName static tag", () => {
      const task = new TestTask();
      const meta = ModelRegistry.getMetaForInstance(task);
      expect(meta).toBeDefined();
      expect(meta!.name).toBe("TestTask");
    });

    it("returns undefined for an unregistered model name", () => {
      expect(ModelRegistry.getModelMeta("NonExistent")).toBeUndefined();
    });
  });

  // ── property registration ───────────────────────────────────────────────────

  describe("property registration", () => {
    it("@Property registers with type Property", () => {
      const prop =
        ModelRegistry.getModelMeta("TestTask")!.properties.get("title");
      expect(prop).toBeDefined();
      expect(prop!.type).toBe(PropertyType.Property);
    });

    it("@Reference registers the ID field (Reference) and the virtual accessor (ReferenceModel)", () => {
      const meta = ModelRegistry.getModelMeta("TestTask")!;

      // The persisted FK
      const idProp = meta.properties.get("projectId");
      expect(idProp).toBeDefined();
      expect(idProp!.type).toBe(PropertyType.Reference);
      expect(idProp!.referenceTo).toBe("TestProject");
      expect(idProp!.onDelete).toBe("cascade");

      // The virtual model accessor
      const modelProp = meta.properties.get("project");
      expect(modelProp).toBeDefined();
      expect(modelProp!.type).toBe(PropertyType.ReferenceModel);
    });

    it("@Reference nullable flag is recorded", () => {
      const assigneeProp =
        ModelRegistry.getModelMeta("TestTask")!.properties.get("assigneeId");
      expect(assigneeProp!.nullable).toBe(true);
      expect(assigneeProp!.onDelete).toBe("nullify");
    });

    it("@ReferenceCollection registers with the correct inverseOf key", () => {
      const prop =
        ModelRegistry.getModelMeta("TestProject")!.properties.get("tasks");
      expect(prop).toBeDefined();
      expect(prop!.type).toBe(PropertyType.ReferenceCollection);
      expect(prop!.referenceTo).toBe("TestTask");
      expect(prop!.inverseOf).toBe("projectId");
    });

    it("@BackReference registers with referenceTo and inverseOf", () => {
      const prop =
        ModelRegistry.getModelMeta("TestNote")!.properties.get("taskRef");
      expect(prop).toBeDefined();
      expect(prop!.type).toBe(PropertyType.BackReference);
      expect(prop!.referenceTo).toBe("TestTask");
      expect(prop!.inverseOf).toBe("taskId");
    });
  });

  // ── schema hash ─────────────────────────────────────────────────────────────

  describe("schemaHash", () => {
    it("returns a non-empty string", () => {
      expect(ModelRegistry.schemaHash).toBeTruthy();
    });

    it("is stable across multiple calls", () => {
      expect(ModelRegistry.schemaHash).toBe(ModelRegistry.schemaHash);
    });

    it("changes when a new model is registered", () => {
      const before = ModelRegistry.schemaHash;
      // Register a model unique to this test run
      ModelRegistry.registerModel(`__Ephemeral_${Date.now()}`, class {});
      const after = ModelRegistry.schemaHash;
      expect(after).not.toBe(before);
    });

    it("changes when property metadata changes", () => {
      const modelName = `__SchemaMeta_${Date.now()}`;
      ModelRegistry.registerModel(modelName, class {});
      ModelRegistry.registerProperty(modelName, {
        name: "teamId",
        type: PropertyType.Property,
      });
      const before = ModelRegistry.schemaHash;

      ModelRegistry.updateProperty(modelName, "teamId", {
        type: PropertyType.Reference,
        indexed: true,
        referenceTo: "TestProject",
        onDelete: "cascade",
      });

      expect(ModelRegistry.schemaHash).not.toBe(before);
    });
  });
});
