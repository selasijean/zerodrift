import type { EntityKey, InferEntity } from "./infer";
import type { SchemaDef } from "./types";

export type ComputedFn<S extends SchemaDef, K extends EntityKey<S>> = (
  record: InferEntity<S, K>,
) => unknown;

export type ActionFn<S extends SchemaDef, K extends EntityKey<S>> = (
  record: InferEntity<S, K>,
  ...args: never[]
) => unknown;

export interface ExtensionDef<S extends SchemaDef, K extends EntityKey<S>> {
  computed?: Record<string, ComputedFn<S, K>>;
  actions?: Record<string, ActionFn<S, K>>;
}

export type ExtensionMap<S extends SchemaDef> = {
  [K in EntityKey<S>]?: ExtensionDef<S, K>;
};

/**
 * Carries the schema generic and the *literal* `byEntity` shape so that
 * `MergedExtensionMembers` can read each `computed[name]` / `actions[name]`
 * function literal at the type level — that's how computed return types and
 * action signatures end up on the records returned by `store.<entity>`.
 */
export interface ExtensionDescriptor<
  S extends SchemaDef,
  BE extends Record<string, unknown> = ExtensionMap<S>,
> {
  /** @internal */
  readonly _schema?: S;
  readonly byEntity: BE;
}

export function extend<
  S extends SchemaDef,
  K extends EntityKey<S>,
  const Defs extends ExtensionDef<S, K>,
>(
  schema: S,
  entityKey: K,
  defs: Defs,
): ExtensionDescriptor<S, { [P in K]: Defs }>;
export function extend<S extends SchemaDef, const BE extends ExtensionMap<S>>(
  schema: S,
  defs: BE,
): ExtensionDescriptor<S, BE>;
export function extend<S extends SchemaDef>(
  _schema: S,
  arg2: string | ExtensionMap<S>,
  arg3?: ExtensionDef<S, EntityKey<S>>,
): ExtensionDescriptor<S> {
  if (typeof arg2 === "string") {
    return { byEntity: { [arg2]: arg3 } as ExtensionMap<S> };
  }
  return { byEntity: arg2 };
}

// ---------------------------------------------------------------------------
// Type-level merging — used by createStore to include extension members on the
// record types returned from `store.<entity>.findById/create/update`.
// ---------------------------------------------------------------------------

type ComputedReturnsOf<Defs> = Defs extends {
  computed?: infer C;
}
  ? C extends Record<string, (...args: never[]) => unknown>
    ? { readonly [P in keyof C]: ReturnType<C[P]> }
    : Record<never, never>
  : Record<never, never>;

type ActionMethodsOf<Defs> = Defs extends { actions?: infer A }
  ? A extends Record<string, (...args: never[]) => unknown>
    ? {
        [P in keyof A]: A[P] extends (
          record: never,
          ...args: infer Args
        ) => infer R
          ? (...args: Args) => R
          : never;
      }
    : Record<never, never>
  : Record<never, never>;

type MembersFromOne<
  S extends SchemaDef,
  K extends EntityKey<S>,
  Ext,
> = Ext extends ExtensionDescriptor<S, infer BE>
  ? K extends keyof BE
    ? ComputedReturnsOf<BE[K]> & ActionMethodsOf<BE[K]>
    : Record<never, never>
  : Record<never, never>;

/**
 * Distribute `MembersFromOne` over each element of the extensions tuple
 * (via `Exts[number]`) and intersect the resulting union — same shape as a
 * tuple-rest recursive walk but without the recursion depth, so schemas with
 * many extension descriptors stay well below TS's instantiation limits.
 */
type UnionToIntersection<U> = (
  U extends unknown ? (x: U) => void : never
) extends (x: infer I) => void
  ? I
  : never;

export type MergedExtensionMembers<
  S extends SchemaDef,
  K extends EntityKey<S>,
  Exts extends readonly ExtensionDescriptor<S>[],
> = Exts extends readonly []
  ? Record<never, never>
  : UnionToIntersection<MembersFromOne<S, K, Exts[number]>>;
