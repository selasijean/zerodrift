import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  defineSchema,
  entity,
  link,
  s,
  LoadStrategy,
} from "@sync-engine/schema";
import { BaseModel } from "@sync-engine/BaseModel";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { StoreManager } from "@sync-engine/StoreManager";

const dbSchema = defineSchema({
  entities: {
    dbTeam: entity({
      loadStrategy: LoadStrategy.Instant,
      fields: {
        id: s.id(),
        name: s.string(),
      },
    }),
    dbIssue: entity({
      loadStrategy: LoadStrategy.Instant,
      fields: {
        id: s.id(),
        title: s.string().default(""),
        sortOrder: s.number().default(0),
        teamId: s.refId("dbTeam").nullable().indexed(),
      },
    }),
  },
  links: {
    issueTeam: link({
      from: { entity: "dbIssue", field: "teamId", as: "team" },
      to: { entity: "dbTeam", many: "issues", lazy: true },
      onDelete: "cascade",
    }),
  },
});

let sm: StoreManager;
let db: ReturnType<typeof createDb<typeof dbSchema>>;

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
  db = createDb({ schema: dbSchema, storeManager: sm });
});

afterEach(async () => {
  BaseModel.storeManager = null;
  await sm.teardown();
});

// ---------------------------------------------------------------------------
// createDb shape
// ---------------------------------------------------------------------------

