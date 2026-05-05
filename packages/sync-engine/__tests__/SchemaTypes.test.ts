import { describe, expectTypeOf, it, expect } from "vitest";
import {
  defineSchema,
  entity,
  link,
  s,
  LoadStrategy,
  type InferEntity,
  type InferCreateInput,
  type InferUpdateInput,
  type RelationCollection,
} from "@sync-engine/schema";

// ---------------------------------------------------------------------------
// Reusable schema for the cross-entity inference tests
// ---------------------------------------------------------------------------

const schema = defineSchema({
  entities: {
    team: entity({
      loadStrategy: LoadStrategy.Instant,
      fields: {
        id: s.id(),
        name: s.string(),
        key: s.string(),
        createdAt: s.date(),
      },
    }),
    user: entity({
      loadStrategy: LoadStrategy.Instant,
      fields: {
        id: s.id(),
        name: s.string(),
        email: s.string().indexed(),
      },
    }),
    issue: entity({
      loadStrategy: LoadStrategy.Instant,
      fields: {
        id: s.id(),
        title: s.string(),
        description: s.string().default(""),
        priority: s.number().default(0),
        sortOrder: s.number(),
        teamId: s.refId("team").nullable().indexed(),
        assigneeId: s.refId("user").nullable(),
        creatorId: s.refId("user"),
        draftNote: s.string().ephemeral(),
      },
    }),
  },
  links: {
    issueTeam: link({
      from: { entity: "issue", field: "teamId", as: "team" },
      to: { entity: "team", many: "issues", lazy: true },
      onDelete: "cascade",
    }),
    issueAssignee: link({
      from: { entity: "issue", field: "assigneeId", as: "assignee" },
      to: { entity: "user", many: "assignedIssues", lazy: true },
      onDelete: "nullify",
    }),
    issueCreator: link({
      from: { entity: "issue", field: "creatorId", as: "creator" },
      to: { entity: "user", many: "createdIssues", lazy: true },
    }),
  },
});

type Schema = typeof schema;
type Issue = InferEntity<Schema, "issue">;
type Team = InferEntity<Schema, "team">;
type User = InferEntity<Schema, "user">;

// ---------------------------------------------------------------------------
// Field builders
// ---------------------------------------------------------------------------

describe("schema — runtime shape", () => {
  it("preserves entity and link descriptors at runtime", () => {
    expect(Object.keys(schema.entities)).toEqual(["team", "user", "issue"]);
    expect(Object.keys(schema.links)).toEqual([
      "issueTeam",
      "issueAssignee",
      "issueCreator",
    ]);

    expect(schema.entities.issue.fields.teamId.meta.kind).toBe("refId");
    expect(schema.entities.issue.fields.teamId.meta.refTarget).toBe("team");
    expect(schema.entities.issue.fields.teamId.meta.nullable).toBe(true);
    expect(schema.entities.issue.fields.teamId.meta.indexed).toBe(true);

    expect(schema.links.issueTeam.from.entity).toBe("issue");
    expect(schema.links.issueTeam.to.entity).toBe("team");
    expect(schema.links.issueTeam.onDelete).toBe("cascade");
  });
});

