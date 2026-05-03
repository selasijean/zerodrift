/**
 * Compound index-key collapse — when an adopter has flagged
 * `serverSupportsCompoundIndexKeys: true`, this wrapper inspects each
 * batched fetch and replaces N per-parent queries with one server-side
 * compound (joined) query whenever ≥ COMPOUND_FETCH_THRESHOLD requests
 * share a parent FK value.
 *
 * Example: 50 concurrent `Comment[issueId=Ix]` requests where every Issue
 * is in cycle X collapses to one `Comment[issueId.cycleId=X]` request.
 * The server resolves the dotted path via a join and returns the union;
 * `BatchModelLoader.flush` already filters each waiter's bag by direct FK
 * match (`record["issueId"] === Ix`), so callers see exactly their slice.
 *
 * Adopters without server JOIN support leave the flag unset; the engine
 * fans out per-parent (existing behavior).
 */

import type { IndexBatchFetcher, IndexQuery } from "./BatchModelLoader";
import { ModelRegistry } from "./ModelRegistry";
import { readFk, type ObjectPool } from "./ObjectPool";
import { PropertyType } from "./types";

/** Switch to a compound fetch only when at least this many pending
 * requests share a single parent FK value. Below this, the per-parent
 * fan-out wins because the compound response would over-fetch. */
export const COMPOUND_FETCH_THRESHOLD = 5;

/**
 * Wrap an `IndexBatchFetcher` so it transparently collapses sharable
 * batches into compound queries before invoking `inner`. The returned
 * fetcher has the same shape — `BatchModelLoader` doesn't know whether
 * collapse happened.
 *
 * `onCompoundFetched` (optional) fires once per synthetic compound query
 * after `inner` resolves successfully, with the per-model response bag.
 * Used by `StoreManager` to (a) write the full bag to IDB so future
 * direct lookups inside the compound's coverage area find their records,
 * and (b) record the compound key in `partialIndexCoverage` so
 * derive-on-read can short-circuit subsequent direct loads.
 */
export function wrapCompoundFetcher(
  inner: IndexBatchFetcher,
  pool: ObjectPool,
  options: {
    threshold?: number;
    onCompoundFetched?: (
      compound: IndexQuery,
      bagForModel: Record<string, unknown>[],
    ) => void | Promise<void>;
  } = {},
): IndexBatchFetcher {
  const threshold = options.threshold ?? COMPOUND_FETCH_THRESHOLD;
  return async (queries) => {
    const collapsed = collapseQueries(queries, pool, threshold);
    const result = await inner(collapsed);
    if (options.onCompoundFetched != null) {
      // A compound query is the synthetic kind we added during collapse —
      // it has a dotted `indexKey`. (Adopters never originate dotted-path
      // queries themselves; only this collapser does.)
      for (const q of collapsed) {
        if (q.indexKey.includes(".")) {
          await options.onCompoundFetched(q, result[q.modelName] ?? []);
        }
      }
    }
    return result;
  };
}

/**
 * Group `queries` by `(modelName, indexKey)` and within each group, look
 * up the parent in the pool and find a parent FK whose value is shared by
 * ≥ threshold members. Replace the sharing subset with one compound
 * query; non-sharing members stay direct. Returns the rewritten list.
 */
export function collapseQueries(
  queries: IndexQuery[],
  pool: ObjectPool,
  threshold: number = COMPOUND_FETCH_THRESHOLD,
): IndexQuery[] {
  // Early exit: no group can exceed the total query count, so when the
  // whole batch is below threshold there's nothing collapsible. (A mixed
  // batch like 4 + 6 still proceeds — total ≥ threshold; the per-bucket
  // check below handles the small group.)
  if (queries.length < threshold) {
    return queries;
  }
  const out: IndexQuery[] = [];
  const groups = new Map<string, IndexQuery[]>();
  for (const q of queries) {
    const key = `${q.modelName}|${q.indexKey}`;
    let bucket = groups.get(key);
    if (bucket == null) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(q);
  }
  for (const bucket of groups.values()) {
    if (bucket.length < threshold) {
      out.push(...bucket);
      continue;
    }
    const rewritten = collapseGroup(bucket, pool, threshold);
    out.push(...rewritten);
  }
  return out;
}

