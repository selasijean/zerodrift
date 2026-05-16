# Inverse Links and Reactivity

This doc explains how parent-side collections (`@ReferenceCollection`, `@BackReference`) stay in sync with the pool, and how `@Reference` getters become reactive to pool identity changes. Both mechanisms live entirely inside the `ObjectPool` — adopters never have to invalidate, re-fetch, or push children into parents by hand.

The design is modelled on Linear's sync engine, described publicly by Tuomas Artman at React Helsinki 2020 (~52:00–55:50 of the talk). The single sentence that captures the philosophy: **the child pushes itself into the parent's collection at the moment its foreign key resolves.**

## The Problem It Solves

The pool's `subscribe(modelName, fn)` channel and the parent's `RefCollection.items` MobX observable are two independent reactivity systems that don't natively talk to each other. Before this work, `RefCollection.items` was only mutated inside `runLoad()` — a frozen snapshot of "what was in the pool at load time." Children that arrived afterwards via SSE deltas slid into the pool around `items`; the parent's `@Computed` getters and any `observer`-wrapped components stayed stale.

The symmetric problem hit `@Reference`: its getter reads `this[idKey]` (a tracked MobX box) and then `pool.getById(...)` (an untracked Map lookup). Identity changes to the pool slot — deletes, in-place replacements — left observers reading `holder.target` stale.

## How It Works

### 1. Reactive mutators on collections

`LazyCollectionBase` (and therefore `RefCollection` / `OwnedRefs`) and `BackRef` expose three operations the pool calls into:

```typescript
attach(item: T)         // append to items / set value, idempotent on id
detach(itemId: string)  // remove from items / clear value, no-op if missing
setItems(items: T[])    // wholesale replace (used for parent-arrives-late backfill)
```

Each runs inside `runInAction` and notifies the collection's listener set. `items` is `observable.shallow` and the array reference is reassigned on every mutation, so MobX reactions tracking it (or its length, or any derived value) wake up.

### 2. The pool walks parent decls on every put/remove

The pool builds a memoized cache of *parent-side* declarations targeting each child model:

```typescript
interface InverseDecl {
  parentModelName: string;   // model holding the @ReferenceCollection / @BackReference
  parentPropName: string;    // property name on the parent ("tableBlocks", "favorite", …)
  fkName: string;            // FK field on the child ("pageId", "issueId", …)
  kind: PropertyType.ReferenceCollection | PropertyType.BackReference;
}

private inverseDeclCache = new Map<string, InverseDecl[]>();
```

The cache is built lazily on first lookup by walking `ModelRegistry.allModels()`. Because the registry is decorator-load-time only and never mutates afterwards, the cache lives for the pool's lifetime.

On `pool.put(modelName, instance)` for a new entry (`wasNew === true`):

1. **`attachInverseLinks(modelName, instance)`** — walks `inverseDeclarations(modelName)`. For each decl, reads the FK off the instance via `readFk(instance, decl.fkName)`, looks up the parent in the pool, and calls `parent.__collections[propName].attach(instance)` (or `__backRefs[propName].attach(...)` for back-references).
2. **`populateOwnedCollectionsFromPool(modelName, instance)`** — handles the *reverse* case: a parent entering after its children. Walks the new instance's *own* metadata for `@ReferenceCollection` / `@BackReference` decls and seeds them via `RefCollection.resolveFromPool` + `setItems` / `BackRef.resolveFromPool` + `attach`.
3. **`notifyModelChanged(modelName, instance.id)`** — bumps the per-id atom (see §4 below).

All three steps run inside a single `runInAction` so observers see one coherent transition.

On `pool.remove(modelName, id)`: `detachInverseLinks` (mirror of attach) + `notifyModelChanged`.

The `wasNew` gate matters. `pool.put` for an *existing* instance (the in-place hydrate path used by SSE updates) skips the inverse work — the model's own MobX boxes already report property changes, so observers don't need a duplicate poke.

### 3. FK reassignment from two paths

When a child is already in the pool and its FK *changes*, the inverse links need to re-route. There are two paths into this:

- **User setter:** `tableBlock.pageId = "p2"` goes through `defineObservableProperty.set` → MobX box update → `BaseModel.propertyChanged(propName, oldValue, newValue)`.
- **Server delta:** `applySyncAction` calls `model.hydrate(action.data)` which sets the FK box directly via `box.set(deserialized)` — bypassing the prototype setter, so `propertyChanged` never fires.

Both paths call `BaseModel.maintainParentLinks(modelName, propName, oldValue, newValue)`, which forwards to the pool:

