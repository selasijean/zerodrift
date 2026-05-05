import { beforeAll, describe, expect, it } from "vitest";
import {
  compileSchema,
  defineSchema,
  entity,
  link,
  s,
  LoadStrategy,
} from "@sync-engine/schema";
import { ModelRegistry } from "@sync-engine/ModelRegistry";
import { PropertyType } from "@sync-engine/types";
import type { IObjectPool, ModelMeta } from "@sync-engine/types";
import type { BaseModel } from "@sync-engine/BaseModel";

// ---------------------------------------------------------------------------
// One happy-path schema, compiled once. All "shape of registry" tests read
// from these registrations.
// ---------------------------------------------------------------------------

const happyPathSchema = defineSchema({
  entities: {
    schTeam: entity({
      loadStrategy: LoadStrategy.Instant,
      usedForPartialIndexes: true,
      fields: {
        id: s.id(),
        name: s.string(),
        createdAt: s.date(),
      },
    }),
    schUser: entity({
      loadStrategy: LoadStrategy.Instant,
      fields: {
        id: s.id(),
        email: s.string().indexed(),
        displayName: s.string().nullable(),
      },
    }),
    schIssue: entity({
      loadStrategy: LoadStrategy.Instant,
      fields: {
        id: s.id(),
        title: s.string().default(""),
        sortOrder: s.number().default(0),
        teamId: s.refId("schTeam").nullable().indexed(),
        creatorId: s.refId("schUser"),
        draftNote: s.string().ephemeral(),
      },
    }),
  },
  links: {
    issueTeam: link({
      from: { entity: "schIssue", field: "teamId", as: "team" },
      to: { entity: "schTeam", many: "issues", lazy: true },
      onDelete: "cascade",
    }),
    issueCreator: link({
      from: { entity: "schIssue", field: "creatorId", as: "creator" },
      to: { entity: "schUser", many: "createdIssues", lazy: true },
      onDelete: "nullify",
    }),
  },
});

let compiled: ReturnType<typeof compileSchema>;

beforeAll(() => {
  compiled = compileSchema(happyPathSchema);
});