describe("field builders — runtime metadata", () => {
  it("captures kind and default flags", () => {
    expect(s.string().meta.kind).toBe("string");
    expect(s.number().meta.kind).toBe("number");
    expect(s.boolean().meta.kind).toBe("boolean");
    expect(s.id().meta.kind).toBe("id");
    expect(s.date().meta.kind).toBe("date");
    expect(s.json().meta.kind).toBe("json");
    expect(s.refId("team").meta.kind).toBe("refId");

    expect(s.string().meta.nullable).toBe(false);
    expect(s.string().meta.indexed).toBe(false);
    expect(s.string().meta.ephemeral).toBe(false);
  });

  it("threads modifiers through immutably", () => {
    const base = s.string();
    const nullable = base.nullable();
    const indexed = base.indexed();

    expect(base.meta.nullable).toBe(false);
    expect(nullable.meta.nullable).toBe(true);
    expect(indexed.meta.indexed).toBe(true);
  });

  it("stores refTarget on s.refId", () => {
    const meta = s.refId("team").meta;
    expect(meta.kind).toBe("refId");
    expect(meta.refTarget).toBe("team");
  });

  it("bakes ISO serializer into s.date()", () => {
    const builder = s.date();
    const iso = builder.meta.serializer?.(new Date("2026-01-01T00:00:00.000Z"));
    expect(iso).toBe("2026-01-01T00:00:00.000Z");

    const back = builder.meta.deserializer?.("2026-01-01T00:00:00.000Z");
    expect(back).toBeInstanceOf(Date);
  });

  it("captures default values on the meta", () => {
    expect(s.number().default(7).meta.default).toBe(7);
    expect(s.string().default("x").meta.default).toBe("x");
  });

  it("stores ephemeral and serializer overrides", () => {
    expect(s.string().ephemeral().meta.ephemeral).toBe(true);

    const customSerializer = (v: unknown) => `S:${String(v)}`;
    const customDeserializer = (raw: unknown) => String(raw).slice(2);
    const built = s
      .string()
      .serialize(customSerializer as (v: string) => unknown)
      .deserialize(customDeserializer as (raw: unknown) => string);
    expect(built.meta.serializer).toBe(customSerializer);
    expect(built.meta.deserializer).toBe(customDeserializer);
  });
});

describe("field builders — TS types", () => {
  it("reflects primitive TS types", () => {
    expectTypeOf(s.string()._t).toEqualTypeOf<string | undefined>();
    expectTypeOf(s.number()._t).toEqualTypeOf<number | undefined>();
    expectTypeOf(s.boolean()._t).toEqualTypeOf<boolean | undefined>();
    expectTypeOf(s.date()._t).toEqualTypeOf<Date | undefined>();
    expectTypeOf(s.id()._t).toEqualTypeOf<string | undefined>();
  });

  it("widens TS type with .nullable()", () => {
    expectTypeOf(s.string().nullable()._t).toEqualTypeOf<
      string | null | undefined
    >();
    expectTypeOf(s.number().nullable()._t).toEqualTypeOf<
      number | null | undefined
    >();
  });

  it("preserves the refTarget literal in the type", () => {
    const teamRef = s.refId("team");
    type T = NonNullable<typeof teamRef._t>;
    expectTypeOf<T>().toEqualTypeOf<string>();
    expectTypeOf(teamRef.meta.refTarget).toEqualTypeOf<"team">();
  });

  it("supports generic s.json<T>()", () => {
    interface Metadata {
      tags: string[];
    }
    expectTypeOf(s.json<Metadata>()._t).toEqualTypeOf<Metadata | undefined>();
  });
});

// ---------------------------------------------------------------------------
// InferEntity — primitive fields
// ---------------------------------------------------------------------------