```typescript
notifyReferenceChange(child, childModelName, fkName, oldId, newId) {
  if (oldId === newId) return;
  // Hot-path gate: skip the runInAction frame and the loop entirely when the
  // changed property isn't an `inverseOf` for any parent. propertyChanged
  // calls this for every tracked write (title, done, updatedAt, ...) — most
  // of which aren't FKs.
  if (!this.inverseFkNames(childModelName).has(fkName)) return;
  runInAction(() => {
    for (const decl of this.inverseDeclarations(childModelName)) {
      if (decl.fkName !== fkName) continue;
      if (oldId != null) this.inverseTarget(decl, oldId)?.detach(child.id);
      if (newId != null) this.inverseTarget(decl, newId)?.attach(child);
    }
  });
}
```

The `inverseFkNames` Set is a sister cache to `inverseDeclarations` — it holds the FK property names that any parent's `inverseOf` points at. For non-FK writes (the bulk of `propertyChanged` traffic), the gate is an O(1) `Set.has` and we skip the action frame entirely.

### 4. Per-id atoms for `@Reference` reactivity

`@Reference` getters need a separate path: `pool.getById(...)` is an untracked Map lookup, so observers reading `holder.target` won't wake when the target's pool slot changes without an FK change of their own. The pool maintains a per-`(modelName, id)` MobX atom map:

```typescript
private modelAtoms = new Map<string, IAtom>();

trackModel(modelName: string, id: string): void {
  const key = `${modelName}:${id}`;
  let atom = this.modelAtoms.get(key);
  const wasJustCreated = atom == null;
  if (atom == null) {
    atom = createAtom(key, undefined, () => this.modelAtoms.delete(key));
    this.modelAtoms.set(key, atom);
  }
  if (!atom.reportObserved() && wasJustCreated) {
    this.modelAtoms.delete(key); // non-reactive read — drop the atom now.
  }
}
```

The `@Reference` / `@LazyReference` getter calls `this.store?.trackModel(referenceTo, id)` *before* the `getById` lookup, registering a MobX dependency on the pool entry. The pool bumps the atom on `put` (when `wasNew`) and on `remove`, so identity changes wake observers even when the holder's FK didn't change.

Two cleanup paths keep `modelAtoms` bounded:

- **`onUnobserved` callback** — fires when a tracked atom transitions to having no observers. Set when the atom is created.
- **`wasJustCreated && !reportObserved()` check** — catches non-reactive reads (event handlers, `.toJSON()` walks, `console.log`). The atom is created, observed once with no derivation tracking, and immediately dropped.

## Order Independence

Both arrival orders work without special-casing:

```
Parent first → Children later
─────────────────────────────
1. pool.put('BlockPage', page)      → page.tableBlocks.items = []  (no children yet)
2. pool.put('TableBlock', t1)       → attachInverseLinks → page.tableBlocks.items = [t1]
3. pool.put('TableBlock', t2)       → page.tableBlocks.items = [t1, t2]

Children first → Parent later
─────────────────────────────
1. pool.put('TableBlock', t1)       → no parent in pool yet → no-op for inverse links
2. pool.put('TableBlock', t2)       → no-op
3. pool.put('BlockPage', page)      → populateOwnedCollectionsFromPool scans pool
                                       and seeds page.tableBlocks.items = [t1, t2]
```

## Required Decorator Setup

For the inverse-link machinery to work, the parent must declare a `@ReferenceCollection` or `@BackReference` with `inverseOf` matching the child's FK property name:

```typescript
class BlockPage extends BaseModel {
  @ReferenceCollection("TableBlock", { inverseOf: "pageId" })
  tableBlocks!: RefCollection<TableBlock>;
}

class TableBlock extends BaseModel {
  @Property({ indexed: true })
  pageId = "";
  // @Reference is optional — the inverse machinery walks the parent side,
  // so a plain @Property FK works too.
}
```

The pool walks parent-side declarations only. The child's FK property doesn't need to be declared as `@Reference` — a plain `@Property` works (this was the precise scenario from the original BlockPage report). The default value for `inverseOf` is `<parentModelNameCamelCased>Id`, so `@ReferenceCollection("TableBlock")` on `BlockPage` defaults to `inverseOf: "blockPageId"`.

## See Also

- **[02-object-pool.md](./02-object-pool.md)** — the pool's structure and pub/sub channel.
- **[04-lazy-loading.md](./04-lazy-loading.md)** — how `RefCollection`, `BackRef`, and `OwnedRefs` integrate with the pool.
- **[07-realtime-sync.md](./07-realtime-sync.md)** — how delta packets enter the pool.
- **[08-react-integration.md](./08-react-integration.md)** — `useRecord` / `useRecords` / `useRecordsByIndex` / `useRelation` consume the same primitives.