function meta(name: string): ModelMeta {
  const m = ModelRegistry.getModelMeta(name);
  if (m == null) {
    throw new Error(`No registry entry for ${name}`);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

describe("compileSchema — registry shape", () => {
  it("registers every entity under its PascalCased key", () => {
    expect(compiled.modelNames).toEqual(["SchTeam", "SchUser", "SchIssue"]);
    expect(meta("SchTeam").name).toBe("SchTeam");
    expect(meta("SchUser").name).toBe("SchUser");
    expect(meta("SchIssue").name).toBe("SchIssue");
  });

  it("propagates loadStrategy and usedForPartialIndexes", () => {
    expect(meta("SchTeam").loadStrategy).toBe(LoadStrategy.Instant);
    expect(meta("SchTeam").usedForPartialIndexes).toBe(true);
    expect(meta("SchIssue").usedForPartialIndexes).toBe(false);
  });

  it("computes a non-zero schemaVersion per entity from compiled meta", () => {
    expect(meta("SchTeam").schemaVersion).toBeGreaterThan(0);
    expect(meta("SchIssue").schemaVersion).toBeGreaterThan(0);
    expect(meta("SchTeam").schemaVersion).not.toBe(meta("SchIssue").schemaVersion);
  });

  it("does not register s.id() as a property (BaseModel owns id)", () => {
    expect(meta("SchTeam").properties.has("id")).toBe(false);
    expect(meta("SchIssue").properties.has("id")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Field → PropertyMeta mapping
// ---------------------------------------------------------------------------

describe("compileSchema — field mapping", () => {
  it("maps primitives to PropertyType.Property with modifier flags", () => {
    const team = meta("SchTeam");
    expect(team.properties.get("name")?.type).toBe(PropertyType.Property);

    const user = meta("SchUser");
    expect(user.properties.get("email")?.indexed).toBe(true);
    expect(user.properties.get("displayName")?.nullable).toBe(true);
  });

  it("bakes ISO serializers into s.date() fields", () => {
    const createdAt = meta("SchTeam").properties.get("createdAt")!;
    const iso = createdAt.serializer!(new Date("2026-01-01T00:00:00.000Z"));
    expect(iso).toBe("2026-01-01T00:00:00.000Z");
    expect(createdAt.deserializer!("2026-01-01T00:00:00.000Z")).toBeInstanceOf(
      Date,
    );
  });

  it("maps .ephemeral() to PropertyType.EphemeralProperty", () => {
    const draft = meta("SchIssue").properties.get("draftNote")!;
    expect(draft.type).toBe(PropertyType.EphemeralProperty);
  });

  it("maps s.refId(...) to PropertyType.Reference with referenceTo", () => {
    const teamId = meta("SchIssue").properties.get("teamId")!;
    expect(teamId.type).toBe(PropertyType.Reference);
    expect(teamId.referenceTo).toBe("SchTeam");
    expect(teamId.indexed).toBe(true);
    expect(teamId.nullable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Link → relation metadata
// ---------------------------------------------------------------------------

describe("compileSchema — link mapping", () => {
  it("attaches onDelete and lazy=true to the FK reference", () => {
    const teamId = meta("SchIssue").properties.get("teamId")!;
    expect(teamId.onDelete).toBe("cascade");
    expect(teamId.lazy).toBe(true);

    const creatorId = meta("SchIssue").properties.get("creatorId")!;
    expect(creatorId.onDelete).toBe("nullify");
  });

  it("registers the singular relation as PropertyType.ReferenceModel", () => {
    const team = meta("SchIssue").properties.get("team")!;
    expect(team.type).toBe(PropertyType.ReferenceModel);
    expect(team.referenceTo).toBe("SchTeam");
    expect(team.idField).toBe("teamId");
  });

  it("registers the reverse collection as PropertyType.ReferenceCollection", () => {
    const issues = meta("SchTeam").properties.get("issues")!;
    expect(issues.type).toBe(PropertyType.ReferenceCollection);
    expect(issues.referenceTo).toBe("SchIssue");
    expect(issues.inverseOf).toBe("teamId");
    expect(issues.lazy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Synthetic class behavior
// ---------------------------------------------------------------------------

describe("compileSchema — synthetic class", () => {
  it("instantiates with id from BaseModel and applies field defaults", () => {
    const ctor = meta("SchIssue").ctor;
    const instance = new ctor() as BaseModel & {
      title: string;
      sortOrder: number;
      teamId: string | null;
    };
    expect(typeof instance.id).toBe("string");
    expect(instance.id.length).toBeGreaterThan(0);
    expect(instance.title).toBe("");
    expect(instance.sortOrder).toBe(0);
  });

  it("singular-relation getter reads the FK and resolves via the pool", () => {
    const issueCtor = meta("SchIssue").ctor;
    const teamCtor = meta("SchTeam").ctor;
    const team = new teamCtor() as BaseModel;
    team.id = "team-1";

    const fakePool: IObjectPool = {
      getById: <T extends BaseModel = BaseModel>(
        modelName: string,
        id: string,
      ) =>
        (modelName === "SchTeam" && id === "team-1" ? team : undefined) as
          | T
          | undefined,
      put: () => {},
      notifyReferenceChange: () => {},
      trackModel: () => {},
    };

    const issue = new issueCtor() as BaseModel & {
      teamId: string | null;
      team: BaseModel | null;
    };
    issue.store = fakePool;
    issue.teamId = "team-1";

    expect(issue.team).toBe(team);

    issue.teamId = null;
    expect(issue.team).toBe(null);
  });

  it("reverse-collection getter falls back to null when no collection is mounted", () => {
    const teamCtor = meta("SchTeam").ctor;
    const team = new teamCtor() as BaseModel & { issues: unknown };
    expect(team.issues).toBe(null);
  });

  it("singular-relation setter writes the FK from the model's id", () => {
    const issueCtor = meta("SchIssue").ctor;
    const teamCtor = meta("SchTeam").ctor;
    const team = new teamCtor() as BaseModel;
    team.id = "team-2";

    const issue = new issueCtor() as BaseModel & {
      teamId: string | null;
      team: BaseModel | null;
    };
    issue.team = team;
    expect(issue.teamId).toBe("team-2");

    issue.team = null;
    expect(issue.teamId).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Validation failures — none of these should mutate the registry
// ---------------------------------------------------------------------------

describe("compileSchema — validation failures", () => {
  it("rejects a link whose from.entity is unknown", () => {
    expect(() =>
      compileSchema(
        defineSchema({
          entities: {
            badA: entity({
              loadStrategy: LoadStrategy.Instant,
              fields: { id: s.id(), name: s.string() },
            }),
          },
          links: {
            wrong: link({
              from: { entity: "ghost", field: "name", as: "x" },
              to: { entity: "badA", many: "xs" },
            }),
          },
        }),
      ),
    ).toThrow(/from\.entity "ghost" is not a declared entity/);
  });

  it("rejects a link whose from.field doesn't exist", () => {
    expect(() =>
      compileSchema(
        defineSchema({
          entities: {
            badB: entity({
              loadStrategy: LoadStrategy.Instant,
              fields: { id: s.id(), name: s.string() },
            }),
          },
          links: {
            wrong: link({
              from: { entity: "badB", field: "missing", as: "x" },
              to: { entity: "badB", many: "xs" },
            }),
          },
        }),
      ),
    ).toThrow(/field "missing" does not exist on entity "badB"/);
  });

  it("rejects a link whose from.field is not a refId", () => {
    expect(() =>
      compileSchema(
        defineSchema({
          entities: {
            badC: entity({
              loadStrategy: LoadStrategy.Instant,
              fields: { id: s.id(), name: s.string() },
            }),
          },
          links: {
            wrong: link({
              from: { entity: "badC", field: "name", as: "x" },
              to: { entity: "badC", many: "xs" },
            }),
          },
        }),
      ),
    ).toThrow(/field "badC\.name" is string; link FKs must be declared with s\.refId/);
  });

  it("rejects a refId whose target doesn't match the link's to.entity", () => {
    expect(() =>
      compileSchema(
        defineSchema({
          entities: {
            badD: entity({
              loadStrategy: LoadStrategy.Instant,
              fields: {
                id: s.id(),
                otherId: s.refId("badE"),
              },
            }),
            badE: entity({
              loadStrategy: LoadStrategy.Instant,
              fields: { id: s.id() },
            }),
            badF: entity({
              loadStrategy: LoadStrategy.Instant,
              fields: { id: s.id() },
            }),
          },
          links: {
            wrong: link({
              from: { entity: "badD", field: "otherId", as: "other" },
              to: { entity: "badF", many: "ds" },
            }),
          },
        }),
      ),
    ).toThrow(/refId target is "badE" but link\.to\.entity is "badF"/);
  });

  it("rejects two entities that compile to the same registry name", () => {
    expect(() =>
      compileSchema(
        defineSchema({
          entities: {
            collide: entity({
              loadStrategy: LoadStrategy.Instant,
              fields: { id: s.id() },
            }),
            other: entity({
              loadStrategy: LoadStrategy.Instant,
              name: "Collide",
              fields: { id: s.id() },
            }),
          },
          links: {},
        }),
      ),
    ).toThrow(/same registry name "Collide"/);
  });

  it("rejects link.from.as that collides with a field name", () => {
    expect(() =>
      compileSchema(
        defineSchema({
          entities: {
            badG: entity({
              loadStrategy: LoadStrategy.Instant,
              fields: {
                id: s.id(),
                otherId: s.refId("badH"),
                other: s.string(),
              },
            }),
            badH: entity({
              loadStrategy: LoadStrategy.Instant,
              fields: { id: s.id() },
            }),
          },
          links: {
            wrong: link({
              from: { entity: "badG", field: "otherId", as: "other" },
              to: { entity: "badH", many: "gs" },
            }),
          },
        }),
      ),
    ).toThrow(/from\.as "other" collides with a field/);
  });

  it("rejects two links sharing the same FK field", () => {
    expect(() =>
      compileSchema(
        defineSchema({
          entities: {
            badI: entity({
              loadStrategy: LoadStrategy.Instant,
              fields: {
                id: s.id(),
                otherId: s.refId("badJ"),
              },
            }),
            badJ: entity({
              loadStrategy: LoadStrategy.Instant,
              fields: { id: s.id() },
            }),
          },
          links: {
            first: link({
              from: { entity: "badI", field: "otherId", as: "other1" },
              to: { entity: "badJ", many: "first" },
            }),
            second: link({
              from: { entity: "badI", field: "otherId", as: "other2" },
              to: { entity: "badJ", many: "second" },
            }),
          },
        }),
      ),
    ).toThrow(/FK "badI\.otherId" is referenced by 2 links/);
  });

  it.each(["batch", "undo", "redo", "undoDepth", "redoDepth"] as const)(
    "rejects entity key %s — collides with reserved db top-level",
    (reservedKey) => {
      expect(() =>
        compileSchema(
          defineSchema({
            entities: {
              [reservedKey]: entity({
                loadStrategy: LoadStrategy.Instant,
                fields: { id: s.id() },
              }),
            },
            links: {},
          }),
        ),
      ).toThrow(
        new RegExp(
          `entity key "${reservedKey}" collides with the reserved top-level \`db\\.${reservedKey}\``,
        ),
      );
    },
  );
});
