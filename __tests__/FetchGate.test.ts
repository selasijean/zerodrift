/**
 * FetchGate — the re-enableable fetch-gating signal — plus its React wiring:
 * `usePaused` (gate → "hold fetching" boolean, reactive) and `useVisibilityGate`
 * (an IntersectionObserver-driven gate).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { FetchGate } from "../src/react/FetchGate";
import { usePaused, useVisibilityGate } from "../src/react/index";

describe("FetchGate", () => {
  it("defaults to enabled and reflects set/enable/disable", () => {
    const gate = new FetchGate();
    expect(gate.enabled).toBe(true);

    gate.disable();
    expect(gate.enabled).toBe(false);
    gate.enable();
    expect(gate.enabled).toBe(true);

    expect(new FetchGate(false).enabled).toBe(false);
  });

  it("notifies subscribers only on an actual change", () => {
    const gate = new FetchGate(true);
    const listener = vi.fn();
    const unsubscribe = gate.subscribe(listener);

    gate.set(true); // no-op — already enabled
    expect(listener).not.toHaveBeenCalled();

    gate.set(false);
    gate.set(true);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    gate.set(false);
    expect(listener).toHaveBeenCalledTimes(2); // no longer notified
  });
});

describe("usePaused", () => {
  it("is false with no opts and tracks the static pause flag", () => {
    expect(renderHook(() => usePaused(undefined)).result.current).toBe(false);
    expect(renderHook(() => usePaused({ pause: true })).result.current).toBe(true);
  });

  it("resolves a gate and re-renders when it flips", () => {
    const gate = new FetchGate(true);
    const { result } = renderHook(() => usePaused({ gate }));

    expect(result.current).toBe(false); // enabled → not paused

    act(() => gate.disable());
    expect(result.current).toBe(true); // disabled → paused

    act(() => gate.enable());
    expect(result.current).toBe(false);
  });

  it("pause: true overrides an enabled gate", () => {
    const gate = new FetchGate(true);
    const { result } = renderHook(() => usePaused({ pause: true, gate }));
    expect(result.current).toBe(true);
  });
});

// ── useVisibilityGate (mocked IntersectionObserver) ──────────────────────────

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  observed = new Set<Element>();
  disconnected = false;

  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = cb;
    this.options = options;
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.add(el);
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }
  emit(isIntersecting: boolean): void {
    this.callback(
      [...this.observed].map((target) => ({ isIntersecting, target }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}

describe("useVisibilityGate", () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
      MockIntersectionObserver;
  });

  afterEach(() => {
    delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  });

  it("starts disabled, enables when the element intersects, disables when it leaves", () => {
    const { result } = renderHook(() => useVisibilityGate());
    expect(result.current.gate.enabled).toBe(false); // off-screen until proven visible

    const el = document.createElement("div");
    act(() => result.current.ref(el));
    const observer = MockIntersectionObserver.instances.at(-1)!;
    expect(observer.observed.has(el)).toBe(true);

    act(() => observer.emit(true));
    expect(result.current.gate.enabled).toBe(true);

    act(() => observer.emit(false));
    expect(result.current.gate.enabled).toBe(false);
  });

  it("honors initiallyVisible and forwards observer options", () => {
    const { result } = renderHook(() =>
      useVisibilityGate({ initiallyVisible: true, rootMargin: "200px" }),
    );
    expect(result.current.gate.enabled).toBe(true);

    act(() => result.current.ref(document.createElement("div")));
    expect(MockIntersectionObserver.instances.at(-1)!.options?.rootMargin).toBe("200px");
  });

  it("disconnects the observer on unmount", () => {
    const { result, unmount } = renderHook(() => useVisibilityGate());
    act(() => result.current.ref(document.createElement("div")));
    const observer = MockIntersectionObserver.instances.at(-1)!;

    unmount();
    expect(observer.disconnected).toBe(true);
  });
});
