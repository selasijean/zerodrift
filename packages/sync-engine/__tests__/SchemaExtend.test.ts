import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStore,
  defineSchema,
  entity,
  extend,
  link,
  s,
  LoadStrategy,
} from "@sync-engine/schema";
import { BaseModel } from "@sync-engine/BaseModel";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { ModelRegistry } from "@sync-engine/ModelRegistry";
import { StoreManager } from "@sync-engine/StoreManager";
import { reaction } from "mobx";

const extSchema = defineSchema({
  entities: {
    extTeam: entity({
      loadStrategy: LoadStrategy.Eager,
      fields: {
        id: s.id(),
        key: s.string(),
        name: s.string(),
      },
    }),
    extIssue: entity({
      loadStrategy: LoadStrategy.Eager,
      fields: {
        id: s.id(),
        title: s.string().default(""),
        sortOrder: s.number().default(0),
        teamId: s.refId("extTeam").nullable().indexed(),
      },
    }),
  },
  links: {
    issueTeam: link({
      from: { entity: "extIssue", field: "teamId", as: "team" },
      to: { entity: "extTeam", many: "issues", lazy: true },
      onDelete: "cascade",
    }),
  },
});

const issueBehavior = extend(extSchema, "extIssue", {
  computed: {
    identifier: (issue) =>
      `${(issue.teamId ?? "").slice(0, 4)}-${issue.sortOrder}`,
  },
  actions: {
    moveToTeam(issue, newTeamId: string) {
      issue.teamId = newTeamId;
    },
    bump(issue, by: number) {
      issue.sortOrder = issue.sortOrder + by;
    },
  },
});

const teamBehavior = extend(extSchema, {
  extTeam: {
    computed: {
      slug: (team) => team.key.toLowerCase(),
    },
  },
});

let sm: StoreManager;
let db: ReturnType<
  typeof createStore<typeof extSchema, readonly [typeof issueBehavior, typeof teamBehavior]>
>;

beforeEach(async () => {
  BaseModel.storeManager = null;
  sm = new StoreManager({
    workspaceId: crypto.randomUUID(),
    storageAdapter: new MemoryAdapter(),
    bootstrapFetcher: vi.fn().mockResolvedValue({
      lastSyncId: 0,
      subscribedSyncGroups: [],
      models: {},
    }),
  });
  await sm.database.connect();
  db = createStore({
    schema: extSchema,
    storeManager: sm,
    extensions: [issueBehavior, teamBehavior] as const,
  });
});

afterEach(async () => {
  BaseModel.storeManager = null;
  await sm.teardown();
});

// ---------------------------------------------------------------------------
// extend() shape — pure data, schema stays serializable
// ---------------------------------------------------------------------------

describe("extend — descriptor shape", () => {
  it("per-entity form returns a descriptor scoped to that entity", () => {
    expect(Object.keys(issueBehavior.byEntity)).toEqual(["extIssue"]);
    expect(issueBehavior.byEntity.extIssue?.computed?.identifier).toBeTypeOf(
      "function",
    );
    expect(issueBehavior.byEntity.extIssue?.actions?.moveToTeam).toBeTypeOf(
      "function",
    );
  });

  it("whole-schema form spreads each entry under byEntity", () => {
    expect(Object.keys(teamBehavior.byEntity)).toEqual(["extTeam"]);
    expect(teamBehavior.byEntity.extTeam?.computed?.slug).toBeTypeOf("function");
  });

  it("does not mutate the schema descriptor", () => {
    const issueFields = Object.keys(extSchema.entities.extIssue.fields);
    expect(issueFields).not.toContain("identifier");
    expect(issueFields).not.toContain("moveToTeam");
  });
});

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

