/**
 * useWatch — the compiler-safe reactive read boundary.
 *
 * The components here are deliberately NOT wrapped in mobx observer():
 * useWatch must deliver field-level reactivity on its own, since React
 * Compiler auto-memoization silently defeats observer()'s render-tracking.
 */

import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { comparer } from "mobx";
import { BaseModel } from "@zerodrift/BaseModel";
import { useWatch } from "../src/react/index";
import { hydrateObservable, TestTask } from "./fixtures";

function makeTask(title = "first"): TestTask {
  BaseModel.storeManager = null;
  const task = new TestTask();
  hydrateObservable(task, { title });
  return task;
}

describe("useWatch", () => {
  it("re-renders with the new value when a selected field changes", () => {
    const task = makeTask();
    const { result } = renderHook(() => useWatch(task, (t) => t.title));

    expect(result.current).toBe("first");

    act(() => {
      task.title = "second";
    });
    expect(result.current).toBe("second");
  });

  it("does not re-render when an unselected field changes", () => {
    const task = makeTask();
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useWatch(task, (t) => t.title);
    });
    const before = renders;

    act(() => {
      task.done = true;
    });
    expect(renders).toBe(before);
    expect(result.current).toBe("first");
  });

  it("keeps snapshot identity for shallow-equal object results", () => {
    const task = makeTask();
    const { result, rerender } = renderHook(() =>
      useWatch(task, (t) => ({ title: t.title, done: t.done })),
    );
    const first = result.current;
    expect(first).toEqual({ title: "first", done: false });

    // A re-render with no field change re-runs nothing — same snapshot.
    rerender();
    expect(result.current).toBe(first);

    // A field change produces a new snapshot identity (the signal downstream
    // compiler memo cells key on).
    act(() => {
      task.title = "second";
    });
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual({ title: "second", done: false });
  });

  it("returns undefined for a null record and hydrates when one arrives", () => {
    const task = makeTask();
    const { result, rerender } = renderHook(
      ({ record }: { record: TestTask | null }) =>
        useWatch(record, (t) => t.title),
      { initialProps: { record: null as TestTask | null } },
    );
    expect(result.current).toBeUndefined();

    rerender({ record: task });
    expect(result.current).toBe("first");
  });

  it("re-subscribes when the record identity swaps", () => {
    const a = makeTask("from-a");
    const b = makeTask("from-b");
    const { result, rerender } = renderHook(
      ({ record }: { record: TestTask }) => useWatch(record, (t) => t.title),
      { initialProps: { record: a } },
    );
    expect(result.current).toBe("from-a");

    rerender({ record: b });
    expect(result.current).toBe("from-b");

    // Old record is no longer tracked…
    act(() => {
      a.title = "a-changed";
    });
    expect(result.current).toBe("from-b");

    // …the new one is.
    act(() => {
      b.title = "b-changed";
    });
    expect(result.current).toBe("b-changed");
  });

  it("stops reacting after unmount", () => {
    const task = makeTask();
    let renders = 0;
    const { unmount } = renderHook(() => {
      renders++;
      return useWatch(task, (t) => t.title);
    });
    unmount();
    const after = renders;

    act(() => {
      task.title = "post-unmount";
    });
    expect(renders).toBe(after);
  });

  it("opts.equals overrides the default shallow compare for nested results", () => {
    const task = makeTask();
    // `done` is tracked (read) but only `title` is projected — and it's
    // nested one level deeper than shallow compare reaches.
    const selectNested = (t: TestTask) => {
      void t.done;
      return { nested: { title: t.title } };
    };

    const shallow = renderHook(() => useWatch(task, selectNested));
    const structural = renderHook(() =>
      useWatch(task, selectNested, { equals: comparer.structural }),
    );
    const shallowFirst = shallow.result.current;
    const structuralFirst = structural.result.current;

    act(() => {
      task.done = true;
    });
    // Default shallow compare: nested object differs by identity → new snapshot.
    expect(shallow.result.current).not.toBe(shallowFirst);
    // Structural compare: contents unchanged → snapshot identity preserved.
    expect(structural.result.current).toBe(structuralFirst);
  });

  it("tracks reads across a list — derived sort re-fires on member field change", () => {
    const a = makeTask("a");
    const b = makeTask("b");
    const c = makeTask("c");
    // projectId doubles as a sortable string field on the fixture.
    a.projectId = "2";
    b.projectId = "1";
    c.projectId = "3";
    const list = [a, b, c];

    const { result } = renderHook(() =>
      useWatch(list, (items) =>
        [...items]
          .sort((x, y) => x.projectId.localeCompare(y.projectId))
          .map((t) => t.title),
      ),
    );
    expect(result.current).toEqual(["b", "a", "c"]);
    const first = result.current;

    // Same order → shallow-equal result → same snapshot identity.
    act(() => {
      a.done = true;
    });
    expect(result.current).toBe(first);

    // A sort-key change on one member re-orders the derived list.
    act(() => {
      a.projectId = "0";
    });
    expect(result.current).toEqual(["a", "b", "c"]);
  });
});