/** A bucket of `IndexQuery`s sharing `(modelName, indexKey)`. Find a
 * parent FK whose value is shared by ≥ threshold; emit one compound
 * query for that subset. Stragglers stay direct.
 *
 * NOTE: only walks one hop on the parent (e.g., Task → projectId). A
 * future revision could recurse to match Phase A's depth-3 walk
 * (Task → projectId → Project → workspaceId), enabling
 * `Comment[taskId.projectId.workspaceId=W]`. The dotted-path API on the
 * server already supports this; the rewrite logic here would need to
 * compose the path. If you change the depth here, also update
 * `StoreManager.isCoveredByCompound` — its derive-on-read walks the
 * same depth and must stay in sync, otherwise reads silently miss
 * coverage that the rewriter is now emitting. */
function collapseGroup(
  bucket: IndexQuery[],
  pool: ObjectPool,
  threshold: number,
): IndexQuery[] {
  const sample = bucket[0];
  // Resolve the parent model for this FK: child[indexKey] → Reference to which model?
  const childMeta = ModelRegistry.getModelMeta(sample.modelName);
  const fkProp = childMeta?.properties.get(sample.indexKey);
  if (fkProp?.type !== PropertyType.Reference || fkProp.referenceTo == null) {
    return bucket;
  }
  const parentModelName = fkProp.referenceTo;
  const parentMeta = ModelRegistry.getModelMeta(parentModelName);
  if (parentMeta == null) {
    return bucket;
  }
  // Collect each parent's outgoing FK values (one hop). For each
  // (fkName, value) pair, count how many members of the bucket share it.
  // Members whose parent is missing from the pool can't contribute.
  const fkCandidates: string[] = [];
  for (const prop of parentMeta.properties.values()) {
    if (prop.type === PropertyType.Reference && prop.referenceTo != null) {
      fkCandidates.push(prop.name);
    }
  }
  if (fkCandidates.length === 0) {
    return bucket;
  }
  // Map: `${fk}=${value}` → { fk, value, members }. The string key is
  // just for dedup; fk/value live inside the entry so we never parse the
  // key back out. (Compare `__partialIndexes`, which uses an IndexedDB
  // compound primary key `[modelName, indexKey, value]` for the same
  // reason — keep the structured view alongside the lookup key.)
  type Bucket = { fk: string; value: string; members: IndexQuery[] };
  const sharing = new Map<string, Bucket>();
  for (const q of bucket) {
    const parent = pool.getById(parentModelName, q.value);
    if (parent == null) {
      continue;
    }
    for (const fk of fkCandidates) {
      const v = readFk(parent, fk);
      if (v == null) {
        continue;
      }
      const key = `${fk}=${v}`;
      let entry = sharing.get(key);
      if (entry == null) {
        entry = { fk, value: v, members: [] };
        sharing.set(key, entry);
      }
      entry.members.push(q);
    }
  }
  // Pick the largest sharing set ≥ threshold. Single-pass max — ties go to
  // first-seen, which is stable enough; no need to optimize.
  let best: Bucket | null = null;
  for (const entry of sharing.values()) {
    if (entry.members.length < threshold) {
      continue;
    }
    if (best == null || entry.members.length > best.members.length) {
      best = entry;
    }
  }
  if (best == null) {
    return bucket;
  }
  // Emit one compound query + every non-member as direct.
  const collapsed: IndexQuery[] = [
    {
      modelName: sample.modelName,
      indexKey: `${sample.indexKey}.${best.fk}`,
      value: best.value,
    },
  ];
  const memberSet = new Set(best.members);
  for (const q of bucket) {
    if (!memberSet.has(q)) {
      collapsed.push(q);
    }
  }
  return collapsed;
}
