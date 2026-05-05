import { describe, expectTypeOf, it } from "vitest";
import {
  createDb,
  defineSchema,
  entity,
  link,
  s,
  LoadStrategy,
  type EntityNamespace,
} from "@sync-engine/schema";
import {
  useDbIndexedCollection,
  useDbIndexedCollections,
  useDbModel,
  useDbModels,
} from "../src/react/index";

const reactSchema = defineSchema({
  entities: {
    rxTeam: entity({
      loadStrategy: LoadStrategy.Instant,
      fields: { id: s.id(), name: s.string() },
    }),
    rxIssue: entity({
      loadStrategy: LoadStrategy.Instant,
      fields: {
        id: s.id(),
        title: s.string(),
        teamId: s.refId("rxTeam").nullable().indexed(),
        priority: s.number().default(0),
      },
    }),
  },
  links: {
    issueTeam: link({
      from: { entity: "rxIssue", field: "teamId", as: "team" },
      to: { entity: "rxTeam", many: "issues", lazy: true },
      onDelete: "cascade",
    }),
  },
});

type Db = ReturnType<typeof createDb<typeof reactSchema>>;
type IssueNs = Db["rxIssue"];
type TeamNs = Db["rxTeam"];

describe("useDb* hook signatures", () => {
  it("the schema fixture is well-formed", () => {
    expectTypeOf(reactSchema.entities).toHaveProperty("rxIssue");
    expectTypeOf(reactSchema.entities.rxIssue.fields.teamId.meta.kind).toEqualTypeOf<"refId">();
  });

  it("useDbModel infers the record type from the namespace", () => {
    type R = ReturnType<typeof useDbModel<IssueNs>>;
    expectTypeOf<R["item"]>().toMatchTypeOf<{
      id: string;
      title: string;
      teamId: string | null;
      priority: number;
    } | null>();
  });

  it("useDbModels infers the array of records", () => {
    type R = ReturnType<typeof useDbModels<TeamNs>>;
    expectTypeOf<R["items"]>().toMatchTypeOf<
      Array<{ id: string; name: string }>
    >();
  });

  it("useDbIndexedCollection constrains the indexKey to .indexed() fields", () => {
    type IndexedArg = Parameters<typeof useDbIndexedCollection<IssueNs>>[1];
    // teamId is the only indexed field on rxIssue
    expectTypeOf<IndexedArg>().toEqualTypeOf<"teamId">();
  });

  it("the namespace generic flows to the items return type", () => {
    type R = ReturnType<typeof useDbIndexedCollection<IssueNs>>;
    expectTypeOf<R["items"]>().toMatchTypeOf<
      Array<{ id: string; title: string; teamId: string | null }>
    >();
  });

  it("useDbIndexedCollections takes a values array and reuses the indexed-key constraint", () => {
    type IndexedArg = Parameters<typeof useDbIndexedCollections<IssueNs>>[1];
    type ValuesArg = Parameters<typeof useDbIndexedCollections<IssueNs>>[2];
    expectTypeOf<IndexedArg>().toEqualTypeOf<"teamId">();
    expectTypeOf<ValuesArg>().toEqualTypeOf<readonly string[] | null | undefined>();

    type R = ReturnType<typeof useDbIndexedCollections<IssueNs>>;
    expectTypeOf<R["items"]>().toMatchTypeOf<
      Array<{ id: string; title: string; teamId: string | null }>
    >();
  });

  // Tier-0 type assertion: passing an EntityNamespace at all is a positive
  // type test that the generic's inference works on a real db.<entity> value.
  it("the typed hooks accept an EntityNamespace argument", () => {
    type Accepts = (ns: IssueNs) => unknown;
    expectTypeOf(useDbModel).parameter(0).toMatchTypeOf<EntityNamespace<
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >>();
    void (null as unknown as Accepts);
  });
});
