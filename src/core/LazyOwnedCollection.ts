/**
 * OwnedRefs — many-to-many where the parent owns the list of IDs.
 *
 * Contrast with RefCollection, where the *child* holds the foreign key (e.g.
 * Issue has teamId). Here the parent holds the array.
 *
 * Resolution:
 *   - resolveFromPool: looks up each ID via pool.getById — synchronous
 *   - load: fetches missing IDs from IDB via the wired loader — async
 *
 * Usage:
 *   @Property()
 *   public issueIds: string[] = [];
 *
 *   @OwnedCollection("Issue", { idsField: "issueIds" })
 *   public issues: OwnedRefs<Issue>;
 */

import { runInAction } from "mobx";
import type { BaseModel } from "./BaseModel.js";
import { LazyCollectionBase, CollectionState } from "./LazyCollection.js";

export class OwnedRefs<
  T extends BaseModel = BaseModel,
> extends LazyCollectionBase<T> {
  /** Live getter — reads the current IDs array from the parent model each call. */
  private idsGetter: () => string[];

  private loader: ((modelName: string, ids: string[]) => Promise<T[]>) | null =
    null;

  constructor(referencedModelName: string, idsGetter: () => string[]) {
    super(referencedModelName);
    this.idsGetter = idsGetter;
  }

  /** Wire the loader. Called by StoreManager during makeModelObservable(). */
  setLoader(loader: (modelName: string, ids: string[]) => Promise<T[]>) {
    this.loader = loader;
  }

  /**
   * Resolve items already in the ObjectPool synchronously.
   * Looks up each ID directly — no index query needed.
   */
  resolveFromPool(pool: {
    getById(name: string, id: string): BaseModel | undefined;
  }): T[] {
    return this.idsGetter()
      .map((id) => pool.getById(this.referencedModelName, id) as T | undefined)
      .filter((m): m is T => m != null);
  }

  protected async runLoad(): Promise<T[]> {
    runInAction(() => {
      this.state = CollectionState.Loading;
      this.error = null;
    });

    try {
      const ids = this.idsGetter();
      const results =
        ids.length > 0 && this.loader != null
          ? await this.loader(this.referencedModelName, ids)
          : [];

      runInAction(() => {
        this.items = results;
        this.state = CollectionState.Loaded;
      });

      this.notifyListeners();
      return results;
    } catch (err) {
      runInAction(() => {
        this.error = err as Error;
        this.state = CollectionState.Error;
      });
      this.notifyListeners();
      this.reportError(err as Error);
      return [];
    }
  }
}
