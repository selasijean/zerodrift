import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import {
  compileSchema,
  createStore,
  defineSchema,
  entity,
  link,
  s,
  LoadStrategy,
} from "@sync-engine/schema";
import { BaseModel } from "@sync-engine/BaseModel";
import { ClientModel, Property } from "@sync-engine/decorators";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { ModelRegistry } from "@sync-engine/ModelRegistry";
import { PropertyType } from "@sync-engine/types";
import { StoreManager } from "@sync-engine/StoreManager";

// ── decorator-defined model ────────────────────────────────────────────────

@ClientModel({ name: "CoexUser", loadStrategy: LoadStrategy.Eager })
class CoexUser extends BaseModel {
  @Property()
  declare email: string;

  @Property()
  declare name: string;
}

// ── schema with one external entity (the decorator class) and one schema-owned
//     entity that links to it ──────────────────────────────────────────────

const coexSchema = defineSchema({
  entities: {
    coexUser: entity({
      // The compiler does not own this class; it's already registered by the
      // @ClientModel decorator above. The schema lists it so that other
      // entities can reference it via s.refId / link.
      external: true,
      name: "CoexUser",
      loadStrategy: LoadStrategy.Eager,
      fields: {
        id: s.id(),
      },
    }),
    coexComment: entity({
      loadStrategy: LoadStrategy.Eager,
      fields: {
        id: s.id(),
        body: s.string(),
        authorId: s.refId("coexUser").indexed(),
      },
    }),
  },
  links: {
    commentAuthor: link({
      from: { entity: "coexComment", field: "authorId", as: "author" },
      to: { entity: "coexUser", many: "comments", lazy: true },
      onDelete: "cascade",
    }),
  },
});

let sm: StoreManager;
let db: ReturnType<typeof createStore<typeof coexSchema>>;

beforeEach(async () => {
  BaseModel.storeManager = null;
  sm = makeStoreManager({
    workspaceId: crypto.randomUUID(),
    storageAdapter: new MemoryAdapter(),
    bootstrapFetcher: vi.fn().mockResolvedValue({
      lastSyncId: 0,
      subscribedSyncGroups: [],
      models: {},
    }),
  });
  await sm.database.connect();
  db = createStore({ schema: coexSchema, storeManager: sm });
});

afterEach(async () => {
  BaseModel.storeManager = null;
  await sm.teardown();
});

// ---------------------------------------------------------------------------
// Registry shape — both authoring paths coexist
// ---------------------------------------------------------------------------

describe("schema ↔ decorator coexistence", () => {
  it("compileSchema does not register a new ctor for an external entity", () => {
    const userMeta = ModelRegistry.getModelMeta("CoexUser");
    // The decorator-registered ctor is the one in the registry — schema
    // compilation must not have replaced it with a synthetic class.
    expect(userMeta?.ctor).toBe(CoexUser);
  });

  it("schema-owned entity is registered alongside the decorator class", () => {
    const commentMeta = ModelRegistry.getModelMeta("CoexComment");
    expect(commentMeta).not.toBeUndefined();
    expect(commentMeta?.properties.has("authorId")).toBe(true);
  });

  it("does not pollute the decorator class with a reverse-collection accessor", () => {
    // The schema declares `to: { entity: "coexUser", many: "comments" }` but
    // because coexUser is external, the compiler skips the to-side install.
    // CoexUser keeps the prototype the decorator built — no extra `comments`.
    const descriptor = Object.getOwnPropertyDescriptor(
      CoexUser.prototype,
      "comments",
    );
    expect(descriptor).toBeUndefined();

    const userMeta = ModelRegistry.getModelMeta("CoexUser")!;
    expect(userMeta.properties.has("comments")).toBe(false);
  });

  it("schema-owned FK targets the decorator class by registry name", () => {
    const authorId =
      ModelRegistry.getModelMeta("CoexComment")!.properties.get("authorId");
    expect(authorId?.type).toBe(PropertyType.Reference);
    expect(authorId?.referenceTo).toBe("CoexUser");
    expect(authorId?.onDelete).toBe("cascade");
  });
});

// ---------------------------------------------------------------------------
// Runtime — schema-defined record can reach the decorator-defined one via FK
// ---------------------------------------------------------------------------

describe("schema → decorator FK resolution", () => {
  it("singular relation getter resolves to the decorator instance via the pool", () => {
    // Pre-populate the pool with a decorator-defined user (mirrors what
    // bootstrap / SSE would do at runtime).
    const user = new CoexUser();
    user.hydrate({ id: "user-coex", email: "a@b.c", name: "Coex" });
    user.makeModelObservable();
    sm.objectPool.put("CoexUser", user);

    const comment = db.coexComment.create({
      id: "comment-coex",
      body: "hi",
      authorId: "user-coex",
    });

    // The schema-installed singular-relation getter resolves through the pool
    // and lands on the decorator instance — the two paths share a registry
    // name, so the lookup is identical.
    expect(comment.author).toBe(user);
  });

  it("nullifies / removes the schema record when the decorator parent is deleted", () => {
    const user = new CoexUser();
    user.hydrate({ id: "user-cascade", email: "x@y.z", name: "Cascade" });
    user.makeModelObservable();
    sm.objectPool.put("CoexUser", user);

    db.coexComment.create({
      id: "comment-cascade",
      body: "doomed",
      authorId: "user-cascade",
    });
    expect(db.coexComment.peek("comment-cascade")).toBeDefined();

    // Delete the decorator parent through the StoreManager (bypassing db.*
    // since coexUser is external — the schema typed surface doesn't expose it).
    sm.deleteModel(user);

    // onDelete: "cascade" should propagate to the schema-defined comment.
    expect(db.coexComment.peek("comment-cascade")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Validation — `external: true` requires an explicit `name`
// ---------------------------------------------------------------------------

describe("external entity validation", () => {
  it("rejects external: true without an explicit name", () => {
    expect(() =>
      compileSchema(
        defineSchema({
          entities: {
            externOrphan: entity({
              external: true,
              loadStrategy: LoadStrategy.Eager,
              fields: { id: s.id() },
            }),
          },
          links: {},
        }),
      ),
    ).toThrow(/external: true requires an explicit name/);
  });

  it("rejects external entities whose registry name is not registered", () => {
    expect(() =>
      compileSchema(
        defineSchema({
          entities: {
            missingExtern: entity({
              external: true,
              name: "DoesNotExist",
              loadStrategy: LoadStrategy.Eager,
              fields: { id: s.id() },
            }),
          },
          links: {},
        }),
      ),
    ).toThrow(/external model "DoesNotExist" is not registered/);
  });
});