describe("extend — computed", () => {
  it("exposes the computed value on instances returned from findById / create", () => {
    db.extTeam.create({ id: "team-eng", key: "ENG", name: "Engineering" });
    const issue = db.extIssue.create({
      id: "issue-1",
      sortOrder: 7,
      teamId: "team-eng",
    });
    expect(issue.identifier).toBe("team-7");

    const fromPool = db.extIssue.peek("issue-1");
    expect(fromPool?.identifier).toBe("team-7");
  });

  it("re-evaluates when an observed field changes (MobX-tracked)", () => {
    db.extTeam.create({ id: "team-design", key: "DSGN", name: "Design" });
    const issue = db.extIssue.create({
      id: "issue-react",
      sortOrder: 1,
      teamId: "team-design",
    });

    const seen: string[] = [];
    const dispose = reaction(
      () => issue.identifier,
      (value) => seen.push(value),
      { fireImmediately: true },
    );

    db.extIssue.patch("issue-react", { sortOrder: 42 });

    // computed = `${teamId.slice(0, 4)}-${sortOrder}` → "team-1" then "team-42"
    expect(seen).toContain("team-1");
    expect(seen).toContain("team-42");
    dispose();
  });

  it("computeds from a separate extend() call land on the right entity", () => {
    const team = db.extTeam.create({
      id: "team-slug",
      key: "Sales",
      name: "Sales",
    });
    expect(team.slug).toBe("sales");
  });

  it("registers each computed name on ModelMeta.computedProps", () => {
    expect(ModelRegistry.getModelMeta("ExtIssue")?.computedProps).toContain(
      "identifier",
    );
    expect(ModelRegistry.getModelMeta("ExtTeam")?.computedProps).toContain(
      "slug",
    );
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

describe("extend — actions", () => {
  it("exposes the action method on the record and mutates state", () => {
    db.extTeam.create({ id: "team-a", key: "A", name: "A" });
    db.extTeam.create({ id: "team-b", key: "B", name: "B" });
    const issue = db.extIssue.create({
      id: "issue-action",
      sortOrder: 3,
      teamId: "team-a",
    });

    issue.moveToTeam("team-b");

    expect(issue.teamId).toBe("team-b");
  });

  it("multiple actions on the same entity coexist", () => {
    db.extTeam.create({ id: "team-bump", key: "BUMP", name: "Bump" });
    const issue = db.extIssue.create({
      id: "issue-bump",
      sortOrder: 5,
      teamId: "team-bump",
    });

    issue.bump(2);
    issue.bump(3);

    expect(issue.sortOrder).toBe(10);
  });

  it("registers each action name on ModelMeta.actions", () => {
    const actions = ModelRegistry.getModelMeta("ExtIssue")?.actions;
    expect(actions).toContain("moveToTeam");
    expect(actions).toContain("bump");
  });
});

// ---------------------------------------------------------------------------
// Compose multiple extension descriptors on the same entity
// ---------------------------------------------------------------------------

describe("extend — composing multiple descriptors", () => {
  it("applies computed + action members from extensions in the same array", () => {
    const issue = db.extIssue.create({
      id: "issue-multi",
      sortOrder: 1,
      teamId: null,
    });
    expect(typeof issue.identifier).toBe("string");
    expect(typeof issue.moveToTeam).toBe("function");
    expect(typeof issue.bump).toBe("function");
  });

  it("rebinds extension implementations when createStore() runs again", () => {
    db.extTeam.create({ id: "team-rebind", key: "REB", name: "Rebind" });
    const issue = db.extIssue.create({
      id: "issue-rebind",
      sortOrder: 2,
      teamId: "team-rebind",
    });
    expect(issue.identifier).toBe("team-2");

    const replacement = extend(extSchema, "extIssue", {
      computed: {
        identifier: (record) => `replacement:${record.sortOrder}`,
      },
      actions: {
        moveToTeam(record, newTeamId: string) {
          record.teamId = `${newTeamId}:patched`;
        },
      },
    });

    const rebound = createStore({
      schema: extSchema,
      storeManager: sm,
      extensions: [replacement, teamBehavior] as const,
    });

    const reboundIssue = rebound.extIssue.peek("issue-rebind");
    expect(reboundIssue?.identifier).toBe("replacement:2");

    reboundIssue?.moveToTeam("team-next");
    expect(reboundIssue?.teamId).toBe("team-next:patched");
  });
});