describe("createDb — shape", () => {
  it("exposes one namespace per entity key", () => {
    expect(typeof db.dbTeam.peek).toBe("function");
    expect(typeof db.dbTeam.create).toBe("function");
    expect(typeof db.dbTeam.update).toBe("function");
    expect(typeof db.dbTeam.delete).toBe("function");

    expect(typeof db.dbIssue.peek).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// peek
// ---------------------------------------------------------------------------

describe("createDb — peek", () => {
  it("returns null when no record is in the pool", () => {
    expect(db.dbTeam.peek("missing")).toBeNull();
  });

  it("returns the pooled record after create", () => {
    const team = db.dbTeam.create({ id: "team-1", name: "Engineering" });
    expect(db.dbTeam.peek("team-1")).toBe(team);
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("createDb — create", () => {
  it("returns an instance whose fields reflect the input", () => {
    const team = db.dbTeam.create({ id: "team-create-1", name: "Design" });
    expect(team.id).toBe("team-create-1");
    expect(team.name).toBe("Design");
  });

  it("auto-generates id when input omits it", () => {
    const team = db.dbTeam.create({ name: "Auto" });
    expect(typeof team.id).toBe("string");
    expect(team.id.length).toBeGreaterThan(0);
  });

  it("applies field defaults for omitted properties", () => {
    const issue = db.dbIssue.create({ id: "issue-1", teamId: null });
    expect(issue.title).toBe("");
    expect(issue.sortOrder).toBe(0);
  });

  it("enqueues a create transaction on the StoreManager", () => {
    expect(sm.transactionQueue.pendingCount).toBe(0);
    db.dbTeam.create({ id: "team-tx", name: "Sales" });
    expect(sm.transactionQueue.pendingCount).toBe(1);
  });

  it("places the record in the object pool", () => {
    db.dbTeam.create({ id: "team-pool", name: "Ops" });
    const fromPool = sm.objectPool.getById("DbTeam", "team-pool");
    expect(fromPool).not.toBeUndefined();
    expect((fromPool as unknown as { name: string }).name).toBe("Ops");
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("createDb — update", () => {
  it("applies a partial update and enqueues a transaction", () => {
    const team = db.dbTeam.create({ id: "team-up", name: "Old" });
    const before = sm.transactionQueue.pendingCount;

    db.dbTeam.update("team-up", { name: "New" });

    expect(team.name).toBe("New");
    expect(sm.transactionQueue.pendingCount).toBe(before + 1);
  });

  it("throws when the record is not in the pool", () => {
    expect(() => db.dbTeam.update("ghost", { name: "x" })).toThrow(
      /no record with id "ghost"/,
    );
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("createDb — delete", () => {
  it("removes the record from the pool and enqueues a delete", () => {
    db.dbTeam.create({ id: "team-del", name: "Doomed" });
    const before = sm.transactionQueue.pendingCount;

    db.dbTeam.delete("team-del");

    expect(sm.objectPool.getById("DbTeam", "team-del")).toBeUndefined();
    expect(sm.transactionQueue.pendingCount).toBeGreaterThan(before);
  });

  it("cascades through onDelete: cascade links", () => {
    db.dbTeam.create({ id: "team-cascade", name: "Casc" });
    db.dbIssue.create({
      id: "issue-cascade",
      teamId: "team-cascade",
    });
    expect(db.dbIssue.peek("issue-cascade")).not.toBeNull();

    db.dbTeam.delete("team-cascade");

    expect(db.dbIssue.peek("issue-cascade")).toBeNull();
    expect(db.dbTeam.peek("team-cascade")).toBeNull();
  });

  it("throws when the record is not in the pool", () => {
    expect(() => db.dbTeam.delete("ghost")).toThrow(
      /no record with id "ghost"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Singular relation accessor (compiled from `link(...)`)
// ---------------------------------------------------------------------------

describe("createDb — singular relations resolve via the pool", () => {
  it("issue.team returns the team after both records are in the pool", () => {
    const team = db.dbTeam.create({ id: "team-rel", name: "Linked" });
    const issue = db.dbIssue.create({
      id: "issue-rel",
      teamId: "team-rel",
    });
    expect(issue.team).toBe(team);
  });

  it("issue.team is null when teamId is null", () => {
    const issue = db.dbIssue.create({ id: "issue-detached", teamId: null });
    expect(issue.team).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------

describe("createDb — batch", () => {
  it("opens / closes a batch around the writes inside fn", () => {
    db.dbTeam.create({ id: "team-batch-1", name: "A" });
    const queue = sm.transactionQueue;
    const begin = vi.spyOn(queue, "beginBatch");
    const end = vi.spyOn(queue, "endBatch");
    const before = queue.pendingCount;

    const batchId = db.batch(() => {
      db.dbTeam.update("team-batch-1", { name: "B" });
      db.dbTeam.update("team-batch-1", { name: "C" });
    });

    expect(begin).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledExactlyOnceWith(batchId);
    expect(queue.pendingCount).toBe(before + 2);
    expect(db.dbTeam.peek("team-batch-1")?.name).toBe("C");
  });

  it("returns the batchId from a sync batch", () => {
    db.dbTeam.create({ id: "team-batch-2", name: "X" });
    const batchId = db.batch(() => {
      db.dbTeam.update("team-batch-2", { name: "Y" });
    });
    expect(typeof batchId).toBe("string");
    expect(batchId.length).toBeGreaterThan(0);
  });

  it("supports async functions and resolves to the batchId", async () => {
    db.dbTeam.create({ id: "team-batch-3", name: "P" });
    const end = vi.spyOn(sm.transactionQueue, "endBatch");

    const result = db.batch(async () => {
      db.dbTeam.update("team-batch-3", { name: "Q" });
      await Promise.resolve();
      db.dbTeam.update("team-batch-3", { name: "R" });
    });
    expect(result).toBeInstanceOf(Promise);

    const batchId = await result;
    expect(typeof batchId).toBe("string");
    expect(end).toHaveBeenCalledWith(batchId);
    expect(db.dbTeam.peek("team-batch-3")?.name).toBe("R");
  });

  it("ends the batch even when fn throws", () => {
    db.dbTeam.create({ id: "team-batch-4", name: "I" });
    const end = vi.spyOn(sm.transactionQueue, "endBatch");

    expect(() =>
      db.batch(() => {
        db.dbTeam.update("team-batch-4", { name: "J" });
        throw new Error("boom");
      }),
    ).toThrow(/boom/);

    expect(end).toHaveBeenCalledTimes(1);
    expect(db.dbTeam.peek("team-batch-4")?.name).toBe("J");
  });

  it("allows delete calls to join an outer db.batch", () => {
    db.dbTeam.create({ id: "team-batch-del", name: "Delete Me" });
    db.dbIssue.create({
      id: "issue-batch-del",
      teamId: "team-batch-del",
    });

    const queue = sm.transactionQueue;
    const begin = vi.spyOn(queue, "beginBatch");
    const end = vi.spyOn(queue, "endBatch");

    expect(() =>
      db.batch(() => {
        db.dbTeam.delete("team-batch-del");
      }),
    ).not.toThrow();

    expect(begin).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(db.dbTeam.peek("team-batch-del")).toBeNull();
    expect(db.dbIssue.peek("issue-batch-del")).toBeNull();
  });

  it("rejects nested batches instead of overwriting the active batch", () => {
    db.dbTeam.create({ id: "team-batch-nested", name: "Outer" });

    expect(() =>
      db.batch(() => {
        db.dbTeam.update("team-batch-nested", { name: "Inner" });
        db.batch(() => {
          db.dbTeam.update("team-batch-nested", { name: "NeverRuns" });
        });
      }),
    ).toThrow(/Nested batches are not supported/);

    // The outer batch still closes cleanly, so future batches can proceed.
    expect(db.dbTeam.peek("team-batch-nested")?.name).toBe("Inner");
    expect(() =>
      db.batch(() => {
        db.dbTeam.update("team-batch-nested", { name: "Recovered" });
      }),
    ).not.toThrow();
    expect(db.dbTeam.peek("team-batch-nested")?.name).toBe("Recovered");
  });
});

// ---------------------------------------------------------------------------
// peekAll
// ---------------------------------------------------------------------------

describe("createDb — peekAll", () => {
  it("returns every record currently in the pool for that entity", () => {
    expect(db.dbTeam.peekAll()).toEqual([]);

    const a = db.dbTeam.create({ id: "team-peekall-a", name: "A" });
    const b = db.dbTeam.create({ id: "team-peekall-b", name: "B" });

    const teams = db.dbTeam.peekAll();
    expect(teams).toHaveLength(2);
    expect(teams).toContain(a);
    expect(teams).toContain(b);
  });
});

// ---------------------------------------------------------------------------
// peekByIndex
// ---------------------------------------------------------------------------

describe("createDb — peekByIndex", () => {
  it("returns only pooled records where record[key] === value", () => {
    db.dbTeam.create({ id: "team-pbi-a", name: "A" });
    const issue1 = db.dbIssue.create({
      id: "issue-pbi-1",
      teamId: "team-pbi-a",
    });
    const issue2 = db.dbIssue.create({
      id: "issue-pbi-2",
      teamId: "team-pbi-a",
    });
    db.dbIssue.create({ id: "issue-pbi-3", teamId: null });

    const issues = db.dbIssue.peekByIndex("teamId", "team-pbi-a");
    expect(issues).toHaveLength(2);
    expect(issues).toContain(issue1);
    expect(issues).toContain(issue2);
  });

  it("returns [] when nothing in the pool matches", () => {
    expect(db.dbIssue.peekByIndex("teamId", "team-missing")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// refreshByIndex
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// watchAll / record.watch / relation.subscribe
// ---------------------------------------------------------------------------

describe("createDb — subscriptions", () => {
  it("watchAll fires on pool-level entity changes and unsubscribes cleanly", () => {
    const cb = vi.fn();
    const unsubscribe = db.dbTeam.watchAll(cb);

    db.dbTeam.create({ id: "team-watch-1", name: "A" });
    expect(cb).toHaveBeenCalled();

    cb.mockClear();
    unsubscribe();
    db.dbTeam.create({ id: "team-watch-2", name: "B" });
    expect(cb).not.toHaveBeenCalled();
  });

  it("watchAll only fires for the entity it subscribed to", () => {
    const teamCb = vi.fn();
    db.dbTeam.watchAll(teamCb);

    db.dbIssue.create({ id: "issue-watch-iso", teamId: null });

    expect(teamCb).not.toHaveBeenCalled();
  });

  it("watchByIndex only fires for matching mutations (predicate filter)", () => {
    const cb = vi.fn();
    db.dbIssue.watchByIndex("teamId", "team-watched", cb);

    // Non-matching create — should NOT fire.
    db.dbIssue.create({ id: "issue-other", teamId: "team-other" });
    expect(cb).not.toHaveBeenCalled();

    // Matching create — SHOULD fire.
    db.dbIssue.create({ id: "issue-match", teamId: "team-watched" });
    expect(cb).toHaveBeenCalledTimes(1);

    // Non-matching teamId=null — should NOT fire.
    cb.mockClear();
    db.dbIssue.create({ id: "issue-null", teamId: null });
    expect(cb).not.toHaveBeenCalled();
  });

  it("watchByIndex fires on remove of a matching record", () => {
    db.dbIssue.create({ id: "issue-rm", teamId: "team-rm-watch" });
    const cb = vi.fn();
    db.dbIssue.watchByIndex("teamId", "team-rm-watch", cb);

    db.dbIssue.delete("issue-rm");

    expect(cb).toHaveBeenCalled();
  });

  it("record.watch fires when the selected field changes", () => {
    const team = db.dbTeam.create({ id: "team-rw", name: "v1" });
    const cb = vi.fn();
    const unsubscribe = team.watch((t) => t.name, cb);

    db.dbTeam.update("team-rw", { name: "v2" });

    expect(cb).toHaveBeenCalledTimes(1);
    // MobX reaction passes (next, prev, Reaction) — typed signature hides the
    // third arg, so assert positionally rather than via toHaveBeenCalledWith.
    const [next, prev] = cb.mock.calls[0];
    expect(next).toBe("v2");
    expect(prev).toBe("v1");
    unsubscribe();
  });

  it("relation collection subscribe is exposed via the typed surface", () => {
    const team = db.dbTeam.create({ id: "team-coll-sub", name: "T" });
    const cb = vi.fn();
    const unsubscribe = team.issues.subscribe(cb);

    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });
});

describe("createDb — refreshByIndex", () => {
  it("delegates to StoreManager.refreshCollection (diff-based, in-place)", async () => {
    const refresh = vi.spyOn(sm, "refreshCollection").mockResolvedValue([]);

    await db.dbIssue.refreshByIndex("teamId", "team-rbi");

    expect(refresh).toHaveBeenCalledWith("DbIssue", "teamId", "team-rbi");
  });
});

// ---------------------------------------------------------------------------
// archive
// ---------------------------------------------------------------------------

describe("createDb — archive", () => {
  it("delegates to StoreManager.archiveModel", () => {
    db.dbTeam.create({ id: "team-archive-1", name: "Soft" });
    const archive = vi.spyOn(sm, "archiveModel");

    db.dbTeam.archive("team-archive-1");

    expect(archive).toHaveBeenCalledTimes(1);
  });

  it("throws when the record is not in the pool", () => {
    expect(() => db.dbTeam.archive("ghost")).toThrow(/no record with id "ghost"/);
  });
});

// ---------------------------------------------------------------------------
// async readers — get / getByIds / getByIndex / getAll
// ---------------------------------------------------------------------------

describe("createDb — async readers", () => {
  it("get(id) delegates to StoreManager.loadOne", async () => {
    const loadOne = vi.spyOn(sm, "loadOne").mockResolvedValue(null);

    const result = await db.dbTeam.get("team-load-1");

    expect(loadOne).toHaveBeenCalledWith("DbTeam", "team-load-1");
    expect(result).toBeNull();
  });

  it("getByIds delegates to StoreManager.loadByIds", async () => {
    const loadByIds = vi.spyOn(sm, "loadByIds").mockResolvedValue([]);

    await db.dbTeam.getByIds(["a", "b"]);

    expect(loadByIds).toHaveBeenCalledWith("DbTeam", ["a", "b"]);
  });

  it("getByIndex routes through StoreManager.loadCollection with the typed key", async () => {
    const loadCollection = vi
      .spyOn(sm, "loadCollection")
      .mockResolvedValue([]);

    await db.dbIssue.getByIndex("teamId", "team-idx");

    expect(loadCollection).toHaveBeenCalledWith(
      "DbIssue",
      "teamId",
      "team-idx",
    );
  });

  it("getAll() delegates to StoreManager.getOrLoadAll", async () => {
    const getOrLoadAll = vi.spyOn(sm, "getOrLoadAll").mockResolvedValue([]);

    await db.dbTeam.getAll();

    expect(getOrLoadAll).toHaveBeenCalledWith("DbTeam");
  });

  it("get(id) resolves with the pooled record without re-hitting storage", async () => {
    const team = db.dbTeam.create({ id: "team-cache-hit", name: "cached" });
    const result = await db.dbTeam.get("team-cache-hit");
    // StoreManager.loadOne is itself pool-first, so a pooled record returns
    // the same instance without touching IDB or the network.
    expect(result).toBe(team);
  });
});

// ---------------------------------------------------------------------------
// refresh / refreshAll
// ---------------------------------------------------------------------------

describe("createDb — refresh", () => {
  it("refresh(ids) delegates to StoreManager.refreshModels", async () => {
    const refreshModels = vi
      .spyOn(sm, "refreshModels")
      .mockResolvedValue([]);

    await db.dbTeam.refresh(["a", "b"]);

    expect(refreshModels).toHaveBeenCalledWith("DbTeam", ["a", "b"]);
  });

  it("refreshAll delegates to StoreManager.refreshAllOfModel", async () => {
    const refreshAll = vi
      .spyOn(sm, "refreshAllOfModel")
      .mockResolvedValue();

    await db.dbTeam.refreshAll();

    expect(refreshAll).toHaveBeenCalledWith("DbTeam");
  });
});

// ---------------------------------------------------------------------------
// record commit interface — save / hasUnsavedChanges / discardUnsavedChanges
// ---------------------------------------------------------------------------

describe("createDb — record commit interface", () => {
  it("exposes save / hasUnsavedChanges / discardUnsavedChanges on returned records", () => {
    const team = db.dbTeam.create({ id: "team-commit-1", name: "v1" });
    expect(typeof team.save).toBe("function");
    expect(typeof team.discardUnsavedChanges).toBe("function");
    expect(team.hasUnsavedChanges).toBe(false);
  });

  it("imperative writes + save() collapses to one transaction (vs two updates)", () => {
    const team = db.dbTeam.create({ id: "team-commit-2", name: "v1" });
    const before = sm.transactionQueue.pendingCount;

    team.name = "v2";
    team.name = "v3";
    expect(team.hasUnsavedChanges).toBe(true);
    team.save();

    expect(team.hasUnsavedChanges).toBe(false);
    expect(team.name).toBe("v3");
    expect(sm.transactionQueue.pendingCount).toBe(before + 1);
  });

  it("discardUnsavedChanges reverts to the last-saved value", () => {
    const team = db.dbTeam.create({ id: "team-commit-3", name: "saved" });
    team.name = "scratch";
    expect(team.hasUnsavedChanges).toBe(true);

    team.discardUnsavedChanges();

    expect(team.hasUnsavedChanges).toBe(false);
    expect(team.name).toBe("saved");
  });
});

// ---------------------------------------------------------------------------
// runUndoable
// ---------------------------------------------------------------------------

describe("createDb — runUndoable", () => {
  it("delegates to StoreManager.runUndoable and returns the wrapped value", async () => {
    const runUndoable = vi
      .spyOn(sm, "runUndoable")
      .mockResolvedValue("change-log-1");

    const result = await db.runUndoable(async () => "change-log-1", {
      actionType: "publish",
    });

    expect(runUndoable).toHaveBeenCalledTimes(1);
    expect(result).toBe("change-log-1");
  });

  it("works inside db.batch — the action joins the batch", async () => {
    const enqueueAction = vi.spyOn(sm.transactionQueue, "enqueueAction");

    // Annotate `fn` so TS picks db.batch's async overload — without it, both
    // overloads match `async () => {}` and TS picks the sync one, leaving
    // the returned Promise dangling.
    const fn: () => Promise<void> = async () => {
      db.dbTeam.create({ id: "team-undoable-batch", name: "x" });
      await db.runUndoable(async () => "remote-id");
    };
    await db.batch(fn);

    expect(enqueueAction).toHaveBeenCalledTimes(1);
    const arg = enqueueAction.mock.calls[0][0];
    expect(arg.changeLogId).toBe("remote-id");
  });
});

// ---------------------------------------------------------------------------
// undo / redo
// ---------------------------------------------------------------------------

describe("createDb — undo / redo", () => {
  it("exposes live undoDepth / redoDepth getters", () => {
    expect(db.undoDepth).toBe(0);
    expect(db.redoDepth).toBe(0);

    db.dbTeam.create({ id: "team-undo-1", name: "first" });

    expect(db.undoDepth).toBeGreaterThan(0);
    expect(db.redoDepth).toBe(0);
  });

  it("undo reverts the most recent batch and bumps redoDepth", async () => {
    db.dbTeam.create({ id: "team-undo-2", name: "before" });
    db.batch(() => {
      db.dbTeam.update("team-undo-2", { name: "after" });
    });
    expect(db.dbTeam.peek("team-undo-2")?.name).toBe("after");

    const beforeRedo = db.redoDepth;
    await db.undo();

    expect(db.dbTeam.peek("team-undo-2")?.name).toBe("before");
    expect(db.redoDepth).toBe(beforeRedo + 1);
  });

  it("redo replays the undone batch", async () => {
    db.dbTeam.create({ id: "team-undo-3", name: "v1" });
    db.dbTeam.update("team-undo-3", { name: "v2" });
    expect(db.dbTeam.peek("team-undo-3")?.name).toBe("v2");

    await db.undo();
    expect(db.dbTeam.peek("team-undo-3")?.name).toBe("v1");

    await db.redo();
    expect(db.dbTeam.peek("team-undo-3")?.name).toBe("v2");
    expect(db.redoDepth).toBe(0);
  });

  it("delegates to the StoreManager's undo / redo", async () => {
    const undoSpy = vi.spyOn(sm, "undo");
    const redoSpy = vi.spyOn(sm, "redo");

    db.dbTeam.create({ id: "team-undo-4", name: "x" });
    await db.undo();
    await db.redo();

    expect(undoSpy).toHaveBeenCalledTimes(1);
    expect(redoSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

describe("createDb — seed", () => {
  it("hydrates records into the pool without enqueuing transactions", () => {
    const before = sm.transactionQueue.pendingCount;
    const seeded = db.dbTeam.seed([
      { id: "team-seed-1", name: "Seeded A" },
      { id: "team-seed-2", name: "Seeded B" },
    ]);

    expect(seeded).toHaveLength(2);
    expect(seeded[0].name).toBe("Seeded A");
    expect(db.dbTeam.peek("team-seed-1")).toBe(seeded[0]);
    expect(sm.transactionQueue.pendingCount).toBe(before);
  });

  it("re-seeding the same id refreshes that instance in place", () => {
    const [first] = db.dbTeam.seed([{ id: "team-seed-3", name: "v1" }]);
    const [second] = db.dbTeam.seed([{ id: "team-seed-3", name: "v2" }]);

    expect(second).toBe(first);
    expect(second.name).toBe("v2");
  });

  it("seeded relations resolve through the pool the same way create-d ones do", () => {
    const [team] = db.dbTeam.seed([{ id: "team-seed-rel", name: "Link" }]);
    const [issue] = db.dbIssue.seed([
      {
        id: "issue-seed-rel",
        title: "via seed",
        sortOrder: 0,
        teamId: "team-seed-rel",
      },
    ]);
    expect(issue.team).toBe(team);
  });
});
