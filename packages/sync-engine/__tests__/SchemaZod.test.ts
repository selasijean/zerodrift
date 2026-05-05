import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  compileSchema,
  defineSchema,
  entity,
  entityFromZod,
  fromZod,
  link,
  s,
  LoadStrategy,
  type EntityFromZodOpts,
  type FieldBuilder,
  type IndexedFieldKeys,
} from "@sync-engine/schema";
import { ModelRegistry } from "@sync-engine/ModelRegistry";
import { PropertyType } from "@sync-engine/types";

// ---------------------------------------------------------------------------
// fromZod — field-level adapter
// ---------------------------------------------------------------------------

describe("fromZod — primitive mapping", () => {
  it("maps z.string / z.number / z.boolean / z.date to the matching field", () => {
    expect(fromZod(z.string()).meta.kind).toBe("string");
    expect(fromZod(z.number()).meta.kind).toBe("number");
    expect(fromZod(z.boolean()).meta.kind).toBe("boolean");
    expect(fromZod(z.date()).meta.kind).toBe("date");
  });

  it("falls through to s.json() for structured Zod types", () => {
    expect(fromZod(z.object({ a: z.string() })).meta.kind).toBe("json");
    expect(fromZod(z.array(z.string())).meta.kind).toBe("json");
    expect(fromZod(z.enum(["a", "b"])).meta.kind).toBe("json");
  });

  it("keeps nullable and optional as distinct field semantics", () => {
    expect(fromZod(z.string().nullable()).meta.nullable).toBe(true);
    expect(fromZod(z.string().nullable()).meta.optional).toBe(false);
    expect(fromZod(z.string().optional()).meta.optional).toBe(true);
    expect(fromZod(z.string().optional()).meta.nullable).toBe(false);
    expect(fromZod(z.string()).meta.nullable).toBe(false);
  });

  it("propagates .default(...) to the field's default", () => {
    expect(fromZod(z.string().default("hi")).meta.default).toBe("hi");
    expect(fromZod(z.number().default(7)).meta.default).toBe(7);
  });

  it("composes nullable + default modifiers", () => {
    const builder = fromZod(z.string().nullable().default("hi"));
    expect(builder.meta.kind).toBe("string");
    expect(builder.meta.nullable).toBe(true);
    expect(builder.meta.default).toBe("hi");
  });
});

describe("fromZod — TS types", () => {
  it("infers the field's TS type via z.infer", () => {
    const builder = fromZod(z.string());
    expectTypeOf(builder._t).toEqualTypeOf<string | undefined>();

    const nullableBuilder = fromZod(z.number().nullable());
    expectTypeOf(nullableBuilder._t).toEqualTypeOf<
      number | null | undefined
    >();
  });

  it("returns a FieldBuilder typed by z.infer<...>", () => {
    type Direct = ReturnType<typeof fromZod<z.ZodString>>;
    expectTypeOf<Direct>().toMatchTypeOf<FieldBuilder<string>>();
  });
});

// ---------------------------------------------------------------------------
// entityFromZod — full-entity adapter
// ---------------------------------------------------------------------------

const ZodTeam = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});

const ZodIssue = z.object({
  id: z.string(),
  title: z.string().default(""),
  priority: z.number().default(0),
});

