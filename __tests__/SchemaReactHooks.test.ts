import { describe, expectTypeOf, it } from "vitest";
import {
  createStore,
  defineSchema,
  entity,
  link,
  s,
  LoadStrategy,
  type EntityNamespace,
} from "@zerodrift/schema";
import {
  SyncProvider,
  useRecord,
  useRecords,
  useRecordsByIndex,
  useStore,
} from "../src/react/index";

const reactSchema = defineSchema({
  entities: {
    rxTeam: entity({
      loadStrategy: LoadStrategy.Eager,
      fields: { id: s.id(), name: s.string() },
    }),
    rxIssue: entity({
      loadStrategy: LoadStrategy.Eager,
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

type Store = ReturnType<typeof createStore<typeof reactSchema>>;
type IssueNs = Store["rxIssue"];
type TeamNs = Store["rxTeam"];

describe("useRecord* hook signatures (namespace handles)", () => {
  it("the schema fixture is well-formed", () => {
    expectTypeOf(reactSchema.entities).toHaveProperty("rxIssue");
    expectTypeOf(reactSchema.entities.rxIssue.fields.teamId.meta.kind).toEqualTypeOf<"refId">();
  });

  it("useRecord infers the record type from the namespace", () => {
    type R = ReturnType<typeof useRecord<IssueNs>>;
    expectTypeOf<R["data"]>().toMatchTypeOf<{
      id: string;
      title: string;
      teamId: string | null;
      priority: number;
    } | null>();
  });

  it("useRecords infers the array of records", () => {
    type R = ReturnType<typeof useRecords<TeamNs>>;
    expectTypeOf<R["data"]>().toMatchTypeOf<
      Array<{ id: string; name: string }>
    >();
  });

  it("useRecordsByIndex constrains the indexKey to .indexed() fields", () => {
    type IndexedArg = Parameters<typeof useRecordsByIndex<IssueNs>>[1];
    // teamId is the only indexed field on rxIssue
    expectTypeOf<IndexedArg>().toEqualTypeOf<"teamId">();
  });

  it("the namespace generic flows to the data return type", () => {
    type R = ReturnType<typeof useRecordsByIndex<IssueNs>>;
    expectTypeOf<R["data"]>().toMatchTypeOf<
      Array<{ id: string; title: string; teamId: string | null }>
    >();
  });

  it("useRecordsByIndex accepts a single value OR a values array", () => {
    type ValueArg = Parameters<typeof useRecordsByIndex<IssueNs>>[2];
    expectTypeOf<ValueArg>().toEqualTypeOf<
      string | readonly string[] | null | undefined
    >();
  });

  // Tier-0 type assertion: instantiating with a real store.<entity> type is a
  // positive test that namespace handles are accepted and inference works.
  it("the read hooks accept an EntityNamespace handle", () => {
    expectTypeOf(useRecord<IssueNs>).parameter(0).toEqualTypeOf<IssueNs>();
    expectTypeOf(useRecord<IssueNs>)
      .parameter(0)
      .toMatchTypeOf<EntityNamespace<
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        any
      >>();
  });
});

describe("useStore<S>() — typed schema-first store access", () => {
  it("returns the EntityStore matching the schema generic", () => {
    type S = ReturnType<typeof useStore<typeof reactSchema>>;
    expectTypeOf<S>().toEqualTypeOf<Store>();
    expectTypeOf<S["rxIssue"]>().toEqualTypeOf<IssueNs>();
    expectTypeOf<S["rxTeam"]>().toEqualTypeOf<TeamNs>();
    // Hands off to the same read hooks — namespace handle compatibility is
    // the contract that ties the provider, store, and hook surface together.
    expectTypeOf(useRecord<S["rxIssue"]>).parameter(0).toEqualTypeOf<IssueNs>();
  });
});

describe("<SyncProvider> prop combinations", () => {
  it("rejects `extensions` without `schema` at the type level", () => {
    type Props = Parameters<typeof SyncProvider>[0];
    // @ts-expect-error extensions are only valid when schema is also provided
    const _bad: Props = {
      config: {
        workspaceId: "ws",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transport: { bootstrapFetcher: async () => ({}) as any },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extensions: [{} as any],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      children: null as any,
    };
    void _bad;
  });
});