describe("InferEntity — fields", () => {
  it("maps each declared field to its TS type", () => {
    expectTypeOf<Team["id"]>().toEqualTypeOf<string>();
    expectTypeOf<Team["name"]>().toEqualTypeOf<string>();
    expectTypeOf<Team["createdAt"]>().toEqualTypeOf<Date>();

    expectTypeOf<Issue["id"]>().toEqualTypeOf<string>();
    expectTypeOf<Issue["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Issue["priority"]>().toEqualTypeOf<number>();
    expectTypeOf<Issue["draftNote"]>().toEqualTypeOf<string>();
  });

  it("propagates .nullable() into the field type", () => {
    expectTypeOf<Issue["teamId"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Issue["assigneeId"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Issue["creatorId"]>().toEqualTypeOf<string>();
  });
});

// ---------------------------------------------------------------------------
// InferEntity — singular relations from links
// ---------------------------------------------------------------------------

describe("InferEntity — singular relations", () => {
  it("adds an `as`-named property for each link originating on the entity", () => {
    expectTypeOf<Issue["team"]>().toEqualTypeOf<Team | null>();
    expectTypeOf<Issue["assignee"]>().toEqualTypeOf<User | null>();
    expectTypeOf<Issue["creator"]>().toEqualTypeOf<User>();
  });

  it("derives nullability from the FK field", () => {
    // teamId is nullable -> issue.team is nullable
    expectTypeOf<Issue["team"]>().toEqualTypeOf<Team | null>();
    // creatorId is non-nullable -> issue.creator is non-nullable
    expectTypeOf<Issue["creator"]>().toEqualTypeOf<User>();
  });

  it("does not add singular-relation keys to the target entity", () => {
    // `team` (singular) should not appear on Team — only on Issue.
    expectTypeOf<Team>().not.toHaveProperty("team");
    expectTypeOf<User>().not.toHaveProperty("assignee");
    expectTypeOf<User>().not.toHaveProperty("creator");
  });
});

// ---------------------------------------------------------------------------
// InferEntity — reverse collections
// ---------------------------------------------------------------------------

describe("InferEntity — reverse collections", () => {
  it("adds a `many`-named collection for each link targeting the entity", () => {
    expectTypeOf<Team["issues"]>().toEqualTypeOf<RelationCollection<Issue>>();
    expectTypeOf<User["assignedIssues"]>().toEqualTypeOf<
      RelationCollection<Issue>
    >();
    expectTypeOf<User["createdIssues"]>().toEqualTypeOf<
      RelationCollection<Issue>
    >();
  });

  it("does not add reverse-collection keys to the source entity", () => {
    expectTypeOf<Issue>().not.toHaveProperty("issues");
    expectTypeOf<Issue>().not.toHaveProperty("assignedIssues");
  });
});

// ---------------------------------------------------------------------------
// Self-referential links
// ---------------------------------------------------------------------------

describe("self-referential links", () => {
  const selfSchema = defineSchema({
    entities: {
      issue: entity({
        loadStrategy: LoadStrategy.Instant,
        fields: {
          id: s.id(),
          title: s.string(),
          parentId: s.refId("issue").nullable(),
        },
      }),
    },
    links: {
      issueParent: link({
        from: { entity: "issue", field: "parentId", as: "parent" },
        to: { entity: "issue", many: "subtasks", lazy: true },
        onDelete: "nullify",
      }),
    },
  });

  type SelfIssue = InferEntity<typeof selfSchema, "issue">;

  it("produces both singular and reverse-collection sides on the same entity", () => {
    expect(selfSchema.links.issueParent.from.entity).toBe("issue");
    expect(selfSchema.links.issueParent.to.entity).toBe("issue");

    expectTypeOf<SelfIssue["parent"]>().toEqualTypeOf<SelfIssue | null>();
    expectTypeOf<SelfIssue["subtasks"]>().toEqualTypeOf<
      RelationCollection<SelfIssue>
    >();
  });
});

// ---------------------------------------------------------------------------
// Create / update inputs
// ---------------------------------------------------------------------------

describe("InferCreateInput / InferUpdateInput", () => {
  it("required fields are required and have field types", () => {
    type CreateIssue = InferCreateInput<Schema, "issue">;
    expectTypeOf<CreateIssue["title"]>().toEqualTypeOf<string>();
    expectTypeOf<CreateIssue["sortOrder"]>().toEqualTypeOf<number>();
    expectTypeOf<CreateIssue["creatorId"]>().toEqualTypeOf<string>();
  });

  it("nullable / defaulted / id-kind fields are optional", () => {
    type CreateIssue = InferCreateInput<Schema, "issue">;
    // nullable
    expectTypeOf<CreateIssue["teamId"]>().toEqualTypeOf<
      string | null | undefined
    >();
    // defaulted
    expectTypeOf<CreateIssue["description"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<CreateIssue["priority"]>().toEqualTypeOf<number | undefined>();
    // id-kind: BaseModel auto-assigns
    expectTypeOf<CreateIssue["id"]>().toEqualTypeOf<string | undefined>();
  });

  it("relation properties never appear in create input", () => {
    type CreateIssue = InferCreateInput<Schema, "issue">;
    expectTypeOf<CreateIssue>().not.toHaveProperty("team");
    expectTypeOf<CreateIssue>().not.toHaveProperty("issues");
  });

  it("update input is a partial of the field set", () => {
    type UpdateIssue = InferUpdateInput<Schema, "issue">;
    expectTypeOf<UpdateIssue["title"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<UpdateIssue["teamId"]>().toEqualTypeOf<
      string | null | undefined
    >();
  });
});
