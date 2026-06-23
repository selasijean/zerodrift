/**
 * Regression tests for useObserveItems — the per-instance observation
 * refcounting that protects rendered list records from eviction.
 *
 * The bug: a single effect that unobserved the whole set on cleanup fought
 * the incremental diff. When `items` changed identity, React's cleanup
 * unobserved every previous id, but the next effect — seeing those ids still
 * in `prevIds` — wouldn't re-observe the ones that remained rendered. They
 * silently lost their refcount and became evictable while still on screen.
 */

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { ObjectPool } from "@zerodrift/ObjectPool";
import type { BaseModel } from "@zerodrift/BaseModel";
import { useObserveItems } from "../src/react/index";

const items = (...ids: string[]): BaseModel[] =>
  ids.map((id) => ({ id }) as unknown as BaseModel);

describe("useObserveItems", () => {
  it("keeps still-rendered records observed when the list grows", () => {
    const pool = new ObjectPool();
    const { rerender, unmount } = renderHook(
      ({ list }) => useObserveItems(pool, "X", list),
      { initialProps: { list: items("a", "b") } },
    );

    expect(pool.isObserved("X", "a")).toBe(true);
    expect(pool.isObserved("X", "b")).toBe(true);

    rerender({ list: items("a", "b", "c") });

    // Regression: a and b must stay observed across the identity change.
    expect(pool.isObserved("X", "a")).toBe(true);
    expect(pool.isObserved("X", "b")).toBe(true);
    expect(pool.isObserved("X", "c")).toBe(true);

    unmount();
    expect(pool.isObserved("X", "a")).toBe(false);
    expect(pool.isObserved("X", "b")).toBe(false);
    expect(pool.isObserved("X", "c")).toBe(false);
  });

  it("unobserves removed records but keeps the survivors", () => {
    const pool = new ObjectPool();
    const { rerender, unmount } = renderHook(
      ({ list }) => useObserveItems(pool, "X", list),
      { initialProps: { list: items("a", "b", "c") } },
    );

    rerender({ list: items("a", "c") }); // drop b

    expect(pool.isObserved("X", "b")).toBe(false);
    expect(pool.isObserved("X", "a")).toBe(true);
    expect(pool.isObserved("X", "c")).toBe(true);

    unmount();
    expect(pool.isObserved("X", "a")).toBe(false);
    expect(pool.isObserved("X", "c")).toBe(false);
  });

  it("does not leak refcounts across repeated grow/shrink churn", () => {
    const pool = new ObjectPool();
    const { rerender, unmount } = renderHook(
      ({ list }) => useObserveItems(pool, "X", list),
      { initialProps: { list: items("a") } },
    );

    rerender({ list: items("a", "b") });
    rerender({ list: items("a") });
    rerender({ list: items("a", "b") });

    // a was never removed → exactly one refcount, not one per render.
    expect(pool.isObserved("X", "a")).toBe(true);
    expect(pool.isObserved("X", "b")).toBe(true);

    unmount();
    // A single unobserve on unmount must drop a to zero (no leaked count).
    expect(pool.isObserved("X", "a")).toBe(false);
    expect(pool.isObserved("X", "b")).toBe(false);
  });
});