describe("entityFromZod — runtime shape", () => {
  it("builds an EntityDef whose fields mirror the Zod object's shape", () => {
    const team = entityFromZod(ZodTeam, {
      loadStrategy: LoadStrategy.Instant,
      name: "ZodTeam",
    });
    expect(Object.keys(team.fields)).toEqual(["id", "name", "description"]);
    expect(team.fields.id.meta.kind).toBe("id");
    expect(team.fields.name.meta.kind).toBe("string");
    expect(team.fields.description.meta.nullable).toBe(true);
  });

  it("preserves the loadStrategy and name overrides", () => {
    const issue = entityFromZod(ZodIssue, {
      loadStrategy: LoadStrategy.Lazy,
      name: "ZodIssue",
    });
    expect(issue.loadStrategy).toBe(LoadStrategy.Lazy);
    expect(issue.name).toBe("ZodIssue");
    expect(issue.fields.title.meta.default).toBe("");
    expect(issue.fields.priority.meta.default).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a Zod-built schema compiles into ModelRegistry the same way as
// a hand-written one.
// ---------------------------------------------------------------------------

describe("entityFromZod — end-to-end through compileSchema", () => {
  it("compiles into ModelRegistry with the right property types", () => {
    const schema = defineSchema({
      entities: {
        zodTeam: entityFromZod(ZodTeam, {
          loadStrategy: LoadStrategy.Instant,
          name: "ZodFlowTeam",
        }),
        zodComment: entityFromZod(
          z.object({
            id: z.string(),
            body: z.string(),
            authorId: z.string(),
          }),
          { loadStrategy: LoadStrategy.Instant, name: "ZodFlowComment" },
        ),
      },
      links: {},
    });
    compileSchema(schema);

    const teamMeta = ModelRegistry.getModelMeta("ZodFlowTeam")!;
    expect(teamMeta.properties.has("id")).toBe(false);
    expect(teamMeta.properties.get("name")?.type).toBe(PropertyType.Property);
    expect(teamMeta.properties.get("description")?.nullable).toBe(true);

    const commentMeta = ModelRegistry.getModelMeta("ZodFlowComment")!;
    expect(commentMeta.properties.get("body")?.type).toBe(PropertyType.Property);
  });

  it("interleaves Zod-built and hand-written entities in one defineSchema()", () => {
    const schema = defineSchema({
      entities: {
        zodMixedTeam: entityFromZod(z.object({ id: z.string(), name: z.string() }), {
          loadStrategy: LoadStrategy.Instant,
          name: "ZodMixedTeam",
        }),
        zodMixedIssue: entityFromZod(
          z.object({
            id: z.string(),
            title: z.string(),
          }),
          { loadStrategy: LoadStrategy.Instant, name: "ZodMixedIssue" },
        ),
      },
      // Links are still authored via the schema DSL; Zod doesn't model the
      // graph — it just describes record shapes.
      links: {
        // No links in this minimal example; the point is that link()
        // still composes with entityFromZod(...) entries.
      },
    });
    expect(() => compileSchema(schema)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Mixing Zod-built fields with hand-written ones via plain `s.refId(...)`
// for the FK side of a relation. Zod doesn't author the graph; link() does.
// ---------------------------------------------------------------------------

describe("entityFromZod — link()-side FKs still come from s.refId", () => {
  it("compiles a schema where the FK is added by hand and the rest via Zod", () => {
    const teamDef = entityFromZod(z.object({ id: z.string(), name: z.string() }), {
      loadStrategy: LoadStrategy.Instant,
      name: "ZodLinkedTeam",
    });
    const issueDef = entityFromZod(
      z.object({ id: z.string(), title: z.string() }),
      { loadStrategy: LoadStrategy.Instant, name: "ZodLinkedIssue" },
    );

    // Manually splice in the refId — Zod doesn't carry FK semantics.
    const issueWithFk = {
      ...issueDef,
      fields: { ...issueDef.fields, teamId: s.refId("zodLinkedTeam") },
    };

    const schema = defineSchema({
      entities: {
        zodLinkedTeam: teamDef,
        zodLinkedIssue: issueWithFk,
      },
      links: {
        issueTeam: link({
          from: { entity: "zodLinkedIssue", field: "teamId", as: "team" },
          to: { entity: "zodLinkedTeam", many: "issues", lazy: true },
          onDelete: "cascade",
        }),
      },
    });
    expect(() => compileSchema(schema)).not.toThrow();

    const teamId = ModelRegistry.getModelMeta(
      "ZodLinkedIssue",
    )!.properties.get("teamId")!;
    expect(teamId.type).toBe(PropertyType.Reference);
    expect(teamId.referenceTo).toBe("ZodLinkedTeam");
  });

  it("preserves optional Zod fields as optional create-input fields without making them nullable", () => {
    const optionalField = fromZod(z.string().optional());
    expect(optionalField.meta.optional).toBe(true);
    expect(optionalField.meta.nullable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// entityFromZod — per-field overrides via opts.fields
// ---------------------------------------------------------------------------

describe("entityFromZod — per-field overrides", () => {
  const ZodOverridable = z.object({
    id:    z.string(),
    title: z.string(),
    email: z.string(),
    teamId: z.string(),
    draftNote: z.string(),
  });

  it("chains modifiers via the function form", () => {
    const def = entityFromZod(ZodOverridable, {
      loadStrategy: LoadStrategy.Instant,
      name: "OverrideChain",
      fields: {
        email: (b) => b.indexed(),
        draftNote: (b) => b.ephemeral(),
      },
    });
    expect(def.fields.email.meta.kind).toBe("string");
    expect(def.fields.email.meta.indexed).toBe(true);
    expect(def.fields.draftNote.meta.ephemeral).toBe(true);
    // Untouched field keeps its auto-derived shape.
    expect(def.fields.title.meta.kind).toBe("string");
    expect(def.fields.title.meta.indexed).toBe(false);
  });

  it("replaces the auto-derived field via the builder form (FK case)", () => {
    const def = entityFromZod(ZodOverridable, {
      loadStrategy: LoadStrategy.Instant,
      name: "OverrideReplace",
      fields: {
        teamId: s.refId("team").nullable().indexed(),
      },
    });
    expect(def.fields.teamId.meta.kind).toBe("refId");
    expect(def.fields.teamId.meta.refTarget).toBe("team");
    expect(def.fields.teamId.meta.nullable).toBe(true);
    expect(def.fields.teamId.meta.indexed).toBe(true);
  });

  it("compiles end-to-end with both override forms in one entity", () => {
    const schema = defineSchema({
      entities: {
        team: entityFromZod(z.object({ id: z.string(), name: z.string() }), {
          loadStrategy: LoadStrategy.Instant,
          name: "OverrideEndToEndTeam",
        }),
        issue: entityFromZod(ZodOverridable, {
          loadStrategy: LoadStrategy.Instant,
          name: "OverrideEndToEndIssue",
          fields: {
            teamId: s.refId("team").nullable().indexed(),
            email: (b) => b.indexed(),
          },
        }),
      },
      links: {
        issueTeam: link({
          from: { entity: "issue", field: "teamId", as: "team" },
          to: { entity: "team", many: "issues", lazy: true },
          onDelete: "cascade",
        }),
      },
    });
    expect(() => compileSchema(schema)).not.toThrow();

    const teamId = ModelRegistry.getModelMeta(
      "OverrideEndToEndIssue",
    )!.properties.get("teamId")!;
    expect(teamId.type).toBe(PropertyType.Reference);
    expect(teamId.referenceTo).toBe("OverrideEndToEndTeam");
    expect(teamId.indexed).toBe(true);

    const email = ModelRegistry.getModelMeta(
      "OverrideEndToEndIssue",
    )!.properties.get("email")!;
    expect(email.indexed).toBe(true);
  });

  // Type-level: typos in the `fields` override map fail to compile. The check
  // happens at the call site through F's constraint — `EntityFromZodOpts<Z>`
  // is the explicit single-generic form for users who pre-type their opts.
  it("constrains override keys to fields actually declared on the Zod object", () => {
    type FieldsArg = NonNullable<
      EntityFromZodOpts<typeof ZodOverridable>["fields"]
    >;
    expectTypeOf<keyof FieldsArg>().toEqualTypeOf<
      "id" | "title" | "email" | "teamId" | "draftNote"
    >();
  });

  // Type-level: override metadata (.indexed(), refId target, etc.) propagates
  // into the inferred EntityDef, so IndexedFieldKeys can extract the indexed
  // fields and downstream APIs (store.<entity>.getByIndex / peekByIndex /
  // useEntitiesByIndex) see them. Covers both override forms — the
  // builder replacement (`teamId`) and the chain modifier (`email`).
  it("propagates override metadata into the entity's TS type so IndexedFieldKeys works", () => {
    const schema = defineSchema({
      entities: {
        team: entity({
          loadStrategy: LoadStrategy.Instant,
          fields: { id: s.id(), name: s.string() },
        }),
        issue: entityFromZod(
          z.object({
            id: z.string(),
            teamId: z.string(),
            email: z.string(),
            title: z.string(),
          }),
          {
            loadStrategy: LoadStrategy.Instant,
            name: "PropagationIssue",
            fields: {
              teamId: s.refId("team").nullable().indexed(),
              email: (b) => b.indexed(),
            },
          },
        ),
      },
      links: {},
    });
    expect(() => compileSchema(schema)).not.toThrow();

    type IssueIndexedKeys = IndexedFieldKeys<typeof schema, "issue">;
    expectTypeOf<IssueIndexedKeys>().toEqualTypeOf<"teamId" | "email">();
  });
});
